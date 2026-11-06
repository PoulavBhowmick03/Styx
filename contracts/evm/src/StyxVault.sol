// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @notice Organization treasury with independently revocable agent and approver policies.
/// @dev Exceptions lift only the per-payment cap. Both daily caps always apply.
///      Immutable owner and ERC-20 token. No native receive, upgrade, or arbitrary call.
contract StyxVault {
    struct Payment {
        bytes32 paymentId;
        address agent;
        address token;
        address recipient;
        uint256 amount;
        bytes32 evidenceCommitment;
        uint256 policyVersion;
        uint256 recipientVersion;
        uint64 validUntil;
    }

    struct ExceptionAuthorization {
        bytes32 paymentHash;
        address signer;
        uint256 signerVersion;
        uint256 approvalNonce;
        uint64 authorizationExpiry;
    }

    struct AgentPolicy {
        uint256 version;
        uint256 perPaymentLimit;
        uint256 dailyLimit;
        uint64 validUntil;
        bool enabled;
    }

    struct ApproverState {
        uint256 version;
        bool enabled;
    }

    // Exactly the static, non-indexed ABI fields of PaymentExecuted, in declaration order.
    struct ExecutedData {
        uint256 amount;
        bytes32 paymentHash;
        bytes32 evidenceCommitment;
        uint256 policyVersion;
        uint256 recipientVersion;
        uint256 perPaymentLimit;
        uint256 dailyLimit;
        uint256 vaultDailyLimit;
        uint256 day;
        uint256 agentDaySpentAfter;
        uint256 vaultDaySpentAfter;
        bool exception;
        address signer;
        uint256 signerVersion;
        bytes32 approvalDigest;
    }
    error NotOwner();
    error NotAgent();
    error VaultPaused();
    error PolicyExpired();
    error AgentMismatch();
    error TokenMismatch();
    error PolicyVersionMismatch();
    error RecipientVersionMismatch();
    error PaymentExpired();
    error ZeroAmount();
    error RecipientNotAllowed();
    error PaymentAlreadyUsed();
    error DailyLimitExceeded();
    error VaultDailyLimitExceeded();
    error PerPaymentLimitExceeded();
    error PaymentHashMismatch();
    error ApproverNotAllowed();
    error SignerVersionMismatch();
    error BadSignature();
    error ApprovalNonceUsed();
    error AuthorizationExpired();
    error TransferFailed();
    error ZeroAddress();
    error InvalidRecipient();
    error RoleConflict();
    error Reentrancy();

    event AgentConfigured(
        address indexed agent,
        uint256 indexed version,
        uint256 perPaymentLimit,
        uint256 dailyLimit,
        uint64 validUntil,
        bool enabled
    );
    event ApproverSet(address indexed approver, uint256 indexed version, bool enabled);
    event RecipientSet(address indexed recipient, uint256 indexed version, bool allowed);
    event VaultDailyLimitSet(uint256 limit);
    event Paused();
    event Unpaused();
    event OwnerWithdrawal(address indexed to, uint256 amount);
    event PaymentExecuted(
        bytes32 indexed paymentId,
        address indexed agent,
        address indexed recipient,
        uint256 amount,
        bytes32 paymentHash,
        bytes32 evidenceCommitment,
        uint256 policyVersion,
        uint256 recipientVersion,
        uint256 perPaymentLimit,
        uint256 dailyLimit,
        uint256 vaultDailyLimit,
        uint256 day,
        uint256 agentDaySpentAfter,
        uint256 vaultDaySpentAfter,
        bool exception,
        address signer,
        uint256 signerVersion,
        bytes32 approvalDigest
    );

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("StyxVault");
    bytes32 private constant VERSION_HASH = keccak256("2");
    bytes32 private constant PAYMENT_TYPEHASH = keccak256(
        "Payment(bytes32 paymentId,address agent,address token,address recipient,uint256 amount,bytes32 evidenceCommitment,uint256 policyVersion,uint256 recipientVersion,uint64 validUntil)"
    );
    bytes32 private constant AUTHORIZATION_TYPEHASH = keccak256(
        "ExceptionAuthorization(bytes32 paymentHash,address signer,uint256 signerVersion,uint256 approvalNonce,uint64 authorizationExpiry)"
    );
    bytes32 private constant EXECUTED_TOPIC = keccak256(
        "PaymentExecuted(bytes32,address,address,uint256,bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,address,uint256,bytes32)"
    );
    uint256 private constant HALF_CURVE_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    address public immutable owner;
    address public immutable token;
    bool public paused;
    uint256 public vaultDailyLimit;
    mapping(address => AgentPolicy) public agentPolicy;
    mapping(address => ApproverState) private _approvers;
    mapping(address => bool) public allowedRecipient;
    mapping(address => uint256) public recipientVersion;
    mapping(address => mapping(uint256 => uint256)) public spentByAgentDay;
    mapping(uint256 => uint256) public spentByDay;
    mapping(bytes32 => bool) public consumedPayment;
    mapping(bytes32 => bytes32) public paymentHashById;
    mapping(address => mapping(uint256 => bool)) public consumedApprovalNonce;
    uint256 private _lock = 1;
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }
    modifier nonReentrant() {
        if (_lock == 2) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address vaultOwner, address vaultToken) {
        if (vaultOwner == address(0) || vaultToken == address(0)) revert ZeroAddress();
        owner = vaultOwner;
        token = vaultToken;
    }

    function contractVersion() external pure returns (uint256) {
        return 2;
    }

    function approverState(address signer) public view returns (uint256 version, bool enabled) {
        if (signer == owner) return (0, true);
        ApproverState storage state = _approvers[signer];
        return (state.version, state.enabled);
    }

    /// @notice Every call advances only this agent's version. Spend counters never reset.
    function configureAgent(address agent, uint256 perPaymentLimit, uint256 dailyLimit, uint64 validUntil, bool enabled)
        external
        onlyOwner
    {
        if (agent == address(0)) revert ZeroAddress();
        if (agent == owner || (enabled && _approvers[agent].enabled)) revert RoleConflict();
        AgentPolicy storage policy = agentPolicy[agent];
        uint256 version = ++policy.version;
        policy.perPaymentLimit = perPaymentLimit;
        policy.dailyLimit = dailyLimit;
        policy.validUntil = validUntil;
        policy.enabled = enabled;
        emit AgentConfigured(agent, version, perPaymentLimit, dailyLimit, validUntil, enabled);
    }

    function setApprover(address approver, bool enabled) external onlyOwner {
        if (approver == address(0)) revert ZeroAddress();
        if (approver == owner || (enabled && agentPolicy[approver].enabled)) revert RoleConflict();
        ApproverState storage state = _approvers[approver];
        uint256 version = ++state.version;
        state.enabled = enabled;
        emit ApproverSet(approver, version, enabled);
    }

    function setRecipient(address recipient, bool allowed) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        if (recipient == address(this)) revert InvalidRecipient();
        allowedRecipient[recipient] = allowed;
        emit RecipientSet(recipient, ++recipientVersion[recipient], allowed);
    }

    function setVaultDailyLimit(uint256 limit) external onlyOwner {
        vaultDailyLimit = limit;
        emit VaultDailyLimitSet(limit);
    }

    function pause() external onlyOwner {
        if (!paused) paused = true;
        emit Paused();
    }

    function unpause() external onlyOwner {
        if (paused) paused = false;
        emit Unpaused();
    }

    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (to == address(this)) revert InvalidRecipient();
        emit OwnerWithdrawal(to, amount);
        _safeTransfer(to, amount);
    }

    function pay(Payment calldata p) external nonReentrant {
        uint256 day = _checkShared(p);
        if (p.amount > agentPolicy[p.agent].perPaymentLimit) revert PerPaymentLimitExceeded();
        _execute(p, day, address(0), 0, bytes32(0));
    }

    function payWithException(Payment calldata p, ExceptionAuthorization calldata a, bytes calldata signature)
        external
        nonReentrant
    {
        uint256 day = _checkShared(p);
        if (a.paymentHash != hashPayment(p)) revert PaymentHashMismatch();
        (uint256 version, bool enabled) = approverState(a.signer);
        if (!enabled) revert ApproverNotAllowed();
        if (a.signerVersion != version) revert SignerVersionMismatch();
        if (consumedApprovalNonce[a.signer][a.approvalNonce]) revert ApprovalNonceUsed();
        if (block.timestamp > a.authorizationExpiry) revert AuthorizationExpired();
        bytes32 digest = exceptionDigest(a);
        if (!_isSignature(a.signer, digest, signature)) revert BadSignature();
        consumedApprovalNonce[a.signer][a.approvalNonce] = true;
        _execute(p, day, a.signer, a.signerVersion, digest);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function hashPayment(Payment calldata p) public pure returns (bytes32) {
        // A static struct has exactly the same ABI words as its individual fields.
        return keccak256(abi.encode(PAYMENT_TYPEHASH, p));
    }

    function exceptionDigest(ExceptionAuthorization calldata a) public view returns (bytes32) {
        return
            keccak256(abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(AUTHORIZATION_TYPEHASH, a))));
    }

    function _checkShared(Payment calldata p) private view returns (uint256 day) {
        AgentPolicy storage policy = agentPolicy[msg.sender];
        if (!policy.enabled) revert NotAgent();
        if (paused) revert VaultPaused();
        if (block.timestamp > policy.validUntil) revert PolicyExpired();
        if (p.agent != msg.sender) revert AgentMismatch();
        if (p.token != token) revert TokenMismatch();
        if (p.policyVersion != policy.version) revert PolicyVersionMismatch();
        if (block.timestamp > p.validUntil) revert PaymentExpired();
        if (p.amount == 0) revert ZeroAmount();
        if (p.recipient == address(0)) revert ZeroAddress();
        if (!allowedRecipient[p.recipient]) revert RecipientNotAllowed();
        if (p.recipientVersion != recipientVersion[p.recipient]) revert RecipientVersionMismatch();
        if (consumedPayment[p.paymentId]) revert PaymentAlreadyUsed();
        day = block.timestamp / 1 days;
        uint256 spent = spentByAgentDay[p.agent][day];
        if (spent > policy.dailyLimit || p.amount > policy.dailyLimit - spent) revert DailyLimitExceeded();
        spent = spentByDay[day];
        uint256 limit = vaultDailyLimit;
        if (spent > limit || p.amount > limit - spent) revert VaultDailyLimitExceeded();
    }

    function _execute(Payment calldata p, uint256 day, address signer, uint256 signerVersion, bytes32 digest) private {
        AgentPolicy storage policy = agentPolicy[p.agent];
        ExecutedData memory data;
        data.amount = p.amount;
        data.paymentHash = hashPayment(p);
        data.evidenceCommitment = p.evidenceCommitment;
        data.policyVersion = p.policyVersion;
        data.recipientVersion = p.recipientVersion;
        data.perPaymentLimit = policy.perPaymentLimit;
        data.dailyLimit = policy.dailyLimit;
        data.vaultDailyLimit = vaultDailyLimit;
        data.day = day;
        data.agentDaySpentAfter = spentByAgentDay[p.agent][day] + p.amount;
        data.vaultDaySpentAfter = spentByDay[day] + p.amount;
        data.exception = signer != address(0);
        data.signer = signer;
        data.signerVersion = signerVersion;
        data.approvalDigest = digest;
        consumedPayment[p.paymentId] = true;
        paymentHashById[p.paymentId] = data.paymentHash;
        spentByAgentDay[p.agent][day] = data.agentDaySpentAfter;
        spentByDay[day] = data.vaultDaySpentAfter;
        _emitExecuted(p, data);
        _safeTransfer(p.recipient, p.amount);
    }

    function _emitExecuted(Payment calldata p, ExecutedData memory data) private {
        bytes memory encoded = abi.encode(data);
        bytes32 topic = EXECUTED_TOPIC;
        bytes32 id = p.paymentId;
        address agent = p.agent;
        address recipient = p.recipient;
        assembly ("memory-safe") { log4(add(encoded, 32), mload(encoded), topic, id, agent, recipient) }
    }

    function _isSignature(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (signer.code.length != 0) {
            bytes memory input = abi.encodeWithSelector(bytes4(0x1626ba7e), digest, signature);
            bool ok;
            uint256 size;
            bytes32 result;
            // Never allocate/copy an untrusted validator's full return buffer.
            assembly ("memory-safe") {
                let ptr := mload(0x40)
                ok := staticcall(gas(), signer, add(input, 32), mload(input), ptr, 32)
                size := returndatasize()
                result := mload(ptr)
            }
            return ok && size >= 32 && result == bytes32(bytes4(0x1626ba7e));
        }
        if (signature.length != 65) return false;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (v < 2) v += 27;
        else if (v != 27 && v != 28) return false;
        if (r == bytes32(0) || s == bytes32(0) || uint256(s) > HALF_CURVE_ORDER) return false;
        return signer != address(0) && ecrecover(digest, v, r, s) == signer;
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
