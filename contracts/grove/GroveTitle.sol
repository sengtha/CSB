// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IdentityRegistry} from "../identity/IdentityRegistry.sol";
import {EnforcementRegistry} from "../enforcement/EnforcementRegistry.sol";

/**
 * @title GroveTitle
 * @notice One registered grove, as a permissioned token. One share = one living
 *         tree that a licensed verifier has confirmed is standing.
 *
 * The unit is the whole argument. A carbon token says "this is a tonne of CO2",
 * a claim derived from an estimate of an estimate that nobody can walk out and
 * check. A share here says "there is a tree", which is the largest claim this
 * stack can actually support and a claim anyone can falsify by visiting. Supply
 * is not decided by the issuer: GroveTitleRegistry.syncSupply mints and burns
 * against the verified count in GroveAnchor, so the token tracks the grove
 * rather than the story anyone tells about it.
 *
 * That includes downwards. Trees die, and a grove token whose supply could only
 * rise would be a worse record than a notebook. When a verified record shows
 * fewer standing trees, shares are burned. A green asset that cannot lose value
 * when the green thing dies is exactly the instrument that discredited this
 * entire field.
 *
 * ERC-3643 (T-REX) in shape, for the same reason LandTitleToken is: the standard
 * expects an identity registry deciding who may hold, and CSB already has an
 * authoritative national one. Compliance comes from the layer that is already
 * true rather than from a private allowlist maintained by the issuer.
 *
 * PLACEHOLDER: a demonstration on a test network. A share conveys no ownership
 * of any tree, land, timber, fruit, or carbon, and is worth nothing.
 */
contract GroveTitle is ERC20, AccessControl {
    /// @notice ERC-3643 "agent": the registrar operating this title. Mint/burn
    ///         is reachable only through the registry's supply sync.
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    IdentityRegistry public immutable identity;
    EnforcementRegistry public immutable enforcement;

    /// @notice keccak256 of the Grove plot id this title represents.
    bytes32 public immutable plotId;
    /// @notice Where the grove is, in words. Coarse on purpose — a commune, not
    ///         a coordinate. The precise location stays on the grower's phone.
    string public location;
    /// @notice Pointer to the off-chain grove record (the Grove bundle, a deed,
    ///         a management plan). The record is the instrument; this is a link.
    string public groveURI;

    uint8 public minimumTier;
    bool public paused;

    mapping(address => bool) public addressFrozen;

    /**
     * @notice Contracts the registrar permits to hold shares — a pledge escrow,
     *         a cooperative pool. A contract has no national identity, so
     *         without this shares could only ever sit in personal wallets.
     */
    mapping(address => bool) public approvedCustodian;

    event LocationSet(string location);
    event GroveURISet(string groveURI);
    event MinimumTierSet(uint8 tier);
    event Paused(bool paused);
    event AddressFrozenSet(address indexed account, bool frozen);
    event ApprovedCustodianSet(address indexed account, bool approved);

    error TokenPaused();
    error NotVerified(address account);
    error TierTooLow(address account, uint8 tier, uint8 required);
    error AccountFrozen(address account);

    /// @dev Grouped because the argument list would otherwise exhaust the stack,
    ///      same as LandTitleToken.
    struct Config {
        string name;
        string symbol;
        bytes32 plotId;
        string location;
        string groveURI;
        uint8 minimumTier;
        IdentityRegistry identity;
        EnforcementRegistry enforcement;
        address authorityAdmin;
        address agent;
    }

    /**
     * @dev No initial supply. Shares exist only after GroveAnchor holds a
     *      verified record to mint them against — which is the point: a title
     *      cannot be issued with a tree count somebody typed in.
     */
    constructor(Config memory c) ERC20(c.name, c.symbol) {
        plotId = c.plotId;
        location = c.location;
        groveURI = c.groveURI;
        minimumTier = c.minimumTier;
        identity = c.identity;
        enforcement = c.enforcement;
        _grantRole(DEFAULT_ADMIN_ROLE, c.authorityAdmin);
        _grantRole(AGENT_ROLE, c.agent);
    }

    /// @dev Whole trees. A third of a tree is not a thing anybody can verify.
    function decimals() public pure override returns (uint8) {
        return 0;
    }

    // ----------------------------------------------------------- agent powers

    function mint(address to, uint256 shares) external onlyRole(AGENT_ROLE) {
        _mint(to, shares);
    }

    /**
     * @dev Burning bypasses the holder's consent, and an enforcement freeze,
     *      by design: the trees are gone. A freeze exists to stop value leaving
     *      an account, and burning a share that no longer stands behind a living
     *      tree moves no value anywhere — while refusing to burn would leave the
     *      ledger overstating a grove for as long as the freeze lasts.
     */
    function burn(address from, uint256 shares) external onlyRole(AGENT_ROLE) {
        _inForcedBurn = true;
        _burn(from, shares);
        _inForcedBurn = false;
    }

    function setAddressFrozen(address account, bool frozen) external onlyRole(AGENT_ROLE) {
        addressFrozen[account] = frozen;
        emit AddressFrozenSet(account, frozen);
    }

    function setPaused(bool paused_) external onlyRole(AGENT_ROLE) {
        paused = paused_;
        emit Paused(paused_);
    }

    // ------------------------------------------------------------- governance

    function setLocation(string calldata location_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        location = location_;
        emit LocationSet(location_);
    }

    function setGroveURI(string calldata uri) external onlyRole(DEFAULT_ADMIN_ROLE) {
        groveURI = uri;
        emit GroveURISet(uri);
    }

    function setMinimumTier(uint8 tier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minimumTier = tier;
        emit MinimumTierSet(tier);
    }

    function setApprovedCustodian(address account, bool approved) external onlyRole(DEFAULT_ADMIN_ROLE) {
        approvedCustodian[account] = approved;
        emit ApprovedCustodianSet(account, approved);
    }

    // ------------------------------------------------------------- compliance

    /// @notice Would this transfer succeed? ERC-3643 expects a pre-trade check
    ///         so a venue can decline before submitting.
    function canTransfer(address from, address to, uint256 shares) public view returns (bool ok, string memory reason) {
        if (paused) return (false, "transfers in this grove title are paused");
        if (addressFrozen[from]) return (false, "sender's holding is frozen");
        if (addressFrozen[to]) return (false, "recipient's holding is frozen");
        if (enforcement.isFrozen(from) || enforcement.isFrozen(to)) {
            return (false, "account frozen by enforcement order");
        }
        if (!approvedCustodian[to]) {
            if (!identity.isActive(to)) return (false, "recipient has no active KYC attestation");
            if (identity.tierOf(to) < minimumTier) return (false, "recipient's KYC tier is too low to hold grove shares");
        }
        if (balanceOf(from) < shares) return (false, "insufficient shares");
        return (true, "");
    }

    bool private _inForcedBurn;

    function _update(address from, address to, uint256 value) internal override {
        if (_inForcedBurn) {
            super._update(from, to, value);
            return;
        }
        if (paused) revert TokenPaused();
        if (from != address(0)) {
            if (addressFrozen[from]) revert AccountFrozen(from);
            if (enforcement.isFrozen(from)) revert AccountFrozen(from);
        }
        if (to != address(0)) {
            if (addressFrozen[to]) revert AccountFrozen(to);
            _requireCanHold(to);
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
