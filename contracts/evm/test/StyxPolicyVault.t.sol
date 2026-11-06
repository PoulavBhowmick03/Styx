// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {StyxPolicyVault as Vault} from "../src/StyxPolicyVault.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MockFailingERC20} from "../src/MockFailingERC20.sol";
import {MockReentrantERC20} from "../src/MockReentrantERC20.sol";
import {TestBase} from "./TestBase.sol";
import {Vm} from "./Vm.sol";

contract StyxPolicyVaultTest is TestBase {
    /// The non-indexed `PaymentExecuted` fields, in order.
    struct ExecutedData {
        uint256 amount;
        bytes32 paymentHash;
        bytes32 commitment;
        uint256 version;
        uint256 perPayment;
        uint256 daily;
        uint256 day;
        uint256 daySpent;
        bool exception;
        bytes32 digest;
    }

    uint256 internal constant ONE_USDC = 1_000_000;
    uint256 internal constant PER_PAYMENT = ONE_USDC;
    uint256 internal constant DAILY = 10 * ONE_USDC;
    uint256 internal constant START = 1_800_000_000;
    string internal constant VECTOR = "../../sdk/core/tests/fixtures/vault-eip712-vector.json";

    uint256 internal ownerKey = uint256(keccak256("vault-test-owner"));
    uint256 internal agentKey = uint256(keccak256("vault-test-agent"));
    uint256 internal strangerKey = uint256(keccak256("vault-test-stranger"));

    address internal owner;
    address internal agent;
    address internal stranger;
    address internal vendorA = address(0xA1);
    address internal vendorB = address(0xB2);

    MockERC20 internal token;
    Vault internal vault;
    uint256 internal nextId;

    function setUp() public {
        vm.warp(START);
        owner = vm.addr(ownerKey);
        agent = vm.addr(agentKey);
        stranger = vm.addr(strangerKey);
        token = new MockERC20("USD Coin", "USDC");
        vault = deployVault(address(token));
        token.mint(address(vault), 100 * ONE_USDC);
    }

    function deployVault(address asset) internal returns (Vault deployed) {
        deployed = new Vault(owner, asset);
        vm.prank(owner);
        deployed.configurePolicy(agent, PER_PAYMENT, DAILY, uint64(START + 30 days));
        vm.prank(owner);
        deployed.setRecipient(vendorA, true);
        vm.prank(owner);
        deployed.setRecipient(vendorB, true);
    }

    function payment(address recipient, uint256 amount) internal returns (Vault.Payment memory) {
        nextId += 1;
        return Vault.Payment({
            paymentId: keccak256(abi.encode("payment", nextId)),
            agent: agent,
            token: address(token),
            recipient: recipient,
            amount: amount,
            evidenceCommitment: keccak256("invoice"),
            policyVersion: vault.policyVersion(),
            validUntil: uint64(block.timestamp + 1 hours)
        });
    }

    function authorize(Vault.Payment memory p, uint256 nonce) internal view returns (Vault.ExceptionAuthorization memory) {
        return Vault.ExceptionAuthorization({
            paymentHash: vault.hashPayment(p),
            approvalNonce: nonce,
            authorizationExpiry: uint64(block.timestamp + 10 minutes)
        });
    }

    /// `v` is 27 or 28, the format `eth_signTypedData_v4` returns.
    function signWith(uint256 key, Vault.ExceptionAuthorization memory a) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, vault.exceptionDigest(a));
        return abi.encodePacked(r, s, v);
    }

    function payAsAgent(Vault.Payment memory p) internal {
        vm.prank(agent);
        vault.pay(p);
    }

    function payExceptionAsAgent(Vault.Payment memory p, Vault.ExceptionAuthorization memory a, bytes memory signature)
        internal
    {
        vm.prank(agent);
        vault.payWithException(p, a, signature);
    }

    function expectPayRevert(Vault.Payment memory p, bytes4 selector) internal {
        vm.expectRevert(selector);
        vm.prank(agent);
        vault.pay(p);
    }

    function expectExceptionRevert(
        Vault.Payment memory p,
        Vault.ExceptionAuthorization memory a,
        bytes memory signature,
        bytes4 selector
    ) internal {
        vm.expectRevert(selector);
        vm.prank(agent);
        vault.payWithException(p, a, signature);
    }

    // ---- Basic paths ----

    function test_ordinaryPaymentSettles() public {
        Vault.Payment memory p = payment(vendorA, ONE_USDC / 4);
        payAsAgent(p);
        assertEq(token.balanceOf(vendorA), ONE_USDC / 4);
        assertTrue(vault.consumedPayment(p.paymentId));
        assertEq(vault.paymentHashById(p.paymentId), vault.hashPayment(p));
        assertEq(vault.spentByDay(block.timestamp / 86_400), ONE_USDC / 4);
    }

    function test_wrongCallerFails() public {
        Vault.Payment memory p = payment(vendorA, 1);
        vm.expectRevert(Vault.NotAgent.selector);
        vm.prank(stranger);
        vault.pay(p);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        bytes memory signature = signWith(ownerKey, a);
        vm.expectRevert(Vault.NotAgent.selector);
        vm.prank(owner);
        vault.payWithException(p, a, signature);
    }

    function test_disallowedRecipientFails() public {
        expectPayRevert(payment(address(0xC3), 1), Vault.RecipientNotAllowed.selector);
    }

    function test_zeroRecipientFails() public {
        expectPayRevert(payment(address(0), 1), Vault.ZeroAddress.selector);
    }

    function test_zeroAmountFails() public {
        expectPayRevert(payment(vendorA, 0), Vault.ZeroAmount.selector);
    }

    function test_A1_overPerPaymentLimitFails() public {
        expectPayRevert(payment(vendorA, 6 * ONE_USDC), Vault.PerPaymentLimitExceeded.selector);
        assertEq(token.balanceOf(vendorA), 0);
    }

    function test_overDailyLimitFailsEvenWithException() public {
        Vault.Payment memory first = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(first, 1);
        payExceptionAsAgent(first, a, signWith(ownerKey, a));
        Vault.Payment memory second = payment(vendorA, 5 * ONE_USDC);
        Vault.ExceptionAuthorization memory b = authorize(second, 2);
        expectExceptionRevert(second, b, signWith(ownerKey, b), Vault.DailyLimitExceeded.selector);
    }

    function test_expiredPolicyFails() public {
        Vault.Payment memory p = payment(vendorA, 1);
        p.validUntil = uint64(START + 365 days);
        vm.warp(START + 30 days + 1);
        expectPayRevert(p, Vault.PolicyExpired.selector);
    }

    function test_expiredPaymentFails() public {
        Vault.Payment memory p = payment(vendorA, 1);
        vm.warp(p.validUntil + 1);
        expectPayRevert(p, Vault.PaymentExpired.selector);
    }

    function test_pauseBlocksBothPaths() public {
        Vault.Payment memory p = payment(vendorA, 1);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        bytes memory signature = signWith(ownerKey, a);
        vm.prank(owner);
        vault.pause();
        expectPayRevert(p, Vault.VaultPaused.selector);
        expectExceptionRevert(p, a, signature, Vault.VaultPaused.selector);
        vm.prank(owner);
        vault.unpause();
        payAsAgent(p);
    }

    function test_onlyOwnerCanCallAdminFunctions() public {
        address[2] memory callers = [agent, stranger];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.expectRevert(Vault.NotOwner.selector);
            vm.prank(callers[i]);
            vault.configurePolicy(callers[i], 1, 1, 1);
            vm.expectRevert(Vault.NotOwner.selector);
            vm.prank(callers[i]);
            vault.setRecipient(callers[i], true);
            vm.expectRevert(Vault.NotOwner.selector);
            vm.prank(callers[i]);
            vault.pause();
            vm.expectRevert(Vault.NotOwner.selector);
            vm.prank(callers[i]);
            vault.unpause();
            vm.expectRevert(Vault.NotOwner.selector);
            vm.prank(callers[i]);
            vault.withdraw(callers[i], 1);
        }
    }

    function test_ownerWithdraws() public {
        uint256 version = vault.policyVersion();
        vm.prank(owner);
        vault.withdraw(owner, 5 * ONE_USDC);
        assertEq(token.balanceOf(owner), 5 * ONE_USDC);
        assertEq(vault.policyVersion(), version);
        vm.expectRevert(Vault.ZeroAddress.selector);
        vm.prank(owner);
        vault.withdraw(address(0), 1);
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(Vault.ZeroAddress.selector);
        new Vault(address(0), address(token));
        vm.expectRevert(Vault.ZeroAddress.selector);
        new Vault(owner, address(0));
    }

    // ---- Exceptions and signature formats ----

    function test_ownerSignedExceptionSettles() public {
        Vault.Payment memory p = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        payExceptionAsAgent(p, a, signWith(ownerKey, a));
        assertEq(token.balanceOf(vendorA), 6 * ONE_USDC);
        assertTrue(vault.consumedApprovalNonce(1));
    }

    function test_rawRecoveryIdAlsoAccepted() public {
        Vault.Payment memory p = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, vault.exceptionDigest(a));
        payExceptionAsAgent(p, a, abi.encodePacked(r, s, v - 27));
        assertEq(token.balanceOf(vendorA), 6 * ONE_USDC);
    }

    function test_invalidRecoveryIdsFail() public {
        Vault.Payment memory p = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        (, bytes32 r, bytes32 s) = vm.sign(ownerKey, vault.exceptionDigest(a));
        uint8[3] memory bad = [2, 26, 29];
        for (uint256 i = 0; i < bad.length; ++i) {
            expectExceptionRevert(p, a, abi.encodePacked(r, s, bad[i]), Vault.BadSignature.selector);
        }
    }

    function test_highSSignatureFails() public {
        Vault.Payment memory p = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, vault.exceptionDigest(a));
        uint256 order = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory twin = abi.encodePacked(r, bytes32(order - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        expectExceptionRevert(p, a, twin, Vault.BadSignature.selector);
    }

    function test_malformedSignaturesFail() public {
        Vault.Payment memory p = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        expectExceptionRevert(p, a, hex"", Vault.BadSignature.selector);
        expectExceptionRevert(p, a, new bytes(64), Vault.BadSignature.selector);
        expectExceptionRevert(p, a, new bytes(65), Vault.BadSignature.selector);
    }

    // ---- Bad exception signatures ----

    function test_A2_agentSignedExceptionFails() public {
        Vault.Payment memory p = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        expectExceptionRevert(p, a, signWith(agentKey, a), Vault.BadSignature.selector);
        assertEq(token.balanceOf(vendorA), 0);
    }

    function test_nonOwnerSignedExceptionFails() public {
        Vault.Payment memory p = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        expectExceptionRevert(p, a, signWith(strangerKey, a), Vault.BadSignature.selector);
    }

    function test_signatureForWrongChainFails() public {
        Vault.Payment memory p = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        uint256 chain = block.chainid;
        vm.chainId(chain + 1);
        bytes memory signature = signWith(ownerKey, a);
        vm.chainId(chain);
        expectExceptionRevert(p, a, signature, Vault.BadSignature.selector);
    }

    function test_signatureForWrongVaultFails() public {
        Vault other = new Vault(owner, address(token));
        Vault.Payment memory p = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, other.exceptionDigest(a));
        expectExceptionRevert(p, a, abi.encodePacked(r, s, v), Vault.BadSignature.selector);
    }

    function test_A3_signatureForOtherRecipientFails() public {
        Vault.Payment memory signed = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(signed, 1);
        bytes memory signature = signWith(ownerKey, a);
        Vault.Payment memory swapped = signed;
        swapped.recipient = vendorB;
        // Unchanged authorization: its payment hash no longer matches.
        expectExceptionRevert(swapped, a, signature, Vault.PaymentHashMismatch.selector);
        // Authorization rewritten to match: the owner did not sign that.
        Vault.ExceptionAuthorization memory rewritten = a;
        rewritten.paymentHash = vault.hashPayment(swapped);
        expectExceptionRevert(swapped, rewritten, signature, Vault.BadSignature.selector);
        assertEq(token.balanceOf(vendorB), 0);
    }

    function test_signatureForOtherAmountFails() public {
        Vault.Payment memory signed = payment(vendorA, 2 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(signed, 1);
        bytes memory signature = signWith(ownerKey, a);
        signed.amount = 6 * ONE_USDC;
        assertRejectedBothWays(signed, a, signature);
    }

    function test_signatureForOtherCommitmentFails() public {
        Vault.Payment memory signed = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(signed, 1);
        bytes memory signature = signWith(ownerKey, a);
        signed.evidenceCommitment = keccak256("other invoice");
        assertRejectedBothWays(signed, a, signature);
    }

    function test_signatureForOtherValidUntilFails() public {
        Vault.Payment memory signed = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(signed, 1);
        bytes memory signature = signWith(ownerKey, a);
        signed.validUntil += 1;
        assertRejectedBothWays(signed, a, signature);
    }

    function assertRejectedBothWays(
        Vault.Payment memory changed,
        Vault.ExceptionAuthorization memory a,
        bytes memory signature
    ) internal {
        expectExceptionRevert(changed, a, signature, Vault.PaymentHashMismatch.selector);
        Vault.ExceptionAuthorization memory rewritten = a;
        rewritten.paymentHash = vault.hashPayment(changed);
        expectExceptionRevert(changed, rewritten, signature, Vault.BadSignature.selector);
    }

    function test_fieldsTheVaultPinsAreRejected() public {
        Vault.Payment memory p = payment(vendorA, 6 * ONE_USDC);
        p.agent = stranger;
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        expectExceptionRevert(p, a, signWith(ownerKey, a), Vault.AgentMismatch.selector);

        p = payment(vendorA, 6 * ONE_USDC);
        p.token = address(0xD4);
        a = authorize(p, 1);
        expectExceptionRevert(p, a, signWith(ownerKey, a), Vault.TokenMismatch.selector);

        p = payment(vendorA, 6 * ONE_USDC);
        p.policyVersion += 1;
        a = authorize(p, 1);
        expectExceptionRevert(p, a, signWith(ownerKey, a), Vault.PolicyVersionMismatch.selector);
    }

    function test_alteredOrPassedExpiryFails() public {
        Vault.Payment memory p = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        bytes memory signature = signWith(ownerKey, a);
        Vault.ExceptionAuthorization memory extended = Vault.ExceptionAuthorization({
            paymentHash: a.paymentHash,
            approvalNonce: a.approvalNonce,
            authorizationExpiry: a.authorizationExpiry + 1 days
        });
        expectExceptionRevert(p, extended, signature, Vault.BadSignature.selector);
        vm.warp(a.authorizationExpiry + 1);
        expectExceptionRevert(p, a, signature, Vault.AuthorizationExpired.selector);
    }

    function test_alteredNonceFails() public {
        Vault.Payment memory p = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        bytes memory signature = signWith(ownerKey, a);
        a.approvalNonce = 2;
        expectExceptionRevert(p, a, signature, Vault.BadSignature.selector);
    }

    // ---- Replay and policy changes ----

    function test_A4_resubmittedExceptionFails() public {
        Vault.Payment memory p = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        bytes memory signature = signWith(ownerKey, a);
        payExceptionAsAgent(p, a, signature);
        expectExceptionRevert(p, a, signature, Vault.PaymentAlreadyUsed.selector);
        assertEq(token.balanceOf(vendorA), 6 * ONE_USDC);
    }

    function test_paymentIdReuseFailsAcrossBothPaths() public {
        Vault.Payment memory p = payment(vendorA, ONE_USDC);
        payAsAgent(p);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        expectExceptionRevert(p, a, signWith(ownerKey, a), Vault.PaymentAlreadyUsed.selector);

        Vault.Payment memory q = payment(vendorA, ONE_USDC);
        Vault.ExceptionAuthorization memory b = authorize(q, 2);
        payExceptionAsAgent(q, b, signWith(ownerKey, b));
        expectPayRevert(q, Vault.PaymentAlreadyUsed.selector);
    }

    function test_reusedNonceFails() public {
        Vault.Payment memory p = payment(vendorA, 2 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        payExceptionAsAgent(p, a, signWith(ownerKey, a));
        Vault.Payment memory q = payment(vendorA, 2 * ONE_USDC);
        Vault.ExceptionAuthorization memory b = authorize(q, 1);
        expectExceptionRevert(q, b, signWith(ownerKey, b), Vault.ApprovalNonceUsed.selector);
    }

    function test_policyChangeInvalidatesPendingWithoutResettingSpend() public {
        uint256 day = block.timestamp / 86_400;
        payAsAgent(payment(vendorA, ONE_USDC));
        Vault.Payment memory pending = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(pending, 1);
        bytes memory signature = signWith(ownerKey, a);
        uint256 version = vault.policyVersion();

        vm.prank(owner);
        vault.configurePolicy(agent, PER_PAYMENT, DAILY, uint64(START + 30 days));
        assertEq(vault.policyVersion(), version + 1);
        assertEq(vault.spentByDay(day), ONE_USDC);
        expectExceptionRevert(pending, a, signature, Vault.PolicyVersionMismatch.selector);

        vm.prank(owner);
        vault.setRecipient(address(0xE5), true);
        assertEq(vault.policyVersion(), version + 2);
        assertEq(vault.spentByDay(day), ONE_USDC);
    }

    function test_agentChangeLocksOutOldAgent() public {
        Vault.Payment memory p = payment(vendorA, 1);
        vm.prank(owner);
        vault.configurePolicy(stranger, PER_PAYMENT, DAILY, uint64(START + 30 days));
        expectPayRevert(p, Vault.NotAgent.selector);
    }

    // ---- Edges and rollback ----

    function test_exactlyAtPerPaymentLimitAndOneOver() public {
        payAsAgent(payment(vendorA, PER_PAYMENT));
        expectPayRevert(payment(vendorA, PER_PAYMENT + 1), Vault.PerPaymentLimitExceeded.selector);
    }

    function test_exactlyAtDailyLimitAndOneOver() public {
        Vault.Payment memory p = payment(vendorA, DAILY);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        payExceptionAsAgent(p, a, signWith(ownerKey, a));
        expectPayRevert(payment(vendorA, 1), Vault.DailyLimitExceeded.selector);
    }

    function test_validUntilBoundaryIsInclusive() public {
        Vault.Payment memory p = payment(vendorA, 1);
        vm.warp(p.validUntil);
        payAsAgent(p);
    }

    function test_utcDayBoundary() public {
        uint256 nextDay = (block.timestamp / 86_400 + 1) * 86_400;
        vm.warp(nextDay - 1);
        Vault.Payment memory full = payment(vendorA, DAILY);
        Vault.ExceptionAuthorization memory a = authorize(full, 1);
        payExceptionAsAgent(full, a, signWith(ownerKey, a));
        expectPayRevert(payment(vendorA, 1), Vault.DailyLimitExceeded.selector);

        vm.warp(nextDay);
        payAsAgent(payment(vendorA, ONE_USDC));
        assertEq(vault.spentByDay(nextDay / 86_400 - 1), DAILY);
        assertEq(vault.spentByDay(nextDay / 86_400), ONE_USDC);
    }

    function test_failedTransferRollsBackAllState() public {
        MockFailingERC20 failing = new MockFailingERC20();
        Vault vaultWithFailingToken = deployVault(address(failing));
        failing.mint(address(vaultWithFailingToken), 100 * ONE_USDC);
        vault = vaultWithFailingToken;

        Vault.Payment memory p = payment(vendorA, 6 * ONE_USDC);
        p.token = address(failing);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        bytes memory signature = signWith(ownerKey, a);
        uint256 day = block.timestamp / 86_400;

        failing.setMode(MockFailingERC20.Mode.ReturnFalse);
        expectExceptionRevert(p, a, signature, Vault.TransferFailed.selector);
        failing.setMode(MockFailingERC20.Mode.Revert);
        expectExceptionRevert(p, a, signature, Vault.TransferFailed.selector);

        assertFalse(vault.consumedPayment(p.paymentId));
        assertFalse(vault.consumedApprovalNonce(1));
        assertEq(vault.paymentHashById(p.paymentId), bytes32(0));
        assertEq(vault.spentByDay(day), 0);

        failing.setMode(MockFailingERC20.Mode.Normal);
        payExceptionAsAgent(p, a, signature);
        assertEq(failing.balanceOf(vendorA), 6 * ONE_USDC);
    }

    function test_feeOnTransferTokenIsRejected() public {
        token.setFeeOnTransfer(true);
        expectPayRevert(payment(vendorA, ONE_USDC), Vault.TransferFailed.selector);
    }

    function test_reentrantTokenCannotPayTwice() public {
        MockReentrantERC20 reentrant = new MockReentrantERC20();
        vault = deployVault(address(reentrant));
        reentrant.mint(address(vault), 100 * ONE_USDC);
        Vault.Payment memory p = payment(vendorA, ONE_USDC);
        p.token = address(reentrant);
        Vault.Payment memory q = payment(vendorA, ONE_USDC);
        q.token = address(reentrant);
        reentrant.armTransfer(address(vault), abi.encodeCall(Vault.pay, (q)));
        expectPayRevert(p, Vault.TransferFailed.selector);
        assertEq(reentrant.balanceOf(vendorA), 0);
        assertFalse(vault.consumedPayment(p.paymentId));
        assertFalse(vault.consumedPayment(q.paymentId));
    }

    // ---- Event and cross-language checks ----

    function findPaymentEvent(Vm.Log[] memory logs) internal view returns (Vm.Log memory) {
        bytes32 topic = keccak256(
            "PaymentExecuted(bytes32,address,uint256,bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,bool,bytes32)"
        );
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == topic) return logs[i];
        }
        revert("PaymentExecuted not found");
    }

    function assertEventMatches(Vault.Payment memory p, bool exception, bytes32 expectedDigest, uint256 spentAfter)
        internal
    {
        Vm.Log memory log = findPaymentEvent(vm.getRecordedLogs());
        assertEq(log.topics[1], p.paymentId);
        assertEq(log.topics[2], bytes32(uint256(uint160(p.recipient))));
        ExecutedData memory data = abi.decode(log.data, (ExecutedData));
        assertEq(data.amount, p.amount);
        assertEq(data.paymentHash, vault.hashPayment(p));
        assertEq(data.commitment, p.evidenceCommitment);
        assertEq(data.version, vault.policyVersion());
        assertEq(data.perPayment, PER_PAYMENT);
        assertEq(data.daily, DAILY);
        assertEq(data.day, block.timestamp / 86_400);
        assertEq(data.daySpent, spentAfter);
        assertTrue(data.exception == exception);
        assertEq(data.digest, expectedDigest);
    }

    function test_ordinaryEventRecordsEnforcedPolicy() public {
        Vault.Payment memory p = payment(vendorA, ONE_USDC / 4);
        vm.recordLogs();
        payAsAgent(p);
        assertEventMatches(p, false, bytes32(0), ONE_USDC / 4);
    }

    function test_exceptionEventRecordsEnforcedPolicy() public {
        payAsAgent(payment(vendorA, ONE_USDC / 4));
        Vault.Payment memory p = payment(vendorA, 6 * ONE_USDC);
        Vault.ExceptionAuthorization memory a = authorize(p, 1);
        bytes memory signature = signWith(ownerKey, a);
        bytes32 digest = vault.exceptionDigest(a);
        vm.recordLogs();
        payExceptionAsAgent(p, a, signature);
        assertEventMatches(p, true, digest, 6 * ONE_USDC + ONE_USDC / 4);
    }

    function test_digestsMatchSharedVector() public {
        string memory json = vm.readFile(VECTOR);
        vm.chainId(parseDecimal(vm.parseJsonString(json, ".domain.chainId")));
        address at = readAddress(json, ".domain.verifyingContract");
        vm.etch(at, address(vault).code);
        Vault vectorVault = Vault(at);

        Vault.Payment memory p = Vault.Payment({
            paymentId: readBytes32(json, ".payment.paymentId"),
            agent: readAddress(json, ".payment.agent"),
            token: readAddress(json, ".payment.token"),
            recipient: readAddress(json, ".payment.recipient"),
            amount: parseDecimal(vm.parseJsonString(json, ".payment.amount")),
            evidenceCommitment: readBytes32(json, ".payment.evidenceCommitment"),
            policyVersion: parseDecimal(vm.parseJsonString(json, ".payment.policyVersion")),
            validUntil: uint64(parseDecimal(vm.parseJsonString(json, ".payment.validUntil")))
        });
        bytes32 paymentHash = vectorVault.hashPayment(p);
        assertEq(paymentHash, readBytes32(json, ".expected.paymentHash"));
        assertEq(vectorVault.domainSeparator(), readBytes32(json, ".expected.domainSeparator"));

        Vault.ExceptionAuthorization memory a = Vault.ExceptionAuthorization({
            paymentHash: paymentHash,
            approvalNonce: parseDecimal(vm.parseJsonString(json, ".authorization.approvalNonce")),
            authorizationExpiry: uint64(parseDecimal(vm.parseJsonString(json, ".authorization.authorizationExpiry")))
        });
        assertEq(vectorVault.exceptionDigest(a), readBytes32(json, ".expected.approvalDigest"));
    }

    function readBytes32(string memory json, string memory key) internal pure returns (bytes32) {
        return toBytes32(hexToBytes(vm.parseJsonString(json, key)));
    }

    function readAddress(string memory json, string memory key) internal pure returns (address) {
        return toAddress(hexToBytes(vm.parseJsonString(json, key)));
    }

    function parseDecimal(string memory value) internal pure returns (uint256 out) {
        bytes memory digits = bytes(value);
        for (uint256 i = 0; i < digits.length; ++i) {
            out = out * 10 + (uint8(digits[i]) - 0x30);
        }
    }
}
