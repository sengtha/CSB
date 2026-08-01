// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts-v4/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts-v4/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts-v4/token/ERC20/extensions/ERC4626.sol";
import {AccessControl} from "@openzeppelin/contracts-v4/access/AccessControl.sol";
import {IdentityRegistry} from "../identity/IdentityRegistry.sol";
import {EnforcementRegistry} from "../enforcement/EnforcementRegistry.sol";

/**
 * @title CompliantKHRtVault
 * @notice The control for `KHRtVault`: identical vault, gated share.
 *
 * EVALUATION ARTIFACT. Its only purpose is to be compared against `KHRtVault`,
 * which is the same ERC-4626 over the same asset with nothing added. Every other
 * experiment in this repository demonstrates that a claim on a gated asset escapes
 * the perimeter. This one asks the next question: can the perimeter be extended to
 * the claim, and what does that cost?
 *
 * THE FIX, ENTIRELY. One hook, mirroring `KHRStablecoin._update` exactly — not
 * frozen, and either attested or council-vetted — applied to the SHARE rather than
 * to the asset. That is the whole difference between the two contracts.
 *
 * It closes three things the base-layer perimeter could not reach:
 *
 *   - transfer of the share to an unattested address;
 *   - `deposit`/`mint` naming an unattested `receiver`, which hands the claim over
 *     in a single call and which no rule about transaction senders could ever
 *     see, because the unattested party never sends anything;
 *   - onward circulation once a claim has escaped.
 *
 * WHAT IT COSTS, AND WHY THAT IS THE POINT. Gating the share makes it useless to
 * any protocol that has not been individually exempted: a Uniswap pair holding
 * these shares would revert, so would an Aave reserve listing them. Composability
 * is restored only by the council granting `setSystemContract` per counterparty —
 * the same discretionary, after-the-fact grant that Uniswap's pair, Aave's pool
 * and Aave's aToken each needed, now required one level further out. The
 * exemption mechanism is deliberately kept so this cost can be measured rather
 * than asserted.
 *
 * WHAT IT IS NOT. This is not a fix for third-party protocols. It works because
 * the vault is ours to write. Nothing here can be applied to Uniswap's pair or
 * Aave's aToken without forking them, which forfeits the "unmodified" property the
 * architecture's central claim rests on. The remedy is available exactly where the
 * state controls the code, and unavailable exactly where composability is the
 * reason for having an open contract layer.
 */
contract CompliantKHRtVault is ERC4626, AccessControl {
    IdentityRegistry public immutable identity;
    EnforcementRegistry public immutable enforcement;

    /// @notice Contracts vetted to hold shares without a personal attestation.
    mapping(address => bool) public isSystemContract;

    error NotKycActive(address account);
    error AccountFrozen(address account);

    event SystemContractSet(address indexed account, bool allowed);

    constructor(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        IdentityRegistry identity_,
        EnforcementRegistry enforcement_,
        address council
    ) ERC4626(asset_) ERC20(name_, symbol_) {
        identity = identity_;
        enforcement = enforcement_;
        _grantRole(DEFAULT_ADMIN_ROLE, council);
    }

    /// @notice Exempt a contract from the share's compliance rule. Council only.
    function setSystemContract(address account, bool allowed)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        isSystemContract[account] = allowed;
        emit SystemContractSet(account, allowed);
    }

    /**
     * @dev The entire fix. Deliberately the same rule KHRStablecoin applies to the
     *      asset, so that a difference in outcome between this vault and
     *      `KHRtVault` is attributable to the rule's PLACEMENT and to nothing else.
     *
     *      Mint and burn endpoints are exempt in the usual way — address(0) is not
     *      an account — but note that on a mint the RECEIVER is still checked,
     *      which is what closes the single-call handover.
     */
    function _beforeTokenTransfer(address from, address to, uint256 amount)
        internal
        override
    {
        super._beforeTokenTransfer(from, to, amount);
        if (from != address(0)) _requireEligible(from);
        if (to != address(0)) _requireEligible(to);
    }

    function _requireEligible(address account) private view {
        if (enforcement.isFrozen(account)) revert AccountFrozen(account);
        if (!isSystemContract[account] && !identity.isActive(account)) {
            revert NotKycActive(account);
        }
    }
}
