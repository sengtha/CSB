// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {INativeMinter} from "../interfaces/INativeMinter.sol";

/**
 * @title MockNativeMinter
 * @notice Test stand-in for the Native Minter precompile. A local Hardhat node
 *         has no precompile, so this "mints" by paying out native coin from a
 *         pre-funded balance. Fund it with ETH in tests. NOT for production —
 *         on CSB the real precompile at 0x…01 mints true native tRIEL.
 */
contract MockNativeMinter is INativeMinter {
    receive() external payable {}

    function mintNativeCoin(address addr, uint256 amount) external override {
        (bool ok, ) = addr.call{value: amount}("");
        require(ok, "mock mint transfer failed");
    }
}
