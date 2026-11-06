// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {StyxVault as Vault} from "../src/StyxVault.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MockReentrantERC20} from "../src/MockReentrantERC20.sol";
import {MockFailingERC20} from "../src/MockFailingERC20.sol";
import {TestBase} from "./TestBase.sol";
import {Vm} from "./Vm.sol";

interface RandomVm {
    function randomUint() external returns (uint256);
}

/// A two-participant contract signer. Signature bytes are deliberately longer than an EOA signature.
contract ThresholdSignerV2 {
    address public first;
    address public second;
    uint256 public mode;
    address public target;

    constructor(address a, address b) {
        first = a;
        second = b;
    }

    function setMode(uint256 value) external {
        mode = value;
    }

    function setTarget(address value) external {
        target = value;
    }

    function execute(address to, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory out) = to.call(data);
        require(ok, "wallet execution failed");
        return out;
    }

    function isValidSignature(bytes32 digest, bytes calldata sig) external view returns (bytes4) {
        if (mode == 1) revert("validator unavailable");
        if (mode == 2) return 0xffffffff;
        if (mode == 3) {
            assembly {
                mstore(0, 0x16)
                return(31, 1)
            }
        }
        if (mode == 4) {
            assembly {
                mstore(0, shl(224, 0xffffffff))
                return(0, 65536)
            }
        }
        if (mode == 5) {
            (bool ok, bytes memory out) =
                target.staticcall(abi.encodeWithSignature("withdraw(address,uint256)", first, 1));
            require(!ok && bytes4(out) == Vault.Reentrancy.selector, "reentrancy was not blocked");
        }
        if (sig.length != 130) return 0xffffffff;
        address a = ecrecover(digest, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
        address b = ecrecover(digest, uint8(sig[129]), bytes32(sig[65:97]), bytes32(sig[97:129]));
        return a == first && b == second ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract StyxVaultTest is TestBase {
    uint256 internal ownerKey;
    uint256 internal agentKey;
    uint256 internal approverKey;
    uint256 internal secondKey;
    address internal owner;
    address internal agent;
    address internal approver;
    address internal second;
    address internal vendor = address(0xA1);
    address internal otherVendor = address(0xB2);
    MockERC20 internal token;
    Vault internal vault;
    uint256 internal sequence;
    uint64 internal expiry;

    function freshKey() internal returns (uint256) {
        return RandomVm(address(vm)).randomUint()
            % (0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - 1) + 1;
    }

    function setUp() public {
        vm.warp(1800000000);
        ownerKey = freshKey();
        agentKey = freshKey();
        approverKey = freshKey();
        secondKey = freshKey();
        owner = vm.addr(ownerKey);
        agent = vm.addr(agentKey);
        approver = vm.addr(approverKey);
        second = vm.addr(secondKey);
        expiry = uint64(block.timestamp + 30 days);
        token = new MockERC20("USDC", "USDC");
        vault = new Vault(owner, address(token));
        config(agent, 1_000_000, 10_000_000, true);
        config(second, 1_000_000, 10_000_000, true);
        vm.prank(owner);
        vault.setApprover(approver, true);
        vm.prank(owner);
        vault.setRecipient(vendor, true);
        vm.prank(owner);
        vault.setRecipient(otherVendor, true);
        vm.prank(owner);
        vault.setVaultDailyLimit(15_000_000);
        token.mint(address(vault), 100_000_000);
    }

    function config(address who, uint256 per, uint256 daily, bool enabled) internal {
        vm.prank(owner);
        vault.configureAgent(who, per, daily, expiry, enabled);
    }

    function payment(address who, uint256 amount) internal returns (Vault.Payment memory p) {
        (uint256 version,,,,) = vault.agentPolicy(who);
        p = Vault.Payment(
            keccak256(abi.encode(++sequence)),
            who,
            address(token),
            vendor,
            amount,
            keccak256("invoice"),
            version,
            vault.recipientVersion(vendor),
            uint64(block.timestamp + 1 hours)
        );
    }

    function auth(Vault.Payment memory p, address signer, uint256 nonce)
        internal
        view
        returns (Vault.ExceptionAuthorization memory)
    {
        (uint256 version,) = vault.approverState(signer);
        return Vault.ExceptionAuthorization(
            vault.hashPayment(p), signer, version, nonce, uint64(block.timestamp + 10 minutes)
        );
    }

    function sign(uint256 key, Vault.ExceptionAuthorization memory a) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, vault.exceptionDigest(a));
        return abi.encodePacked(r, s, v);
    }

    function pay(Vault.Payment memory p) internal {
        vm.prank(p.agent);
        vault.pay(p);
    }

    function exception(Vault.Payment memory p, Vault.ExceptionAuthorization memory a, bytes memory sig) internal {
        vm.prank(p.agent);
        vault.payWithException(p, a, sig);
    }

    function refuse(Vault.Payment memory p, Vault.ExceptionAuthorization memory a, bytes memory sig, bytes4 reason)
        internal
    {
        vm.expectRevert(reason);
        vm.prank(p.agent);
        vault.payWithException(p, a, sig);
    }

    function test_routineAndIndependentCounters() public {
        pay(payment(agent, 500_000));
        pay(payment(second, 750_000));
        uint256 day = block.timestamp / 1 days;
        assertEq(vault.spentByAgentDay(agent, day), 500_000);
        assertEq(vault.spentByAgentDay(second, day), 750_000);
        assertEq(vault.spentByDay(day), 1_250_000);
        assertEq(token.balanceOf(vendor), 1_250_000);
    }

    function test_A1_oversizedRoutineRefused() public {
        Vault.Payment memory p = payment(agent, 6_000_000);
        vm.expectRevert(Vault.PerPaymentLimitExceeded.selector);
        pay(p);
    }

    function test_A2_agentCannotSignException() public {
        Vault.Payment memory p = payment(agent, 6_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, owner, 1);
        refuse(p, a, sign(agentKey, a), Vault.BadSignature.selector);
        a = auth(p, agent, 1);
        refuse(p, a, sign(agentKey, a), Vault.ApproverNotAllowed.selector);
    }

    function test_A3_changedRecipientRefused() public {
        Vault.Payment memory p = payment(agent, 6_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, approver, 1);
        bytes memory sig = sign(approverKey, a);
        p.recipient = otherVendor;
        refuse(p, a, sig, Vault.PaymentHashMismatch.selector);
    }

    function test_A4_replayRefused() public {
        Vault.Payment memory p = payment(agent, 6_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, approver, 1);
        bytes memory sig = sign(approverKey, a);
        exception(p, a, sig);
        refuse(p, a, sig, Vault.PaymentAlreadyUsed.selector);
    }

    function test_unrelatedChangesPreservePending() public {
        Vault.Payment memory p = payment(agent, 6_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, approver, 1);
        bytes memory sig = sign(approverKey, a);
        config(second, 2, 3, false);
        vm.prank(owner);
        vault.setApprover(address(0xCAFE), true);
        vm.prank(owner);
        vault.setApprover(address(0xCAFE), false);
        vm.prank(owner);
        vault.setRecipient(otherVendor, false);
        exception(p, a, sig);
        assertTrue(vault.consumedPayment(p.paymentId));
    }

    function test_agentRemoveReaddDoesNotReviveOrReset() public {
        pay(payment(agent, 1_000_000));
        Vault.Payment memory p = payment(agent, 6_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, approver, 1);
        bytes memory sig = sign(approverKey, a);
        config(agent, 1_000_000, 10_000_000, false);
        refuse(p, a, sig, Vault.NotAgent.selector);
        config(agent, 1_000_000, 10_000_000, true);
        refuse(p, a, sig, Vault.PolicyVersionMismatch.selector);
        assertEq(vault.spentByAgentDay(agent, block.timestamp / 1 days), 1_000_000);
    }

    function test_approverRemoveReaddDoesNotRevive() public {
        Vault.Payment memory p = payment(agent, 6_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, approver, 1);
        bytes memory sig = sign(approverKey, a);
        vm.prank(owner);
        vault.setApprover(approver, false);
        refuse(p, a, sig, Vault.ApproverNotAllowed.selector);
        vm.prank(owner);
        vault.setApprover(approver, true);
        refuse(p, a, sig, Vault.SignerVersionMismatch.selector);
    }

    function test_vendorRemoveReaddDoesNotRevive() public {
        Vault.Payment memory p = payment(agent, 6_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, approver, 1);
        bytes memory sig = sign(approverKey, a);
        vm.prank(owner);
        vault.setRecipient(vendor, false);
        refuse(p, a, sig, Vault.RecipientNotAllowed.selector);
        vm.prank(owner);
        vault.setRecipient(vendor, true);
        refuse(p, a, sig, Vault.RecipientVersionMismatch.selector);
    }

    function test_paymentBeforeRemovalSettles() public {
        Vault.Payment memory p = payment(agent, 6_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, approver, 1);
        exception(p, a, sign(approverKey, a));
        config(agent, 0, 0, false);
        vm.prank(owner);
        vault.setApprover(approver, false);
        assertTrue(vault.consumedPayment(p.paymentId));
    }

    function test_nonceBoundToSignerAcrossAgentsAndVersions() public {
        Vault.Payment memory p = payment(agent, 2_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, approver, 7);
        exception(p, a, sign(approverKey, a));
        p = payment(second, 2_000_000);
        a = auth(p, approver, 7);
        refuse(p, a, sign(approverKey, a), Vault.ApprovalNonceUsed.selector);
        vm.prank(owner);
        vault.setApprover(approver, false);
        vm.prank(owner);
        vault.setApprover(approver, true);
        a = auth(p, approver, 7);
        refuse(p, a, sign(approverKey, a), Vault.ApprovalNonceUsed.selector);
        a = auth(p, owner, 7);
        exception(p, a, sign(ownerKey, a));
    }

    function test_crossAgentReplayAndGlobalIdCollision() public {
        Vault.Payment memory p = payment(agent, 2_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, approver, 7);
        bytes memory sig = sign(approverKey, a);
        p.agent = second;
        refuse(p, a, sig, Vault.PaymentHashMismatch.selector);
        p.agent = agent;
        exception(p, a, sig);
        p.agent = second;
        refuse(p, a, sig, Vault.PaymentAlreadyUsed.selector);
    }

    function test_dailyCapCannotBeLiftedByApproverOrOwner() public {
        Vault.Payment memory p = payment(agent, 10_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, approver, 1);
        exception(p, a, sign(approverKey, a));
        p = payment(agent, 1);
        a = auth(p, owner, 2);
        refuse(p, a, sign(ownerKey, a), Vault.DailyLimitExceeded.selector);
    }

    function test_aggregateCapAcrossAgentsAndReduction() public {
        Vault.Payment memory p = payment(agent, 8_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, owner, 1);
        exception(p, a, sign(ownerKey, a));
        p = payment(second, 8_000_000);
        a = auth(p, approver, 2);
        bytes memory sig = sign(approverKey, a);
        refuse(p, a, sig, Vault.VaultDailyLimitExceeded.selector);
        vm.prank(owner);
        vault.setVaultDailyLimit(16_000_000);
        exception(p, a, sig);
        vm.prank(owner);
        vault.setVaultDailyLimit(1);
        p = payment(agent, 1);
        vm.expectRevert(Vault.VaultDailyLimitExceeded.selector);
        pay(p);
    }

    function test_splittingCannotExceedDailyCap() public {
        for (uint256 i; i < 10; ++i) {
            pay(payment(agent, 1_000_000));
        }
        Vault.Payment memory p = payment(agent, 1);
        vm.expectRevert(Vault.DailyLimitExceeded.selector);
        pay(p);
    }

    function test_lowerAgentCapDoesNotUnderflowOrReset() public {
        pay(payment(agent, 1_000_000));
        config(agent, 1_000_000, 1, true);
        Vault.Payment memory p = payment(agent, 1);
        vm.expectRevert(Vault.DailyLimitExceeded.selector);
        pay(p);
    }

    function test_pauseBothPathsAndOwnerWithdrawWhilePaused() public {
        Vault.Payment memory p = payment(agent, 1);
        Vault.ExceptionAuthorization memory a = auth(p, approver, 1);
        bytes memory sig = sign(approverKey, a);
        vm.prank(owner);
        vault.pause();
        vm.expectRevert(Vault.VaultPaused.selector);
        pay(p);
        refuse(p, a, sig, Vault.VaultPaused.selector);
        vm.prank(owner);
        vault.withdraw(owner, 123);
        assertEq(token.balanceOf(owner), 123);
        vm.prank(owner);
        vault.unpause();
        pay(p);
    }

    function test_roleOverlapRefusedBothDirections() public {
        vm.expectRevert(Vault.RoleConflict.selector);
        vm.prank(owner);
        vault.setApprover(agent, true);
        vm.expectRevert(Vault.RoleConflict.selector);
        vm.prank(owner);
        vault.configureAgent(approver, 1, 1, expiry, true);
        vm.expectRevert(Vault.RoleConflict.selector);
        vm.prank(owner);
        vault.configureAgent(owner, 1, 1, expiry, true);
    }

    function test_agentAndApproverCannotAdminOrWithdraw() public {
        address[2] memory callers = [agent, approver];
        for (uint256 i; i < callers.length; ++i) {
            vm.expectRevert(Vault.NotOwner.selector);
            vm.prank(callers[i]);
            vault.withdraw(callers[i], 1);
            vm.expectRevert(Vault.NotOwner.selector);
            vm.prank(callers[i]);
            vault.setVaultDailyLimit(type(uint256).max);
            vm.expectRevert(Vault.NotOwner.selector);
            vm.prank(callers[i]);
            vault.configureAgent(callers[i], 1, 1, expiry, true);
            vm.expectRevert(Vault.NotOwner.selector);
            vm.prank(callers[i]);
            vault.setApprover(callers[i], true);
            vm.expectRevert(Vault.NotOwner.selector);
            vm.prank(callers[i]);
            vault.setRecipient(callers[i], true);
            vm.expectRevert(Vault.NotOwner.selector);
            vm.prank(callers[i]);
            vault.pause();
            vm.expectRevert(Vault.NotOwner.selector);
            vm.prank(callers[i]);
            vault.unpause();
        }
    }

    function test_expiryInclusiveAndDayRollover() public {
        Vault.Payment memory p = payment(agent, 1_000_000);
        p.validUntil = uint64(block.timestamp);
        pay(p);
        p = payment(agent, 1);
        p.validUntil = uint64(block.timestamp - 1);
        vm.expectRevert(Vault.PaymentExpired.selector);
        pay(p);
        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        pay(payment(agent, 1_000_000));
        assertEq(vault.spentByAgentDay(agent, block.timestamp / 1 days), 1_000_000);
    }

    function test_expiredAuthorizationAndPolicy() public {
        Vault.Payment memory p = payment(agent, 2_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, owner, 1);
        a.authorizationExpiry = uint64(block.timestamp - 1);
        refuse(p, a, sign(ownerKey, a), Vault.AuthorizationExpired.selector);
        expiry = uint64(block.timestamp - 1);
        config(agent, 1, 10_000_000, true);
        p = payment(agent, 1);
        vm.expectRevert(Vault.PolicyExpired.selector);
        pay(p);
    }

    function test_wrongChainAndVaultSignaturesFail() public {
        Vault.Payment memory p = payment(agent, 2_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, owner, 1);
        bytes memory sig = sign(ownerKey, a);
        uint256 chain = block.chainid;
        vm.chainId(chain + 1);
        refuse(p, a, sig, Vault.BadSignature.selector);
        vm.chainId(chain);
        Vault other = new Vault(owner, address(token));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, other.exceptionDigest(a));
        refuse(p, a, abi.encodePacked(r, s, v), Vault.BadSignature.selector);
    }

    function test_malformedHighSAndRawRecoverySignatures() public {
        Vault.Payment memory p = payment(agent, 2_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, owner, 1);
        refuse(p, a, hex"1234", Vault.BadSignature.selector);
        bytes memory sig = sign(ownerKey, a);
        bytes32 s;
        assembly { s := mload(add(sig, 64)) }
        uint256 high = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s);
        bytes32 r;
        assembly { r := mload(add(sig, 32)) }
        refuse(
            p, a, abi.encodePacked(r, high, uint8(sig[64]) == 27 ? uint8(28) : uint8(27)), Vault.BadSignature.selector
        );
        sig[64] = bytes1(uint8(sig[64]) - 27);
        exception(p, a, sig);
    }

    function test_allPaymentAndAuthorizationFieldsBound() public {
        Vault.Payment memory p = payment(agent, 2_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, approver, 1);
        bytes memory sig = sign(approverKey, a);
        p.amount++;
        refuse(p, a, sig, Vault.PaymentHashMismatch.selector);
        p.amount--;
        p.evidenceCommitment = bytes32(uint256(77));
        refuse(p, a, sig, Vault.PaymentHashMismatch.selector);
        p = payment(agent, 2_000_000);
        a = auth(p, approver, 1);
        sig = sign(approverKey, a);
        a.approvalNonce++;
        refuse(p, a, sig, Vault.BadSignature.selector);
        a.approvalNonce--;
        a.authorizationExpiry++;
        refuse(p, a, sig, Vault.BadSignature.selector);
        a.authorizationExpiry--;
        a.signer = owner;
        a.signerVersion = 0;
        refuse(p, a, sig, Vault.BadSignature.selector);
    }

    function test_contractOwnerThresholdAndValidatorFailures() public {
        ThresholdSignerV2 wallet = new ThresholdSignerV2(owner, approver);
        vault = new Vault(address(wallet), address(token));
        wallet.execute(
            address(vault), abi.encodeCall(vault.configureAgent, (agent, 1_000_000, 10_000_000, expiry, true))
        );
        wallet.execute(address(vault), abi.encodeCall(vault.setRecipient, (vendor, true)));
        wallet.execute(address(vault), abi.encodeCall(vault.setVaultDailyLimit, (10_000_000)));
        token.mint(address(vault), 20_000_000);
        wallet.setTarget(address(vault));
        Vault.Payment memory p = payment(agent, 2_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, address(wallet), 1);
        bytes memory sig = bytes.concat(sign(ownerKey, a), sign(approverKey, a));
        refuse(p, a, sign(ownerKey, a), Vault.BadSignature.selector);
        for (uint256 i = 1; i <= 4; ++i) {
            wallet.setMode(i);
            refuse(p, a, sig, Vault.BadSignature.selector);
            assertFalse(vault.consumedPayment(p.paymentId));
        }
        wallet.setMode(5);
        exception(p, a, sig);
        vm.expectRevert(Vault.NotOwner.selector);
        vm.prank(owner);
        vault.withdraw(owner, 1);
        wallet.execute(address(vault), abi.encodeCall(vault.withdraw, (owner, 123)));
        assertEq(token.balanceOf(owner), 123);
    }

    function test_contractApproverAndRevokedValidity() public {
        ThresholdSignerV2 wallet = new ThresholdSignerV2(owner, approver);
        vm.prank(owner);
        vault.setApprover(address(wallet), true);
        Vault.Payment memory p = payment(agent, 2_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, address(wallet), 1);
        bytes memory sig = bytes.concat(sign(ownerKey, a), sign(approverKey, a));
        wallet.setMode(2);
        refuse(p, a, sig, Vault.BadSignature.selector);
        wallet.setMode(0);
        exception(p, a, sig);
    }

    function test_failedTransferRollsBackBothCountersAndNonce() public {
        MockFailingERC20 bad = new MockFailingERC20();
        vault = new Vault(owner, address(bad));
        bad.mint(address(vault), 10_000_000);
        bad.setMode(MockFailingERC20.Mode.ReturnFalse);
        config(agent, 1, 10_000_000, true);
        vm.prank(owner);
        vault.setRecipient(vendor, true);
        vm.prank(owner);
        vault.setVaultDailyLimit(10_000_000);
        Vault.Payment memory p = payment(agent, 2_000_000);
        p.token = address(bad);
        Vault.ExceptionAuthorization memory a = auth(p, owner, 1);
        refuse(p, a, sign(ownerKey, a), Vault.TransferFailed.selector);
        assertFalse(vault.consumedPayment(p.paymentId));
        assertFalse(vault.consumedApprovalNonce(owner, 1));
        assertEq(vault.spentByDay(block.timestamp / 1 days), 0);
        assertEq(vault.spentByAgentDay(agent, block.timestamp / 1 days), 0);
    }

    function test_sharedVector() public {
        vm.chainId(31337);
        address at = address(0x1111111111111111111111111111111111111111);
        vm.etch(at, address(vault).code);
        Vault target = Vault(at);
        Vault.Payment memory p = Vault.Payment(
            bytes32(uint256(0x0101010101010101010101010101010101010101010101010101010101010101)),
            address(0x2222222222222222222222222222222222222222),
            address(0x3333333333333333333333333333333333333333),
            address(0x4444444444444444444444444444444444444444),
            6000000,
            bytes32(uint256(0x0505050505050505050505050505050505050505050505050505050505050505)),
            3,
            2,
            1800000000
        );
        assertEq(target.hashPayment(p), 0xde5f4caf50fab61c41387225690fa7bc32e60fa2bd14cadee26c9e80697e3fe0);
        assertEq(target.domainSeparator(), 0x669681f970de9638a9ff6218c382c474c54ffe9757cc4c345814b20ccd3b7cf8);
        Vault.ExceptionAuthorization memory a = Vault.ExceptionAuthorization(
            target.hashPayment(p), address(0x5555555555555555555555555555555555555555), 4, 7, 1799999900
        );
        assertEq(target.exceptionDigest(a), 0x2472381b45ceb643cdd0abb7b7e3f522ee153e02b55f7ab69048148374e4b2ca);
    }

    function test_eventAbiAndBothCounters() public {
        pay(payment(second, 500_000));
        Vault.Payment memory p = payment(agent, 2_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, approver, 3);
        bytes memory sig = sign(approverKey, a);
        vm.recordLogs();
        exception(p, a, sig);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256(
            "PaymentExecuted(bytes32,address,address,uint256,bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,address,uint256,bytes32)"
        );
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault) || logs[i].topics[0] != topic) continue;
            found = true;
            assertEq(logs[i].topics.length, 4);
            assertEq(logs[i].topics[1], p.paymentId);
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(agent))));
            assertEq(logs[i].topics[3], bytes32(uint256(uint160(vendor))));
            Vault.ExecutedData memory data = abi.decode(logs[i].data, (Vault.ExecutedData));
            assertEq(data.amount, p.amount);
            assertEq(data.paymentHash, vault.hashPayment(p));
            assertEq(data.evidenceCommitment, p.evidenceCommitment);
            assertEq(data.policyVersion, p.policyVersion);
            assertEq(data.recipientVersion, p.recipientVersion);
            assertEq(data.perPaymentLimit, 1_000_000);
            assertEq(data.dailyLimit, 10_000_000);
            assertEq(data.vaultDailyLimit, 15_000_000);
            assertEq(data.day, block.timestamp / 1 days);
            assertEq(data.agentDaySpentAfter, 2_000_000);
            assertEq(data.vaultDaySpentAfter, 2_500_000);
            assertTrue(data.exception);
            assertEq(data.signer, approver);
            assertEq(data.signerVersion, a.signerVersion);
            assertEq(data.approvalDigest, vault.exceptionDigest(a));
        }
        assertTrue(found);
    }

    function test_routineEventZeroAuthorization() public {
        Vault.Payment memory p = payment(agent, 1);
        vm.recordLogs();
        pay(p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vault.ExecutedData memory data = abi.decode(logs[0].data, (Vault.ExecutedData));
        assertFalse(data.exception);
        assertEq(data.signer, address(0));
        assertEq(data.signerVersion, 0);
        assertEq(data.approvalDigest, bytes32(0));
    }

    function test_inexactTransferRollsBack() public {
        token.setFeeOnTransfer(true);
        Vault.Payment memory p = payment(agent, 1_000_000);
        vm.expectRevert(Vault.TransferFailed.selector);
        pay(p);
        assertFalse(vault.consumedPayment(p.paymentId));
        assertEq(vault.spentByDay(block.timestamp / 1 days), 0);
    }

    function test_reentrantTransferRollsBack() public {
        MockReentrantERC20 malicious = new MockReentrantERC20();
        vault = new Vault(owner, address(malicious));
        // The callback itself is an enabled agent, so caller checks cannot mask a missing lock.
        config(address(malicious), 1_000_000, 10_000_000, true);
        vm.prank(owner);
        vault.setRecipient(vendor, true);
        vm.prank(owner);
        vault.setRecipient(otherVendor, true);
        vm.prank(owner);
        vault.setVaultDailyLimit(10_000_000);
        malicious.mint(address(vault), 10_000_000);
        Vault.Payment memory p = payment(address(malicious), 1_000_000);
        p.token = address(malicious);
        Vault.Payment memory q = payment(address(malicious), 1_000_000);
        q.token = address(malicious);
        q.recipient = otherVendor;
        malicious.armTransfer(address(vault), abi.encodeCall(vault.pay, (q)));
        vm.expectRevert(Vault.TransferFailed.selector);
        pay(p);
        assertFalse(vault.consumedPayment(p.paymentId));
        assertFalse(vault.consumedPayment(q.paymentId));
        assertEq(malicious.balanceOf(vendor), 0);
        assertEq(malicious.balanceOf(otherVendor), 0);
        assertEq(vault.spentByDay(block.timestamp / 1 days), 0);
    }

    function test_pinnedFieldsAndWrongCaller() public {
        Vault.Payment memory p = payment(agent, 1);
        vm.expectRevert(Vault.NotAgent.selector);
        vault.pay(p);
        p.agent = second;
        vm.expectRevert(Vault.AgentMismatch.selector);
        vm.prank(agent);
        vault.pay(p);
        p = payment(agent, 1);
        p.token = address(0xBAD);
        vm.expectRevert(Vault.TokenMismatch.selector);
        pay(p);
        p = payment(agent, 1);
        p.policyVersion++;
        vm.expectRevert(Vault.PolicyVersionMismatch.selector);
        pay(p);
        p = payment(agent, 1);
        p.recipientVersion++;
        vm.expectRevert(Vault.RecipientVersionMismatch.selector);
        pay(p);
    }

    function test_zeroAndSelfAddresses() public {
        vm.expectRevert(Vault.ZeroAddress.selector);
        new Vault(address(0), address(token));
        vm.expectRevert(Vault.ZeroAddress.selector);
        new Vault(owner, address(0));
        vm.expectRevert(Vault.ZeroAddress.selector);
        vm.prank(owner);
        vault.configureAgent(address(0), 1, 1, expiry, true);
        vm.expectRevert(Vault.ZeroAddress.selector);
        vm.prank(owner);
        vault.setApprover(address(0), true);
        vm.expectRevert(Vault.RoleConflict.selector);
        vm.prank(owner);
        vault.setApprover(owner, true);
        vm.expectRevert(Vault.ZeroAddress.selector);
        vm.prank(owner);
        vault.setRecipient(address(0), true);
        vm.expectRevert(Vault.InvalidRecipient.selector);
        vm.prank(owner);
        vault.setRecipient(address(vault), true);
        vm.expectRevert(Vault.InvalidRecipient.selector);
        vm.prank(owner);
        vault.withdraw(address(vault), 1);
        Vault.Payment memory p = payment(agent, 0);
        vm.expectRevert(Vault.ZeroAmount.selector);
        pay(p);
    }

    function testFuzz_aggregateAndAgentBudgetsStayBounded(uint64 rawA, uint64 rawB) public {
        uint256 amountA = uint256(rawA) % 10_000_000 + 1;
        uint256 amountB = uint256(rawB) % 10_000_000 + 1;
        Vault.Payment memory p = payment(agent, amountA);
        Vault.ExceptionAuthorization memory a = auth(p, owner, 1);
        exception(p, a, sign(ownerKey, a));
        p = payment(second, amountB);
        a = auth(p, approver, 1);
        bytes memory sig = sign(approverKey, a);
        if (amountA + amountB > 15_000_000) refuse(p, a, sig, Vault.VaultDailyLimitExceeded.selector);
        else exception(p, a, sig);
        uint256 day = block.timestamp / 1 days;
        assertTrue(vault.spentByDay(day) <= 15_000_000);
        assertTrue(vault.spentByAgentDay(agent, day) <= 10_000_000);
        assertTrue(vault.spentByAgentDay(second, day) <= 10_000_000);
    }

    struct BudgetModel {
        uint256 spentA;
        uint256 spentB;
        uint256 total;
        uint256 limitA;
        uint256 limitB;
        uint256 cap;
        uint256 allPaid;
        bool enabledA;
        bool enabledB;
        bool paused;
        bool recipientAllowed;
    }

    function testFuzz_policySequencePreservesAccounting(bytes32 seed) public {
        expiry = uint64(block.timestamp + 365 days);
        config(agent, 1_000_000, 10_000_000, true);
        config(second, 1_000_000, 10_000_000, true);
        BudgetModel memory m = BudgetModel(0, 0, 0, 10_000_000, 10_000_000, 15_000_000, 0, true, true, false, true);
        for (uint256 i; i < 32; ++i) {
            uint256 entropy = uint256(keccak256(abi.encode(seed, i)));
            uint256 action = entropy % 9;
            uint256 amount = entropy / 9 % 3_000_000 + 1;
            if (action < 2) {
                modelPayment(m, action == 0, amount, i);
            } else if (action == 2) {
                m.limitA = amount;
                m.enabledA = entropy & 1 == 1;
                config(agent, 1_000_000, m.limitA, m.enabledA);
            } else if (action == 3) {
                m.limitB = amount;
                m.enabledB = entropy & 1 == 1;
                config(second, 1_000_000, m.limitB, m.enabledB);
            } else if (action == 4) {
                m.cap = amount;
                vm.prank(owner);
                vault.setVaultDailyLimit(m.cap);
            } else if (action == 5) {
                m.paused = true;
                vm.prank(owner);
                vault.pause();
            } else if (action == 6) {
                m.paused = false;
                vm.prank(owner);
                vault.unpause();
            } else if (action == 7) {
                m.recipientAllowed = entropy & 1 == 1;
                vm.prank(owner);
                vault.setRecipient(vendor, m.recipientAllowed);
            } else {
                vm.warp((block.timestamp / 1 days + 1) * 1 days);
                m.spentA = 0;
                m.spentB = 0;
                m.total = 0;
            }
            uint256 day = block.timestamp / 1 days;
            assertEq(vault.spentByAgentDay(agent, day), m.spentA);
            assertEq(vault.spentByAgentDay(second, day), m.spentB);
            assertEq(vault.spentByDay(day), m.total);
            assertEq(token.balanceOf(vendor), m.allPaid);
            assertEq(token.balanceOf(address(vault)) + m.allPaid, 100_000_000);
        }
    }

    function modelPayment(BudgetModel memory m, bool first, uint256 amount, uint256 i) internal {
        Vault.Payment memory p = payment(first ? agent : second, amount);
        Vault.ExceptionAuthorization memory a = auth(p, owner, i);
        bytes memory sig = sign(ownerKey, a);
        uint256 spent = first ? m.spentA : m.spentB;
        uint256 limit = first ? m.limitA : m.limitB;
        bool expected = (first ? m.enabledA : m.enabledB) && !m.paused && m.recipientAllowed && spent + amount <= limit
            && m.total + amount <= m.cap;
        vm.prank(p.agent);
        (bool ok,) = address(vault).call(abi.encodeCall(vault.payWithException, (p, a, sig)));
        assertTrue(ok == expected);
        assertTrue(vault.consumedPayment(p.paymentId) == expected);
        assertTrue(vault.consumedApprovalNonce(owner, i) == expected);
        if (ok) {
            if (first) m.spentA += amount;
            else m.spentB += amount;
            m.total += amount;
            m.allPaid += amount;
        }
    }

    function test_failedTransferRetryKeepsExactPaymentAndNonce() public {
        MockFailingERC20 bad = new MockFailingERC20();
        vault = new Vault(owner, address(bad));
        bad.mint(address(vault), 10_000_000);
        config(agent, 1, 10_000_000, true);
        vm.prank(owner);
        vault.setRecipient(vendor, true);
        vm.prank(owner);
        vault.setVaultDailyLimit(10_000_000);
        Vault.Payment memory p = payment(agent, 2_000_000);
        p.token = address(bad);
        Vault.ExceptionAuthorization memory a = auth(p, owner, 1);
        bytes memory sig = sign(ownerKey, a);
        bad.setMode(MockFailingERC20.Mode.ReturnFalse);
        refuse(p, a, sig, Vault.TransferFailed.selector);
        bad.setMode(MockFailingERC20.Mode.Revert);
        refuse(p, a, sig, Vault.TransferFailed.selector);
        bad.setMode(MockFailingERC20.Mode.Normal);
        exception(p, a, sig);
        assertEq(bad.balanceOf(vendor), 2_000_000);
        assertEq(vault.spentByDay(block.timestamp / 1 days), 2_000_000);
        assertTrue(vault.consumedApprovalNonce(owner, 1));
        refuse(p, a, sig, Vault.PaymentAlreadyUsed.selector);
    }

    function test_everyPaymentFieldChangesItsHash() public {
        Vault.Payment memory p = payment(agent, 2_000_000);
        Vault.ExceptionAuthorization memory a = auth(p, approver, 7);
        bytes memory sig = sign(approverKey, a);
        p.paymentId = keccak256("another-id");
        refuse(p, a, sig, Vault.PaymentHashMismatch.selector);
        p = payment(agent, 2_000_000);
        a = auth(p, approver, 7);
        sig = sign(approverKey, a);
        p.validUntil++;
        refuse(p, a, sig, Vault.PaymentHashMismatch.selector);
        a = auth(p, approver, 7);
        sig = sign(approverKey, a);
        a.signerVersion++;
        refuse(p, a, sig, Vault.SignerVersionMismatch.selector);
    }

    function test_policyAndAuthorizationExactExpiryAreInclusive() public {
        expiry = uint64(block.timestamp);
        config(agent, 1, 10_000_000, true);
        Vault.Payment memory p = payment(agent, 2_000_000);
        p.validUntil = expiry;
        Vault.ExceptionAuthorization memory a = auth(p, owner, 1);
        a.authorizationExpiry = expiry;
        exception(p, a, sign(ownerKey, a));
        vm.warp(uint256(expiry) + 1);
        p = payment(agent, 1);
        vm.expectRevert(Vault.PolicyExpired.selector);
        pay(p);
    }
}
