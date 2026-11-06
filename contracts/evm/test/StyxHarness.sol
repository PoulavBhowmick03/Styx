// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {StyxCodec} from "../src/StyxCodec.sol";

/// @title StyxHarness
/// @notice External wrappers over the internal codec so tests can use `vm.expectRevert` and
///         `try/catch`, which need an external call boundary.
contract StyxHarness {
    function decodeOk(bytes memory terms) external pure returns (bool) {
        StyxCodec.decode(terms);
        return true;
    }

    function commitment(bytes memory terms, bytes32 blinding) external pure returns (bytes32) {
        return StyxCodec.commitment(terms, blinding);
    }

    function dealNullifier(bytes memory terms) external pure returns (bytes32) {
        StyxCodec.Terms memory decoded = StyxCodec.decode(terms);
        bytes memory domain = StyxCodec.domainSlice(terms, decoded);
        return StyxCodec.dealNullifier(domain, decoded.buyer, decoded.settlementNonce);
    }

    function authorizationDigest(bytes memory terms, uint8 roleTag, bytes32 blinding) external pure returns (bytes32) {
        StyxCodec.Terms memory decoded = StyxCodec.decode(terms);
        bytes memory domain = StyxCodec.domainSlice(terms, decoded);
        bytes32 dealCommitment = StyxCodec.commitment(terms, blinding);
        return StyxCodec.authorizationDigest(domain, roleTag, dealCommitment);
    }

    function assetToken(string memory asset, string memory expectedNamespace) external pure returns (address) {
        return StyxCodec.parseAssetToken(asset, expectedNamespace);
    }
}
