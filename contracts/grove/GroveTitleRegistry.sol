// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IdentityRegistry} from "../identity/IdentityRegistry.sol";
import {EnforcementRegistry} from "../enforcement/EnforcementRegistry.sol";
import {GroveAnchor} from "./GroveAnchor.sol";
import {GroveTitle} from "./GroveTitle.sol";

/**
 * @title GroveTitleRegistry
 * @notice The only door through which a grove becomes a token — and the rule
 *         that keeps the token honest afterwards.
 *
 * Registration is gated (GROVE_AUTHORITY_ROLE), for the same reason land title
 * issuance is: anyone can deploy an ERC-20 and call it a forest, and what makes
 * a token mean anything is that an accountable registrar issued it and stands
 * behind the mapping to a real place.
 *
 * But issuance is the small half. The interesting rule is that THE REGISTRAR
 * CANNOT CHOOSE THE SUPPLY. `syncSupply` reads the verified living-tree count
 * from GroveAnchor — the head of the plot's observation chain, confirmed by a
 * licensed field verifier, undisputed — and mints or burns the difference. There
 * is no path in this contract to mint a share against a tree nobody went and
 * looked at. That single constraint is what separates this from every "plant a
 * tree, get a token" scheme: the token is downstream of the verification, and
 * the verification is downstream of a person with a licence to lose.
 *
 * It is also why `syncSupply` is open to anyone. Correcting the ledger toward
 * what was verified should never wait on the issuer's convenience, and a sceptic
 * being able to force the correction themselves is worth more than a promise
 * that the issuer will.
 *
 * PLACEHOLDER: hypothetical registrar, hypothetical groves. Shares convey
 * nothing and are worth nothing.
 */
