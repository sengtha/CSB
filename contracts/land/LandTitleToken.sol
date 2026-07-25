// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IdentityRegistry} from "../identity/IdentityRegistry.sol";
import {EnforcementRegistry} from "../enforcement/EnforcementRegistry.sol";

/**
 * @title LandTitleToken
 * @notice One tokenized land parcel, following the ERC-3643 (T-REX) permissioned
 *         token model.
 *
 * Supply is the parcel divided into shares: 10,000 shares = 100% of the parcel,
 * so a holder with 2,500 owns a quarter. Fractional ownership is what makes the
 * token useful as collateral — a lender can take a partial claim without the
 * parcel having to be sold or subdivided in the cadastre.
 *
 * ERC-3643 in CSB's context:
 *  - The standard expects an identity registry deciding who may hold the token.
 *    CSB already HAS a national one, so this plugs into `IdentityRegistry`
 *    rather than standing up a parallel identity system. That is the whole
 *    argument for doing this on a sovereign chain: the KYC layer already exists
 *    and is authoritative, so a security token gets compliance for free instead
 *    of bolting on a private allowlist.
 *  - Transfers are checked, not merely discouraged: an unverified or frozen
 *    address cannot receive shares at all, so an off-chain trade that the
 *    registry has not sanctioned simply cannot settle.
 *  - The agent powers (forced transfer, freeze, recovery) exist because land is
 *    subject to courts. A title system that could not execute a judgment, or
 *    recover a title whose owner lost their key, would not be usable for real
 *    property regardless of how clean the cryptography was.
 *
 * PLACEHOLDER: the "land authority" is a hypothetical regulated registrar. This
 * is a design study — no real cadastre, ministry, or title is represented, and
 * nothing here confers ownership of anything.
 */
