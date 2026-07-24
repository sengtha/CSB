// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IdentityRegistry} from "../identity/IdentityRegistry.sol";
import {EnforcementRegistry} from "../enforcement/EnforcementRegistry.sol";

/**
 * @title KHRStablecoin
 * @notice Tokenized Khmer Riel with a pluggable issuer slot.
 *
 *  - The issuer (minter/burner) is a role, not a hardcoded institution: a central bank, a
 *    licensed bank consortium, or a treasury-backed entity can hold ISSUER_ROLE
 *    when the mandate is decided — the rails don't change.
 *  - Every transfer requires both parties to hold an active Identity Authority KYC attestation
 *    and to not be frozen by the enforcement authority.
 *  - Tier-based per-transfer caps (e.g. citizen-basic accounts capped) are
 *    configurable by the chain governor.
 *  - Confiscation is an enforcement power: it requires ENFORCER_ROLE and a
 *    court/AML order reference, and works on frozen accounts.
 */
contract KHRStablecoin is ERC20, AccessControl {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant ENFORCER_ROLE = keccak256("ENFORCER_ROLE");

    IdentityRegistry public immutable identity;
    EnforcementRegistry public immutable enforcement;

    /// @notice Per-transfer cap by KYC tier, in token units. 0 = unlimited.
    mapping(uint8 => uint256) public tierTransferCap;

    /**
     * @notice Council-vetted contracts (bridge adapters, DEX pools, escrows)
     *         that may hold and move KHRt without a personal KYC attestation.
     *         They remain subject to enforcement freezes.
     */
    mapping(address => bool) public isSystemContract;

    bool private _inEnforcement;

    event Issued(address indexed to, uint256 amount);
    event Redeemed(address indexed from, uint256 amount);
    event Confiscated(address indexed from, address indexed to, uint256 amount, bytes32 indexed orderRef);
    event TierTransferCapSet(uint8 indexed tier, uint256 cap);
    event SystemContractSet(address indexed account, bool allowed);

    error NotKycActive(address account);
    error AccountFrozen(address account);
    error TierCapExceeded(address account, uint8 tier, uint256 cap, uint256 amount);
    error OrderRefRequired();

    constructor(IdentityRegistry identity_, EnforcementRegistry enforcement_, address councilAdmin, address issuer)
        ERC20("Khmer Riel Token", "KHRt")
    {
        identity = identity_;
        enforcement = enforcement_;
        _grantRole(DEFAULT_ADMIN_ROLE, councilAdmin);
        _grantRole(ISSUER_ROLE, issuer);
    }

    /// @dev Riel has no circulating subunit; 2 decimals follow fiat-token convention.
    function decimals() public pure override returns (uint8) {
        return 2;
    }

    // ---------------------------------------------------------------- issuance

    function issue(address to, uint256 amount) external onlyRole(ISSUER_ROLE) {
        _mint(to, amount);
        emit Issued(to, amount);
    }

    /// @notice Issuer burns from its own balance (off-chain redemption settled 1:1).
    function redeem(uint256 amount) external onlyRole(ISSUER_ROLE) {
        _burn(_msgSender(), amount);
        emit Redeemed(_msgSender(), amount);
    }

    // ------------------------------------------------------------- enforcement

    /**
     * @notice Move assets out of an account under a court/AML order. Bypasses
     *         KYC/freeze transfer checks so it works on frozen accounts.
     */
    function confiscate(address from, address to, uint256 amount, bytes32 orderRef)
        external
        onlyRole(ENFORCER_ROLE)
    {
        if (orderRef == bytes32(0)) revert OrderRefRequired();
        _inEnforcement = true;
        _update(from, to, amount);
        _inEnforcement = false;
        emit Confiscated(from, to, amount, orderRef);
    }

    // -------------------------------------------------------------- governance

    function setTierTransferCap(uint8 tier, uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        tierTransferCap[tier] = cap;
        emit TierTransferCapSet(tier, cap);
    }

    function setSystemContract(address account, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        isSystemContract[account] = allowed;
        emit SystemContractSet(account, allowed);
    }

    // -------------------------------------------------------------- compliance

    function _update(address from, address to, uint256 value) internal override {
        if (!_inEnforcement) {
            if (from != address(0)) {
                _requireEligible(from);
                if (!isSystemContract[from]) {
                    uint8 tier = identity.tierOf(from);
                    uint256 cap = tierTransferCap[tier];
                    if (cap != 0 && value > cap) revert TierCapExceeded(from, tier, cap, value);
                }
            }
            if (to != address(0)) {
                _requireEligible(to);
            }
        }
        super._update(from, to, value);
    }

    function _requireEligible(address account) private view {
        if (enforcement.isFrozen(account)) revert AccountFrozen(account);
        if (!isSystemContract[account] && !identity.isActive(account)) revert NotKycActive(account);
    }
}
