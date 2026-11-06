// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title ErebusPolicyVault
/// @notice Holds one owner's USDC and pays an agent's invoices within the owner's rules.
/// @dev Not upgradeable. An exception needs the owner's signature over the exact payment and lifts
///      only the per-payment limit. The owner is a plain account (EOA) for this version.
contract ErebusPolicyVault {
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

    struct ExceptionAuthorization {
        bytes32 paymentHash;
        uint256 approvalNonce;
        uint64 authorizationExpiry;
    }

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

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("ErebusPolicyVault");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant PAYMENT_TYPEHASH = keccak256(
        "Payment(bytes32 paymentId,address agent,address token,address recipient,uint256 amount,bytes32 evidenceCommitment,uint256 policyVersion,uint64 validUntil)"
    );
    bytes32 private constant AUTHORIZATION_TYPEHASH =
        keccak256("ExceptionAuthorization(bytes32 paymentHash,uint256 approvalNonce,uint64 authorizationExpiry)");
    /// secp256k1 order / 2. Signatures above it are the malleable twin of a valid signature.
    uint256 private constant LOW_S_MAX = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    uint256 private constant SECONDS_PER_DAY = 86_400;

    address public immutable owner;
    address public immutable token;

    address public agent;
    uint256 public policyVersion;
    uint256 public perPaymentLimit;
    uint256 public dailyLimit;
    uint64 public policyValidUntil;
    bool public paused;

    mapping(address => bool) public allowedRecipient;
    mapping(uint256 => uint256) public spentByDay;
    mapping(bytes32 => bool) public consumedPayment;
    mapping(uint256 => bool) public consumedApprovalNonce;
    mapping(bytes32 => bytes32) public paymentHashById;

    bool private entered;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    constructor(address vaultOwner, address vaultToken) {
        if (vaultOwner == address(0) || vaultToken == address(0)) revert ZeroAddress();
        owner = vaultOwner;
        token = vaultToken;
    }

    /// Sets the agent and limits. Never resets `spentByDay`.
    function configurePolicy(address newAgent, uint256 newPerPaymentLimit, uint256 newDailyLimit, uint64 validUntil)
        external
        onlyOwner
    {
        if (newAgent == address(0)) revert ZeroAddress();
        agent = newAgent;
        perPaymentLimit = newPerPaymentLimit;
        dailyLimit = newDailyLimit;
        policyValidUntil = validUntil;
        policyVersion += 1;
        emit PolicyConfigured(policyVersion, newAgent, newPerPaymentLimit, newDailyLimit, validUntil);
    }

    function setRecipient(address recipient, bool allowed) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        allowedRecipient[recipient] = allowed;
        policyVersion += 1;
        emit RecipientSet(policyVersion, recipient, allowed);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        emit OwnerWithdrawal(to, amount);
        exactTransfer(to, amount);
    }

    /// Pays within the per-payment limit.
    function pay(Payment calldata p) external nonReentrant {
        bytes32 paymentHash = checkPayment(p);
        if (p.amount > perPaymentLimit) revert PerPaymentLimitExceeded();
        execute(p, paymentHash, false, bytes32(0));
    }

    /// Pays above the per-payment limit with the owner's signature over this exact payment.
    function payWithException(Payment calldata p, ExceptionAuthorization calldata a, bytes calldata ownerSignature)
        external
        nonReentrant
    {
        bytes32 paymentHash = checkPayment(p);
        if (a.paymentHash != paymentHash) revert PaymentHashMismatch();
        bytes32 digest = exceptionDigest(a);
        verifyOwnerSignature(digest, ownerSignature);
        if (consumedApprovalNonce[a.approvalNonce]) revert ApprovalNonceUsed();
        if (block.timestamp > a.authorizationExpiry) revert AuthorizationExpired();
        consumedApprovalNonce[a.approvalNonce] = true;
        execute(p, paymentHash, true, digest);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// The EIP-712 struct hash of a payment.
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

    /// The full EIP-712 digest the owner signs.
    function exceptionDigest(ExceptionAuthorization calldata a) public view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(AUTHORIZATION_TYPEHASH, a.paymentHash, a.approvalNonce, a.authorizationExpiry));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    /// Checks shared by both paths, in the documented order, up to the path-specific limit check.
    function checkPayment(Payment calldata p) private view returns (bytes32) {
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

        if (spentByDay[block.timestamp / SECONDS_PER_DAY] + p.amount > dailyLimit) revert DailyLimitExceeded();
        return hashPayment(p);
    }

    /// Effects, then the transfer. The event is emitted only on a path whose checks all passed.
    function execute(Payment calldata p, bytes32 paymentHash, bool exception, bytes32 approvalDigest) private {
        uint256 day = block.timestamp / SECONDS_PER_DAY;
        consumedPayment[p.paymentId] = true;
        paymentHashById[p.paymentId] = paymentHash;
        spentByDay[day] += p.amount;

        emit PaymentExecuted(
            p.paymentId,
            p.recipient,
            p.amount,
            paymentHash,
            p.evidenceCommitment,
            p.policyVersion,
            perPaymentLimit,
            dailyLimit,
            day,
            spentByDay[day],
            exception,
            approvalDigest
        );
        exactTransfer(p.recipient, p.amount);
    }

    /// Verifies a 65-byte `r || s || v` owner signature.
    /// @dev Accepts `v` as a raw recovery id (0 or 1) or in wallet format (27 or 28), since
    ///      `eth_signTypedData_v4` returns the latter. Rejects high-s, zero r or s, and a zero signer.
    function verifyOwnerSignature(bytes32 digest, bytes calldata signature) private view {
        if (signature.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v >= 27) v -= 27;
        if (v > 1) revert BadSignature();
        if (uint256(s) == 0 || uint256(s) > LOW_S_MAX || uint256(r) == 0) revert BadSignature();
        address recovered = ecrecover(digest, v + 27, r, s);
        if (recovered == address(0) || recovered != owner) revert BadSignature();
    }

    /// Transfers and requires the recipient's balance to rise by exactly `value`, accepting the two
    /// standard ERC-20 return conventions (empty or `true`).
    function exactTransfer(address to, uint256 value) private {
        uint256 balanceBefore = IERC20Minimal(token).balanceOf(to);
        (bool ok, bytes memory returndata) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, value));
        if (!ok) revert TransferFailed();
        if (returndata.length != 0 && (returndata.length < 32 || !abi.decode(returndata, (bool)))) {
            revert TransferFailed();
        }
        if (IERC20Minimal(token).balanceOf(to) - balanceBefore != value) revert TransferFailed();
    }
}

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);

    function transfer(address to, uint256 value) external returns (bool);
}
