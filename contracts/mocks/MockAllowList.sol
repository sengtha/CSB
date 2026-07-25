// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockAllowList
 * @notice Test stand-in for the Subnet-EVM allow-list precompiles
 *         (txAllowList at 0x…02, contractDeployerAllowList at 0x…00).
 *
 *         A local Hardhat node has no precompiles, so anything that reads or
 *         writes an allow list — the admin console's Chain access tab, the
 *         onboarding scripts — cannot be exercised there. Install this at the
 *         precompile addresses with hardhat_setCode to test that path locally.
 *
 *         It only models the roles CSB uses: 0 none, 1 enabled, 2 admin,
 *         3 manager. NOT for production — the real precompile also gates who
 *         may call these setters, which this deliberately does not.
 */
contract MockAllowList {
    mapping(address => uint256) private _role;

    function setEnabled(address addr) external { _role[addr] = 1; }
    function setNone(address addr) external { _role[addr] = 0; }
    function setAdmin(address addr) external { _role[addr] = 2; }
    function setManager(address addr) external { _role[addr] = 3; }

    function readAllowList(address addr) external view returns (uint256) {
        return _role[addr];
    }
}
