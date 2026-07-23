// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title EnforcementRegistry
 * @notice Asset-enforcement powers (freezing), held by the judicial/AML
 *         authority — deliberately a separate contract under a separate
 *         authority from IdentityRegistry (MoI).
 *
 * Separation of powers, in code:
 *  - MoI can revoke an identity (stops new activity) but cannot freeze or
 *    seize assets.
 *  - The enforcement authority can freeze assets but cannot touch identity.
 *  - Every freeze must carry an order reference (court order / AML case id),
 *    making enforcement auditable by construction.
 */
contract EnforcementRegistry is AccessControl {
    bytes32 public constant ENFORCER_ROLE = keccak256("ENFORCER_ROLE");

    mapping(address => bool) private _frozen;

    event Frozen(address indexed account, bytes32 indexed orderRef);
    event Unfrozen(address indexed account, bytes32 indexed orderRef);

    error OrderRefRequired();

    constructor(address councilAdmin, address enforcementAuthority) {
        _grantRole(DEFAULT_ADMIN_ROLE, councilAdmin);
        _grantRole(ENFORCER_ROLE, enforcementAuthority);
    }

    function freeze(address account, bytes32 orderRef) external onlyRole(ENFORCER_ROLE) {
        if (orderRef == bytes32(0)) revert OrderRefRequired();
        _frozen[account] = true;
        emit Frozen(account, orderRef);
    }

    function unfreeze(address account, bytes32 orderRef) external onlyRole(ENFORCER_ROLE) {
        if (orderRef == bytes32(0)) revert OrderRefRequired();
        _frozen[account] = false;
        emit Unfrozen(account, orderRef);
    }

    function isFrozen(address account) external view returns (bool) {
        return _frozen[account];
    }
}
