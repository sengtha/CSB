// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice Minimal interface of Avalanche ICTT's ERC20 token transferrer
 *         (ERC20TokenHome), mirrored from ava-labs/icm-contracts so the
 *         adapter compiles without vendoring the full ICM dependency tree.
 *         Struct layout matches icm-contracts' ITokenTransferrer exactly.
 */
struct SendTokensInput {
    bytes32 destinationBlockchainID;
    address destinationTokenTransferrerAddress;
    address recipient;
    address primaryFeeTokenAddress;
    uint256 primaryFee;
    uint256 secondaryFee;
    uint256 requiredGasLimit;
    address multiHopFallback;
}

interface IERC20TokenTransferrer {
    function send(SendTokensInput calldata input, uint256 amount) external;
}
