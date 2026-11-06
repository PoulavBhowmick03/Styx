// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title StyxPolicyVault
/// @notice A funded vault that lets one agent pay allowlisted recipients within the owner's policy,
///         and lets the owner approve single exceptions to the per-payment limit with an EIP-712
///         signature over the exact payment.
/// @dev Specified by section 4 of the Styx Mumbai build plan. Not upgradeable. Holds one ERC-20
///      (`token`) and uses only its ERC-20 interface. On Arc the token is USDC at
///      0x3600000000000000000000000000000000000000, which is also the native gas token; the vault
///      has no `receive` or `fallback` and never touches native balance.
///
///      Trust model and deliberate omissions:
///      - `owner` is immutable and has no transfer or renounce path. It is meant to be a plain
///        account (EOA): signatures are verified with `ecrecover` only (no ERC-1271).
///      - `approvalNonce` is a vault-global namespace chosen by the owner, not bound to an agent
///        or payment. The payment hash inside the signed authorization binds the exact payment.
///      - `setRecipient` bumps `policyVersion` on every call, even when the flag is unchanged.
///        `pause`, `unpause` and `withdraw` never change it.
///      - No policy or allowlist change ever resets `spentByDay`.
///      - `configurePolicy` does not require `perPaymentLimit <= dailyLimit`, and accepts a
///        `validUntil` in the past (which disables payments until reconfigured).
///      - An exception lifts only the per-payment limit. The daily limit always applies.
///      - The token is trusted to behave as a plain ERC-20. A transfer that does not increase the
///        recipient's balance by exactly the amount (fee-on-transfer, rebasing, silent failure)
///        reverts with `TransferFailed`. A nonzero transfer to the vault itself therefore reverts too
///        (a zero-amount withdrawal to the vault is a harmless no-op).
contract StyxPolicyVault {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice A payment the agent asks the vault to make.
    struct Payment {
        bytes32 paymentId;
        address agent;
        address token;
        address recipient;
        uint256 amount;
        bytes32 evidenceCommitment;
        uint256 policyVersion;
        uint64 validUntil;
    }

    /// @notice The owner's typed authorization for one exact payment.
    struct ExceptionAuthorization {
        bytes32 paymentHash;
        uint256 approvalNonce;
        uint64 authorizationExpiry;
    }

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner();
    error NotAgent();
    error VaultPaused();
    error PolicyExpired();
    error AgentMismatch();
    error TokenMismatch();
    error PolicyVersionMismatch();
    error PaymentExpired();
    error ZeroAmount();
    error RecipientNotAllowed();
    error PaymentAlreadyUsed();
    error DailyLimitExceeded();
    error PerPaymentLimitExceeded();
    error PaymentHashMismatch();
    error BadSignature();
    error ApprovalNonceUsed();
    error AuthorizationExpired();
    error TransferFailed();
    error ZeroAddress();
    error Reentrancy();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice Emitted after a payment passed every check and the transfer settled. Records the
    ///         policy that was enforced, so a reviewer needs no historical state queries.
    /// @param approvalDigest The EIP-712 digest the owner signed, or zero for ordinary payments.
    event PaymentExecuted(
        bytes32 indexed paymentId,
        address indexed recipient,
        uint256 amount,
        bytes32 paymentHash,
        bytes32 evidenceCommitment,
        uint256 policyVersion,
        uint256 perPaymentLimit,
        uint256 dailyLimit,
        uint256 day,
        uint256 daySpentAfter,
        bool exception,
        bytes32 approvalDigest
    );
    event PolicyConfigured(
        uint256 indexed policyVersion, address agent, uint256 perPaymentLimit, uint256 dailyLimit, uint64 validUntil
    );
    event RecipientSet(uint256 indexed policyVersion, address indexed recipient, bool allowed);
    event Paused();
    event Unpaused();
    event OwnerWithdrawal(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("ErebusPolicyVault");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant PAYMENT_TYPEHASH = keccak256(
        "Payment(bytes32 paymentId,address agent,address token,address recipient,uint256 amount,bytes32 evidenceCommitment,uint256 policyVersion,uint64 validUntil)"
    );
    bytes32 private constant AUTHORIZATION_TYPEHASH =
        keccak256("ExceptionAuthorization(bytes32 paymentHash,uint256 approvalNonce,uint64 authorizationExpiry)");

    /// @dev secp256k1n / 2. Signatures with a larger `s` are malleable twins and are rejected.
    uint256 private constant HALF_CURVE_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice The account that sets policy, signs exceptions, pauses and withdraws.
    address public immutable owner;
    /// @notice The ERC-20 this vault holds and pays out.
    address public immutable token;

    /// @notice The only account allowed to call `pay` and `payWithException`.
    address public agent;
    /// @notice Incremented by every policy, agent or allowlist change.
    uint256 public policyVersion;
    uint256 public perPaymentLimit;
    uint256 public dailyLimit;
    /// @notice The last timestamp (inclusive) at which the policy accepts payments.
    uint64 public policyValidUntil;
    bool public paused;

    mapping(address => bool) public allowedRecipient;
    /// @notice Token amount spent per UTC day (`block.timestamp / 1 days`).
    mapping(uint256 => uint256) public spentByDay;
    mapping(bytes32 => bool) public consumedPayment;
    mapping(uint256 => bool) public consumedApprovalNonce;
    mapping(bytes32 => bytes32) public paymentHashById;

    uint256 private _lock = NOT_ENTERED;

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock == ENTERED) revert Reentrancy();
        _lock = ENTERED;
        _;
        _lock = NOT_ENTERED;
    }

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    /// @param vaultOwner The immutable owner.
    /// @param vaultToken The ERC-20 the vault holds (USDC on Arc).
    constructor(address vaultOwner, address vaultToken) {
        if (vaultOwner == address(0) || vaultToken == address(0)) revert ZeroAddress();
        owner = vaultOwner;
        token = vaultToken;
    }

    // ---------------------------------------------------------------------
    // Owner functions
    // ---------------------------------------------------------------------

    /// @notice Sets the agent and limits and increments `policyVersion`. Never resets `spentByDay`.
    function configurePolicy(address newAgent, uint256 newPerPaymentLimit, uint256 newDailyLimit, uint64 validUntil)
        external
        onlyOwner
    {
        if (newAgent == address(0)) revert ZeroAddress();
        agent = newAgent;
        perPaymentLimit = newPerPaymentLimit;
        dailyLimit = newDailyLimit;
        policyValidUntil = validUntil;
        uint256 version = ++policyVersion;
        emit PolicyConfigured(version, newAgent, newPerPaymentLimit, newDailyLimit, validUntil);
    }

    /// @notice Allows or disallows a recipient and increments `policyVersion`.
    function setRecipient(address recipient, bool allowed) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        allowedRecipient[recipient] = allowed;
        uint256 version = ++policyVersion;
        emit RecipientSet(version, recipient, allowed);
    }

    /// @notice Blocks `pay` and `payWithException`. Does not change `policyVersion`.
    function pause() external onlyOwner {
        if (!paused) {
            paused = true;
            emit Paused();
        }
    }

    /// @notice Re-enables payments. Does not change `policyVersion`.
    function unpause() external onlyOwner {
        if (paused) {
            paused = false;
            emit Unpaused();
        }
    }

    /// @notice Sends `amount` of the vault's token to `to`. Does not change `policyVersion`.
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        emit OwnerWithdrawal(to, amount);
        _safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------------
    // Agent functions
    // ---------------------------------------------------------------------

    /// @notice Ordinary payment: subject to both the per-payment and the daily limit.
    function pay(Payment calldata p) external nonReentrant {
        (uint256 day, uint256 spent) = _checkShared(p);
        if (p.amount > perPaymentLimit) revert PerPaymentLimitExceeded();
        _execute(p, hashPayment(p), day, spent, false, bytes32(0));
    }

    /// @notice Exception payment: lifts the per-payment limit only, with the owner's signature over
    ///         `a` (which commits to this exact payment). The daily limit still applies.
    /// @param ownerSignature 65-byte `r || s || v`; `v` may be 0, 1, 27 or 28.
    function payWithException(Payment calldata p, ExceptionAuthorization calldata a, bytes calldata ownerSignature)
        external
        nonReentrant
    {
        (uint256 day, uint256 spent) = _checkShared(p);

        bytes32 paymentHash = hashPayment(p);
        if (a.paymentHash != paymentHash) revert PaymentHashMismatch();

        bytes32 digest = exceptionDigest(a);
        if (!_isOwnerSignature(digest, ownerSignature)) revert BadSignature();
        if (consumedApprovalNonce[a.approvalNonce]) revert ApprovalNonceUsed();
        if (block.timestamp > a.authorizationExpiry) revert AuthorizationExpired();

        consumedApprovalNonce[a.approvalNonce] = true;
        _execute(p, paymentHash, day, spent, true, digest);
    }

    // ---------------------------------------------------------------------
    // EIP-712 views
    // ---------------------------------------------------------------------

    /// @notice The EIP-712 domain separator, computed at call time from the current chain id.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice The EIP-712 struct hash of `p`; this is the `paymentHash` an authorization commits to.
    function hashPayment(Payment calldata p) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PAYMENT_TYPEHASH,
                p.paymentId,
                p.agent,
                p.token,
                p.recipient,
                p.amount,
                p.evidenceCommitment,
                p.policyVersion,
                p.validUntil
            )
        );
    }

    /// @notice The EIP-712 digest the owner signs to authorize `a`.
    function exceptionDigest(ExceptionAuthorization calldata a) public view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(AUTHORIZATION_TYPEHASH, a.paymentHash, a.approvalNonce, a.authorizationExpiry));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /// @dev Checks 1 to 4 of the spec, in order. Returns the UTC day and the amount already spent on it.
    function _checkShared(Payment calldata p) private view returns (uint256 day, uint256 spent) {
        if (msg.sender != agent) revert NotAgent();
        if (paused) revert VaultPaused();
        if (block.timestamp > policyValidUntil) revert PolicyExpired();

        if (p.agent != agent) revert AgentMismatch();
        if (p.token != token) revert TokenMismatch();
        if (p.policyVersion != policyVersion) revert PolicyVersionMismatch();
        if (block.timestamp > p.validUntil) revert PaymentExpired();
        if (p.amount == 0) revert ZeroAmount();
        if (p.recipient == address(0)) revert ZeroAddress();
        if (!allowedRecipient[p.recipient]) revert RecipientNotAllowed();

        if (consumedPayment[p.paymentId]) revert PaymentAlreadyUsed();

        day = block.timestamp / 1 days;
        spent = spentByDay[day];
        uint256 limit = dailyLimit;
        // `spent` can exceed `limit` if the owner lowered the limit after spending.
        if (spent > limit || p.amount > limit - spent) revert DailyLimitExceeded();
    }

    /// @dev Effects first, then the event, then the transfer. The caller holds the reentrancy guard.
    function _execute(
        Payment calldata p,
        bytes32 paymentHash,
        uint256 day,
        uint256 spent,
        bool exception,
        bytes32 approvalDigest
    ) private {
        // Cannot overflow: `_checkShared` ensured `p.amount <= dailyLimit - spent`.
        uint256 spentAfter = spent + p.amount;
        consumedPayment[p.paymentId] = true;
        paymentHashById[p.paymentId] = paymentHash;
        spentByDay[day] = spentAfter;

        // Logged before the external call. A failed transfer reverts the log with the state, so a
        // receipt carries `PaymentExecuted` only for a payment that settled.
        _emitExecuted(p, paymentHash, day, spentAfter, exception, approvalDigest);

        _safeTransfer(p.recipient, p.amount);
    }

    function _emitExecuted(
        Payment calldata p,
        bytes32 paymentHash,
        uint256 day,
        uint256 spentAfter,
        bool exception,
        bytes32 approvalDigest
    ) private {
        emit PaymentExecuted(
            p.paymentId,
            p.recipient,
            p.amount,
            paymentHash,
            p.evidenceCommitment,
            policyVersion,
            perPaymentLimit,
            dailyLimit,
            day,
            spentAfter,
            exception,
            approvalDigest
        );
    }

    /// @dev True only for a canonical 65-byte `r || s || v` signature by `owner` over `digest`.
    function _isOwnerSignature(bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (signature.length != 65) return false;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (v < 2) {
            v += 27;
        } else if (v != 27 && v != 28) {
            return false;
        }
        if (r == bytes32(0) || s == bytes32(0) || uint256(s) > HALF_CURVE_ORDER) return false;
        address signer = ecrecover(digest, v, r, s);
        return signer != address(0) && signer == owner;
    }

    /// @dev Transfers `amount` to `to` and requires the recipient's balance to rise by exactly
    ///      `amount`. Accepts an empty return or a returned `true`. Return data is capped at 32 bytes.
    function _safeTransfer(address to, uint256 amount) private {
        (bool okBefore, uint256 balanceBefore) = _balanceOf(to);
        if (!okBefore) revert TransferFailed();

        address asset = token;
        bool ok;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), and(to, 0xffffffffffffffffffffffffffffffffffffffff))
            mstore(add(ptr, 0x24), amount)
            if call(gas(), asset, 0, ptr, 0x44, ptr, 0x20) {
                switch returndatasize()
                case 0 { ok := 1 }
                case 0x20 { ok := eq(mload(ptr), 1) }
            }
        }
        if (!ok) revert TransferFailed();

        (bool okAfter, uint256 balanceAfter) = _balanceOf(to);
        if (!okAfter || balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) {
            revert TransferFailed();
        }
    }

    /// @dev `token.balanceOf(account)` with return data capped at 32 bytes; `ok` is false on revert or short return.
    function _balanceOf(address account) private view returns (bool ok, uint256 amount) {
        address asset = token;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, 0x70a0823100000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), and(account, 0xffffffffffffffffffffffffffffffffffffffff))
            ok := staticcall(gas(), asset, ptr, 0x24, ptr, 0x20)
            ok := and(ok, gt(returndatasize(), 0x1f))
            if ok { amount := mload(ptr) }
        }
    }
}
