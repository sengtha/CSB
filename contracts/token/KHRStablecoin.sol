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

    /**
     * @notice Optional flat public-good levy taken on each ordinary transfer and
     *         routed to `levyRecipient` (e.g. a hospital charity). OFF by default
     *         (`transferLevy == 0`) so the token is fee-free until the council
     *         switches it on. 1 KHRt = 1 riel, so a levy of `1_00` sends 1 riel
     *         of every payment to the fund. Exempt flows: mint/burn, enforcement,
     *         system contracts, the recipient's own transfers, and `levyExempt`
     *         accounts. Transfers at or below the levy are not taxed.
     */
    uint256 public transferLevy;
    address public levyRecipient;
    mapping(address => bool) public levyExempt;
    uint256 public totalLevied;

    event Issued(address indexed to, uint256 amount);
    event Redeemed(address indexed from, uint256 amount);
    event Confiscated(address indexed from, address indexed to, uint256 amount, bytes32 indexed orderRef);
    event TierTransferCapSet(uint8 indexed tier, uint256 cap);
    event SystemContractSet(address indexed account, bool allowed);
    event TransferLevySet(uint256 levy, address indexed recipient);
    event LevyExemptSet(address indexed account, bool exempt);
    event LevyCollected(address indexed from, address indexed recipient, uint256 amount);

    error NotKycActive(address account);
    error AccountFrozen(address account);
    error TierCapExceeded(address account, uint8 tier, uint256 cap, uint256 amount);
    error OrderRefRequired();
    error LevyRecipientRequired();

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

    /// @notice Council sets the flat per-transfer public-good levy and its
    ///         recipient. `levy == 0` disables it. Amount is in KHRt units
    ///         (2 decimals): `1_00` = 1.00 KHRt = 1 riel per transfer.
    function setTransferLevy(uint256 levy, address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (levy > 0 && recipient == address(0)) revert LevyRecipientRequired();
        transferLevy = levy;
        levyRecipient = recipient;
        emit TransferLevySet(levy, recipient);
    }

    /// @notice Exempt an account (payer or payee) from the transfer levy —
    ///         e.g. keep citizen-to-citizen payments free while merchants are levied.
    function setLevyExempt(address account, bool exempt) external onlyRole(DEFAULT_ADMIN_ROLE) {
        levyExempt[account] = exempt;
        emit LevyExemptSet(account, exempt);
    }

    /// @dev The levy applied to a (from,to,value) transfer; 0 for exempt flows.
    function _levyOn(address from, address to, uint256 value) private view returns (uint256) {
        if (transferLevy == 0 || levyRecipient == address(0)) return 0;
        if (_inEnforcement) return 0;                       // enforcement moves untaxed
        if (from == address(0) || to == address(0)) return 0; // mint / burn untaxed
        if (from == levyRecipient || to == levyRecipient) return 0; // fund's own flows
        if (levyExempt[from] || levyExempt[to]) return 0;
        if (isSystemContract[from] || isSystemContract[to]) return 0; // bridges/converter
        if (value <= transferLevy) return 0;                // don't zero-out tiny transfers
        return transferLevy;
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
        uint256 levy = _levyOn(from, to, value);
        if (levy > 0) {
            super._update(from, levyRecipient, levy);   // public-good slice to the fund
            super._update(from, to, value - levy);      // remainder to the payee
            totalLevied += levy;
            emit LevyCollected(from, levyRecipient, levy);
        } else {
            super._update(from, to, value);
        }
    }

    function _requireEligible(address account) private view {
        if (enforcement.isFrozen(account)) revert AccountFrozen(account);
        if (!isSystemContract[account] && !identity.isActive(account)) revert NotKycActive(account);
    }
}
