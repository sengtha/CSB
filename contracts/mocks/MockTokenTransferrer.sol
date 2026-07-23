// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20TokenTransferrer, SendTokensInput} from "../egress/interfaces/IERC20TokenTransferrer.sol";

/// @notice Test double for an ICTT ERC20TokenHome: pulls the approved tokens
///         (as the real TokenHome does) and records the send input.
contract MockTokenTransferrer is IERC20TokenTransferrer {
    using SafeERC20 for IERC20;

    address public immutable token;
    SendTokensInput public lastInput;
    uint256 public lastAmount;
    uint256 public sendCount;

    constructor(address token_) {
        token = token_;
    }

    function send(SendTokensInput calldata input, uint256 amount) external override {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        lastInput = input;
        lastAmount = amount;
        sendCount += 1;
    }
}