contract LandTitleToken is ERC20, AccessControl {
    /// @notice ERC-3643 "agent": the regulated registrar operating this title.
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    IdentityRegistry public immutable identity;
    EnforcementRegistry public immutable enforcement;

    /// @notice Cadastral reference for the parcel this token represents.
    bytes32 public immutable parcelId;
    /// @notice Hash/URI of the authoritative off-chain title document. The deed
    ///         remains the legal instrument; this is a pointer to it, not a
    ///         replacement for it.
    string public titleURI;

    /// @notice Minimum KYC tier required to hold shares (land is not tier-1 retail).
    uint8 public minimumTier;

    bool public paused;

    /// @notice Shares locked in place without freezing the whole account —
    ///         e.g. pledged as collateral, or subject to a disputed claim.
    mapping(address => uint256) public frozenShares;
    mapping(address => bool) public addressFrozen;

    /**
     * @notice Contracts the registrar permits to custody shares — a collateral
     *         vault, an escrow, a co-ownership pool.
     *
     * A contract has no national identity to verify, so without this it could
     * never hold a title and the token could only ever sit in personal wallets.
     * That would make the collateral story impossible. Note what it is NOT: an
     * exemption from the rules, since the vault can only ever release shares
     * back to an address that passes the same checks. And note who decides — the
     * registrar, not the vault's author. Anyone may write a lending protocol
     * against these titles, but a registrar still says which custodians may hold
     * land. For real property that is the honest arrangement; "permissionless
     * custody of land title" is not a thing any cadastre would recognise.
     */
    mapping(address => bool) public approvedCustodian;

    event TitleURISet(string titleURI);
    event MinimumTierSet(uint8 tier);
    event Paused(bool paused);
    event AddressFrozenSet(address indexed account, bool frozen);
    event ApprovedCustodianSet(address indexed account, bool approved);
    event SharesFrozen(address indexed account, uint256 amount);
    event SharesUnfrozen(address indexed account, uint256 amount);
    event ForcedTransfer(address indexed from, address indexed to, uint256 amount, bytes32 indexed orderRef);
    event RecoverySucceeded(address indexed lost, address indexed replacement, uint256 amount, bytes32 indexed orderRef);

    error TokenPaused();
    error NotVerified(address account);
    error TierTooLow(address account, uint8 tier, uint8 required);
    error AccountFrozen(address account);
    error SharesLocked(address account, uint256 frozen, uint256 available, uint256 requested);
    error OrderRefRequired();
    error SameAddress();

    /// @dev Grouped into a struct because nine constructor arguments exhaust the
    ///      EVM stack. Passing one memory pointer instead keeps this compiling
    ///      without switching the whole project to the IR pipeline, which would
    ///      change the bytecode of every already-deployed contract.
    struct Config {
        string name;
        string symbol;
        bytes32 parcelId;
        string titleURI;
        uint8 minimumTier;
        IdentityRegistry identity;
        EnforcementRegistry enforcement;
        address authorityAdmin;
        address agent;
        address firstOwner;
        uint256 initialShares;
    }

    /**
     * @dev The initial shares are minted here rather than by a follow-up call,
     *      so the deploying registry never needs agent powers over the title it
     *      creates — it would otherwise have to hold AGENT_ROLE briefly and give
     *      it up, leaving a window where a factory contract could move somebody's
     *      land. The first owner is still checked against the identity layer,
     *      because `_mint` runs the same compliance path as any transfer.
     */
    constructor(Config memory c) ERC20(c.name, c.symbol) {
        parcelId = c.parcelId;
        titleURI = c.titleURI;
        minimumTier = c.minimumTier;
        identity = c.identity;
        enforcement = c.enforcement;
        _grantRole(DEFAULT_ADMIN_ROLE, c.authorityAdmin);
        _grantRole(AGENT_ROLE, c.agent);
        if (c.initialShares > 0) _mint(c.firstOwner, c.initialShares);
    }

    /// @dev Shares are whole units — a parcel is divided into a fixed count, not
    ///      an arbitrarily divisible quantity.
    function decimals() public pure override returns (uint8) {
        return 0;
    }

    // ----------------------------------------------------------- agent powers

    function mint(address to, uint256 shares) external onlyRole(AGENT_ROLE) {
        _mint(to, shares);
    }

    function burn(address from, uint256 shares) external onlyRole(AGENT_ROLE) {
        _burn(from, shares);
    }

    /**
     * @notice Move shares regardless of the holder's consent, under a court or
     *         registry order. Bypasses freezes — a judgment must be executable
     *         against exactly the accounts that have been frozen.
     */
    function forcedTransfer(address from, address to, uint256 shares, bytes32 orderRef)
        external
        onlyRole(AGENT_ROLE)
    {
        if (orderRef == bytes32(0)) revert OrderRefRequired();
        _requireCanHold(to);
        // Release any lock standing in the way, up to the amount being moved.
        uint256 locked = frozenShares[from];
        if (locked > 0) {
            uint256 free = balanceOf(from) - locked;
            if (shares > free) {
                uint256 release = shares - free;
                frozenShares[from] = locked - release;
                emit SharesUnfrozen(from, release);
            }
        }
        _inForcedMove = true;
        _update(from, to, shares);
        _inForcedMove = false;
        emit ForcedTransfer(from, to, shares, orderRef);
    }

    /**
     * @notice Reissue a holding to a replacement address — the ERC-3643 recovery
     *         path, for a lost or compromised key.
     * @dev Requires the replacement to belong to the SAME registered identity.
     *      Without that check, recovery would be a back door for transferring
     *      title to anyone the agent chose.
     */
    function recoveryAddress(address lost, address replacement, bytes32 orderRef) external onlyRole(AGENT_ROLE) {
        if (orderRef == bytes32(0)) revert OrderRefRequired();
        if (lost == replacement) revert SameAddress();
        bytes32 lostId = identity.attestationOf(lost).identity;
        if (lostId == bytes32(0) || identity.attestationOf(replacement).identity != lostId) {
            revert NotVerified(replacement);
        }

        uint256 amount = balanceOf(lost);
        uint256 locked = frozenShares[lost];
        frozenShares[lost] = 0;
        _inForcedMove = true;
        _update(lost, replacement, amount);
        _inForcedMove = false;
        if (locked > 0) {
            frozenShares[replacement] = locked; // a pledge survives the key change
            emit SharesFrozen(replacement, locked);
        }
        emit RecoverySucceeded(lost, replacement, amount, orderRef);
    }

    function setAddressFrozen(address account, bool frozen) external onlyRole(AGENT_ROLE) {
        addressFrozen[account] = frozen;
        emit AddressFrozenSet(account, frozen);
    }

    /// @notice Lock part of a holding in place — used by a collateral vault, or
    ///         while a boundary dispute is before a court.
    function freezeShares(address account, uint256 amount) external onlyRole(AGENT_ROLE) {
        uint256 next = frozenShares[account] + amount;
        if (next > balanceOf(account)) revert SharesLocked(account, frozenShares[account], balanceOf(account), amount);
        frozenShares[account] = next;
        emit SharesFrozen(account, amount);
    }

    function unfreezeShares(address account, uint256 amount) external onlyRole(AGENT_ROLE) {
        uint256 locked = frozenShares[account];
        if (amount > locked) revert SharesLocked(account, locked, locked, amount);
        frozenShares[account] = locked - amount;
        emit SharesUnfrozen(account, amount);
    }

    // ------------------------------------------------------------- governance

    function setTitleURI(string calldata uri) external onlyRole(DEFAULT_ADMIN_ROLE) {
        titleURI = uri;
        emit TitleURISet(uri);
    }

    function setMinimumTier(uint8 tier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minimumTier = tier;
        emit MinimumTierSet(tier);
    }

    /// @notice Permit (or withdraw permission from) a contract to custody shares.
    function setApprovedCustodian(address account, bool approved) external onlyRole(DEFAULT_ADMIN_ROLE) {
        approvedCustodian[account] = approved;
        emit ApprovedCustodianSet(account, approved);
    }

    function setPaused(bool paused_) external onlyRole(AGENT_ROLE) {
        paused = paused_;
        emit Paused(paused_);
    }

    // ------------------------------------------------------------- compliance

    bool private _inForcedMove;

    /**
     * @notice Would this transfer succeed? ERC-3643 expects a pre-trade check so
     *         a venue can decline before submitting, instead of discovering the
     *         compliance rule by watching a transaction revert.
     */
    function canTransfer(address from, address to, uint256 shares)
        public
        view
        returns (bool ok, string memory reason)
    {
        if (paused) return (false, "transfers in this title are paused");
        if (addressFrozen[from]) return (false, "sender's holding is frozen");
        if (addressFrozen[to]) return (false, "recipient's holding is frozen");
        if (enforcement.isFrozen(from) || enforcement.isFrozen(to)) return (false, "account frozen by enforcement order");
        if (!approvedCustodian[to]) {
            if (!identity.isActive(to)) return (false, "recipient has no active KYC attestation");
            if (identity.tierOf(to) < minimumTier) return (false, "recipient's KYC tier is too low to hold land shares");
        }
        if (balanceOf(from) < shares) return (false, "insufficient shares");
        if (balanceOf(from) - frozenShares[from] < shares) return (false, "shares are pledged or locked");
        return (true, "");
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!_inForcedMove) {
            if (paused) revert TokenPaused();
            if (from != address(0)) {
                if (addressFrozen[from]) revert AccountFrozen(from);
                if (enforcement.isFrozen(from)) revert AccountFrozen(from);
                uint256 locked = frozenShares[from];
                if (locked > 0) {
                    uint256 free = balanceOf(from) - locked;
                    if (value > free) revert SharesLocked(from, locked, free, value);
                }
            }
            if (to != address(0)) {
                if (addressFrozen[to]) revert AccountFrozen(to);
                _requireCanHold(to);
            }
        }
        super._update(from, to, value);
    }

    function _requireCanHold(address account) private view {
        if (enforcement.isFrozen(account)) revert AccountFrozen(account);
        if (approvedCustodian[account]) return; // vetted contract: no personal identity to check
        if (!identity.isActive(account)) revert NotVerified(account);
        uint8 tier = identity.tierOf(account);
        if (tier < minimumTier) revert TierTooLow(account, tier, minimumTier);
    }
}