contract GroveTitleRegistry is AccessControl {
    /// @notice The registrar permitted to bring a grove on chain.
    bytes32 public constant GROVE_AUTHORITY_ROLE = keccak256("GROVE_AUTHORITY_ROLE");

    /// @dev Grouped to keep the stack shallow enough to compile.
    struct RegisterParams {
        bytes32 plotId; // keccak256 of the Grove plot id
        string name;
        string symbol;
        string location; // commune-level, never a coordinate
        string groveURI;
        uint8 minimumTier;
        address steward; // the grower — holds the shares
    }

    struct Grove {
        bytes32 plotId;
        address token;
        address steward; // where shares are minted to and burned from
        string location;
        uint64 registeredAt;
        uint32 lastSyncedCount;
        uint64 lastSyncedAt;
        bool active;
    }

    IdentityRegistry public immutable identity;
    EnforcementRegistry public immutable enforcement;
    GroveAnchor public immutable anchorRegistry;

    mapping(bytes32 => Grove) private _groves;
    mapping(address => bytes32) public plotOfToken;
    bytes32[] private _plotIds;

    event GroveRegistered(
        bytes32 indexed plotId, address indexed token, address indexed steward, string location
    );
    event SupplySynced(
        bytes32 indexed plotId, address indexed token, uint32 previousCount, uint32 verifiedCount, address by
    );
    event GroveDeactivated(bytes32 indexed plotId, address indexed token, bytes32 reason);
    event GroveReactivated(bytes32 indexed plotId, address indexed token);
    event StewardChanged(bytes32 indexed plotId, address indexed oldSteward, address indexed newSteward);
    event TitleAdminChanged(address indexed oldAdmin, address indexed newAdmin);

    error GroveAlreadyRegistered(bytes32 plotId, address token);
    error UnknownGrove(bytes32 plotId);
    error InvalidPlotId();
    error NotThePlotSteward(bytes32 plotId, address given, address actual);
    error NoVerifiedRecord(bytes32 plotId);
    error GroveInactive(bytes32 plotId);
    error SupplyDriftUnresolved(bytes32 plotId, uint256 shortfall, uint256 stewardBalance);
    error ZeroTitleAdmin();

    constructor(
        IdentityRegistry identity_,
        EnforcementRegistry enforcement_,
        GroveAnchor anchorRegistry_,
        address councilAdmin,
        address groveAuthority
    ) {
        identity = identity_;
        enforcement = enforcement_;
        anchorRegistry = anchorRegistry_;
        titleAdmin = councilAdmin;
        _grantRole(DEFAULT_ADMIN_ROLE, councilAdmin);
        _grantRole(GROVE_AUTHORITY_ROLE, groveAuthority);
    }

    /**
     * @notice Who receives DEFAULT_ADMIN_ROLE on each newly deployed GroveTitle.
     *
     * @dev This used to be `_msgSender()` — the grove authority calling
     *      registerGrove — which handed the office that registers groves the
     *      power to administer every role on the token it had just created.
     *      Because AccessControl administers every role with DEFAULT_ADMIN_ROLE
     *      unless told otherwise, and nothing here calls `_setRoleAdmin`, that
     *      party could grant itself AGENT_ROLE and then mint against no anchored
     *      count, burn a holder's shares, freeze an address, or pause the token
     *      — and, because `_sync` burns only from the steward, an unbacked mint
     *      to any other address wedges `syncSupply` on SupplyDriftUnresolved
     *      permanently, disabling the correction that was supposed to police it.
     *
     *      It is the council's, and settable by the council, rather than fixed
     *      at deployment: an immutable reference to whoever administers a rule
     *      is the failure mode docs/grove-plot-identity.md and the architecture
     *      supplement both record — a later council would otherwise inherit
     *      nothing and have to redeploy, forking the perimeter instead of
     *      replacing it. Existing titles are unaffected by a change here; the
     *      council already holds DEFAULT_ADMIN_ROLE on each of them and can
     *      re-point them individually.
     */
    address public titleAdmin;

    /// @notice Council-only. Changes who administers titles deployed AFTER this.
    function setTitleAdmin(address newAdmin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newAdmin == address(0)) revert ZeroTitleAdmin();
        emit TitleAdminChanged(titleAdmin, newAdmin);
        titleAdmin = newAdmin;
    }

    // ------------------------------------------------------------- issuance

    /**
     * @notice Register a grove and issue its title, minted to the verified count.
     * @dev Requires the plot to already have a verified anchored record, and the
     *      declared steward to be the address that actually opened the plot's
     *      chain in GroveAnchor. Both checks exist so a registrar cannot mint a
     *      grove into existence around somebody else's records, or around no
     *      records at all.
     */
    function registerGrove(RegisterParams calldata p)
        external
        onlyRole(GROVE_AUTHORITY_ROLE)
        returns (address token)
    {
        if (p.plotId == bytes32(0)) revert InvalidPlotId();
        address existing = _groves[p.plotId].token;
        if (existing != address(0)) revert GroveAlreadyRegistered(p.plotId, existing);

        address chainSteward = anchorRegistry.plotSteward(p.plotId);
        if (chainSteward == address(0) || chainSteward != p.steward) {
            revert NotThePlotSteward(p.plotId, p.steward, chainSteward);
        }
        uint32 verified = anchorRegistry.verifiedCountOf(p.plotId);
        if (verified == 0) revert NoVerifiedRecord(p.plotId);

        token = _deployTitle(p);

        _groves[p.plotId] = Grove({
            plotId: p.plotId,
            token: token,
            steward: p.steward,
            location: p.location,
            registeredAt: uint64(block.timestamp),
            lastSyncedCount: 0,
            lastSyncedAt: 0,
            active: true
        });
        plotOfToken[token] = p.plotId;
        _plotIds.push(p.plotId);

        emit GroveRegistered(p.plotId, token, p.steward, p.location);

        // Mint through the same path any later correction takes, so there is
        // exactly one place in this contract where shares come into existence.
        _sync(p.plotId);
    }

    /// @dev Split out to keep the stack shallow. Agent powers go to the
    ///      registry itself, because supply is a mechanical function of the
    ///      anchored record and must not be a discretionary power anyone holds.
    ///      Administrative control of the token goes to `titleAdmin` — the
    ///      council, not the registrar. Granting AGENT_ROLE to the registry is
    ///      necessary and was never sufficient: whoever administers the token
    ///      can grant that role onward to themselves, so the two offices have to
    ///      be different parties for the sentence above to mean anything.
    function _deployTitle(RegisterParams calldata p) private returns (address) {
        GroveTitle t = new GroveTitle(
            GroveTitle.Config({
                name: p.name,
                symbol: p.symbol,
                plotId: p.plotId,
                location: p.location,
                groveURI: p.groveURI,
                minimumTier: p.minimumTier,
                identity: identity,
                enforcement: enforcement,
                authorityAdmin: titleAdmin,
                agent: address(this)
            })
        );
        return address(t);
    }

    // -------------------------------------------------------------- the rule

    /**
     * @notice Bring the token's supply back to the verified living-tree count.
     * @dev Open to anyone, on purpose — see the contract notes. Reverts if the
     *      grove has no verified head record, rather than treating "we cannot
     *      currently verify this grove" as "this grove has no trees": an
     *      unattested new record would otherwise burn a real grower's whole
     *      holding until a verifier got around to visiting.
     */
    function syncSupply(bytes32 plotId) external returns (uint32 verifiedCount) {
        Grove storage g = _groves[plotId];
        if (g.token == address(0)) revert UnknownGrove(plotId);
        if (!g.active) revert GroveInactive(plotId);
        return _sync(plotId);
    }

    function _sync(bytes32 plotId) private returns (uint32 verified) {
        Grove storage g = _groves[plotId];
        verified = anchorRegistry.verifiedCountOf(plotId);
        if (verified == 0) revert NoVerifiedRecord(plotId);

        GroveTitle title = GroveTitle(g.token);
        uint256 supply = title.totalSupply();
        uint32 previous = g.lastSyncedCount;

        if (verified > supply) {
            title.mint(g.steward, verified - supply);
        } else if (verified < supply) {
            uint256 shortfall = supply - verified;
            uint256 held = title.balanceOf(g.steward);
            // Honest limitation, stated rather than hidden: shares that have
            // been sold on cannot be burned from here. The registrar's route is
            // the token's own agent powers plus whatever the sale contract said
            // — not this function silently taking a third party's shares, and
            // not this function pretending the grove is still standing.
            if (held < shortfall) revert SupplyDriftUnresolved(plotId, shortfall, held);
            title.burn(g.steward, shortfall);
        }

        g.lastSyncedCount = verified;
        g.lastSyncedAt = uint64(block.timestamp);
        emit SupplySynced(plotId, g.token, previous, verified, _msgSender());
    }

    // ------------------------------------------------------------- registrar

    function setGroveActive(bytes32 plotId, bool active, bytes32 reason) external onlyRole(GROVE_AUTHORITY_ROLE) {
        Grove storage g = _groves[plotId];
        if (g.token == address(0)) revert UnknownGrove(plotId);
        g.active = active;
        if (active) emit GroveReactivated(plotId, g.token);
        else emit GroveDeactivated(plotId, g.token, reason);
    }

    /// @notice Point the grove at a replacement steward address — the recovery
    ///         path for a grower who lost their key.
    /// @dev Requires the replacement to belong to the SAME registered identity,
    ///      exactly as ERC-3643 recovery does. Without that, "recovery" would be
    ///      a power to hand somebody's grove to anyone the registrar chose.
    function setSteward(bytes32 plotId, address newSteward) external onlyRole(GROVE_AUTHORITY_ROLE) {
        Grove storage g = _groves[plotId];
        if (g.token == address(0)) revert UnknownGrove(plotId);
        bytes32 oldId = identity.attestationOf(g.steward).identity;
        if (oldId == bytes32(0) || identity.attestationOf(newSteward).identity != oldId) {
            revert NotThePlotSteward(plotId, newSteward, g.steward);
        }
        address old = g.steward;
        g.steward = newSteward;
        uint256 balance = GroveTitle(g.token).balanceOf(old);
        if (balance > 0) {
            GroveTitle(g.token).burn(old, balance);
            GroveTitle(g.token).mint(newSteward, balance);
        }
        emit StewardChanged(plotId, old, newSteward);
    }

    // ----------------------------------------------------------------- views

    function groveOf(bytes32 plotId) external view returns (Grove memory) {
        return _groves[plotId];
    }

    function groveCount() external view returns (uint256) {
        return _plotIds.length;
    }

    function plotIdAt(uint256 i) external view returns (bytes32) {
        return _plotIds[i];
    }

    /// @notice Is this token a grove title issued here, and still current? The
    ///         check anything downstream should make before believing a token
    ///         that calls itself a forest.
    function isRegisteredTitle(address token) external view returns (bool) {
        bytes32 plotId = plotOfToken[token];
        if (plotId == bytes32(0)) return false;
        return _groves[plotId].active;
    }

    /// @notice How far the token has drifted from the verified record, and why
    ///         a sync would fail if it would.
    function supplyStatus(bytes32 plotId)
        external
        view
        returns (uint256 supply, uint32 verifiedCount, bool inSync, string memory reason)
    {
        Grove storage g = _groves[plotId];
        if (g.token == address(0)) return (0, 0, false, "no grove is registered for this plot");
        supply = GroveTitle(g.token).totalSupply();
        verifiedCount = anchorRegistry.verifiedCountOf(plotId);
        if (verifiedCount == 0) {
            return (supply, 0, false, "the plot's latest record is not verified by a licensed attester");
        }
        if (!g.active) return (supply, verifiedCount, false, "this grove is deregistered");
        if (supply == verifiedCount) return (supply, verifiedCount, true, "");
        if (verifiedCount < supply) {
            uint256 shortfall = supply - verifiedCount;
            uint256 held = GroveTitle(g.token).balanceOf(g.steward);
            if (held < shortfall) {
                return (supply, verifiedCount, false, "shares have been sold on and cannot be burned from here");
            }
        }
        return (supply, verifiedCount, false, "supply has not been synced to the latest verified record");
    }
}
