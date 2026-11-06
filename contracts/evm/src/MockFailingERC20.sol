// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title MockFailingERC20
/// @notice A token whose `transfer` can return false without moving funds or revert, for rollback tests.
contract MockFailingERC20 {
    enum Mode {
        Normal,
        ReturnFalse,
        Revert
    }

    Mode public mode;
    mapping(address => uint256) public balanceOf;

    function setMode(Mode newMode) external {
        mode = newMode;
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        if (mode == Mode.ReturnFalse) return false;
        if (mode == Mode.Revert) revert("transfer disabled");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}
