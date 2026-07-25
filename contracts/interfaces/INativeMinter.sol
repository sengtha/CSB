// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title INativeMinter
 * @notice Minimal interface to the Subnet-EVM Native Minter precompile
 *         (0x0200000000000000000000000000000000000001). On CSB the native coin
 *         is tRIEL; minting is riel-pegged base-money issuance and is restricted
 *         to allow-listed callers (the RielConverter is added to that allow list
 *         so it can mint tRIEL only against locked tokenized-riel collateral).
 */
interface INativeMinter {
    function mintNativeCoin(address addr, uint256 amount) external;
}
