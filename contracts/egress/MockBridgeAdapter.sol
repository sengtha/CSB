// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBridgeAdapter} from "./IBridgeAdapter.sol";

/**
 * @title MockBridgeAdapter
 * @notice Devnet stand-in for the Avalanche ICTT adapter. Escrows the bridged
 *         tokens and emits the send event; `release` simulates the return path.
 *         Replaced in production by an adapter wrapping an ICTT TokenHome.
 */
contract MockBridgeAdapter is IBridgeAdapter, Ownable {
    using SafeERC20 for IERC20;

    address public gateway;

    event BridgeSend(
        address indexed token,
        uint256 amount,
        bytes32 indexed destinationChain,
        bytes recipient,
        address indexed initiator
    );

    error OnlyGateway();

    constructor(address owner_) Ownable(owner_) {}

    function setGateway(address gateway_) external onlyOwner {
        gateway = gateway_;
    }

    function bridge(
        address token,
        uint256 amount,
        bytes32 destinationChain,
        bytes calldata recipient,
        address initiator
    ) external override {
        if (msg.sender != gateway) revert OnlyGateway();
        emit BridgeSend(token, amount, destinationChain, recipient, initiator);
    }

    /// @notice Simulate the inbound (return) path on the devnet.
    function release(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }
}
