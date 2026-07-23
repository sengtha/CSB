// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBridgeAdapter} from "./IBridgeAdapter.sol";
import {IERC20TokenTransferrer, SendTokensInput} from "./interfaces/IERC20TokenTransferrer.sol";

/**
 * @title ICTTBridgeAdapter
 * @notice Production transport adapter: bridges a single ERC20 out of CSB via
 *         Avalanche ICTT (an ERC20TokenHome deployed on CSB, paired with
 *         TokenRemote contracts on destination chains such as the Fuji/mainnet
 *         C-Chain).
 *
 *  - One adapter per token; the EgressGateway is the only caller.
 *  - Routes (destination chain -> TokenRemote address) are configured by the
 *    council, so even at the transport layer only council-approved
 *    destinations are reachable.
 *  - CSB has no fee market, so ICTT primary/secondary fees are zero; the ICM
 *    relayer is operated by the state.
 *
 * Deployment notes (see docs/fuji-ictt.md): both this adapter and the
 * ERC20TokenHome must be marked as system contracts on KHRStablecoin, since
 * neither holds a personal KYC attestation.
 */
contract ICTTBridgeAdapter is IBridgeAdapter, Ownable {
    using SafeERC20 for IERC20;

    struct Route {
        bytes32 destinationBlockchainID; // Avalanche blockchainID (hex) of the destination
        address remoteTransferrer; // TokenRemote on the destination chain
        uint256 requiredGasLimit; // gas for delivery on the destination
    }

    address public immutable token;
    IERC20TokenTransferrer public immutable tokenHome;
    address public gateway;

    /// @notice Keyed by the gateway's logical destination-chain identifier.
    mapping(bytes32 => Route) public routes;

    event GatewaySet(address indexed gateway);
    event RouteSet(
        bytes32 indexed destinationChain,
        bytes32 destinationBlockchainID,
        address remoteTransferrer,
        uint256 requiredGasLimit
    );
    event BridgeSend(
        address indexed token,
        uint256 amount,
        bytes32 indexed destinationChain,
        address recipient,
        address indexed initiator
    );

    error OnlyGateway();
    error TokenMismatch(address token);
    error RouteNotConfigured(bytes32 destinationChain);
    error BadRecipient(bytes recipient);

    constructor(address token_, IERC20TokenTransferrer tokenHome_, address owner_) Ownable(owner_) {
        token = token_;
        tokenHome = tokenHome_;
    }

    function setGateway(address gateway_) external onlyOwner {
        gateway = gateway_;
        emit GatewaySet(gateway_);
    }

    function setRoute(
        bytes32 destinationChain,
        bytes32 destinationBlockchainID,
        address remoteTransferrer,
        uint256 requiredGasLimit
    ) external onlyOwner {
        routes[destinationChain] = Route({
            destinationBlockchainID: destinationBlockchainID,
            remoteTransferrer: remoteTransferrer,
            requiredGasLimit: requiredGasLimit
        });
        emit RouteSet(destinationChain, destinationBlockchainID, remoteTransferrer, requiredGasLimit);
    }

    /// @inheritdoc IBridgeAdapter
    function bridge(
        address token_,
        uint256 amount,
        bytes32 destinationChain,
        bytes calldata recipient,
        address initiator
    ) external override {
        if (msg.sender != gateway) revert OnlyGateway();
        if (token_ != token) revert TokenMismatch(token_);

        Route memory r = routes[destinationChain];
        if (r.remoteTransferrer == address(0)) revert RouteNotConfigured(destinationChain);
        if (recipient.length != 20) revert BadRecipient(recipient);
        address recipientAddr = address(bytes20(recipient));

        IERC20(token).forceApprove(address(tokenHome), amount);
        tokenHome.send(
            SendTokensInput({
                destinationBlockchainID: r.destinationBlockchainID,
                destinationTokenTransferrerAddress: r.remoteTransferrer,
                recipient: recipientAddr,
                primaryFeeTokenAddress: address(0),
                primaryFee: 0,
                secondaryFee: 0,
                requiredGasLimit: r.requiredGasLimit,
                multiHopFallback: address(0)
            }),
            amount
        );

        emit BridgeSend(token_, amount, destinationChain, recipientAddr, initiator);
    }
}
