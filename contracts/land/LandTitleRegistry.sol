// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IdentityRegistry} from "../identity/IdentityRegistry.sol";
import {EnforcementRegistry} from "../enforcement/EnforcementRegistry.sol";
import {LandTitleToken} from "./LandTitleToken.sol";

/**
 * @title LandTitleRegistry
 * @notice The cadastre's on-chain index, and the only door through which a land
 *         title becomes a token.
 *
 * The gate is the point. Anyone can deploy an ERC-20 and call it a land title;
 * what makes a token meaningful is that a regulated registrar issued it and
 * stands behind the mapping to a real parcel. So tokenization is restricted to
 * LAND_AUTHORITY_ROLE, one parcel maps to exactly one token, and the link is
 * recorded here where a lender can check it.
 *
 * The composability payoff: once a title is a token on a chain whose identity
 * layer is already authoritative, a lending protocol nobody coordinated with can
 * accept it as collateral — verifying through this registry that the token is a
 * genuinely registered title rather than a lookalike. That is the argument for
 * putting titles on a shared ledger instead of in one ministry's database.
 *
 * PLACEHOLDER: hypothetical roles and parcels. This is a design study; no real
 * cadastre or property is represented, and tokens minted here convey nothing.
 */
contract LandTitleRegistry is AccessControl {
    /// @notice The regulated registrar permitted to tokenize titles.
    bytes32 public constant LAND_AUTHORITY_ROLE = keccak256("LAND_AUTHORITY_ROLE");

    /// @dev Grouped into a struct because the parameter list is long enough to
    ///      exhaust the EVM stack as individual arguments.
    struct TokenizeParams {
        bytes32 parcelId;
        string name;
        string symbol;
        string location;
        string titleURI;
        uint256 areaSqm;
        uint256 totalShares;
        uint8 minimumTier;
        address firstOwner;
    }

    struct Parcel {
        bytes32 parcelId; // cadastral reference
        address token; // the LandTitleToken for this parcel
        string location; // human-readable, e.g. "Sangkat X, Khan Y"
        uint256 areaSqm;
        uint256 totalShares;
        uint64 registeredAt;
        bool active; // cleared if the title is deregistered (sold off-chain, merged, revoked)
    }

    IdentityRegistry public immutable identity;
    EnforcementRegistry public immutable enforcement;

    mapping(bytes32 => Parcel) private _parcels;
    mapping(address => bytes32) public parcelOfToken;
    bytes32[] private _parcelIds;

    event ParcelTokenized(
        bytes32 indexed parcelId, address indexed token, address indexed firstOwner, uint256 totalShares, string location
    );
    event ParcelDeactivated(bytes32 indexed parcelId, address indexed token, bytes32 reason);
    event ParcelReactivated(bytes32 indexed parcelId, address indexed token);

    error ParcelAlreadyTokenized(bytes32 parcelId, address token);
    error UnknownParcel(bytes32 parcelId);
    error InvalidShares();
    error InvalidParcelId();

    constructor(
        IdentityRegistry identity_,
        EnforcementRegistry enforcement_,
        address councilAdmin,
        address landAuthority
    ) {
        identity = identity_;
        enforcement = enforcement_;
        _grantRole(DEFAULT_ADMIN_ROLE, councilAdmin);
        _grantRole(LAND_AUTHORITY_ROLE, landAuthority);
    }

    /**
     * @notice Tokenize a parcel: deploy its title token and issue every share to
     *         the recorded owner.
     * @dev The registrar keeps AGENT_ROLE on the resulting token, because the
     *      powers that make land workable — executing a court order, recovering a
     *      lost key — have to sit with an accountable body, not with whoever
     *      happens to hold the shares.
     */
    function tokenizeParcel(TokenizeParams calldata p)
        external
        onlyRole(LAND_AUTHORITY_ROLE)
        returns (address token)
    {
        if (p.parcelId == bytes32(0)) revert InvalidParcelId();
        if (p.totalShares == 0) revert InvalidShares();
        address existing = _parcels[p.parcelId].token;
        if (existing != address(0)) revert ParcelAlreadyTokenized(p.parcelId, existing);

        token = _deployTitle(p);

        _parcels[p.parcelId] = Parcel({
            parcelId: p.parcelId,
            token: token,
            location: p.location,
            areaSqm: p.areaSqm,
            totalShares: p.totalShares,
            registeredAt: uint64(block.timestamp),
            active: true
        });
        parcelOfToken[token] = p.parcelId;
        _parcelIds.push(p.parcelId);

        emit ParcelTokenized(p.parcelId, token, p.firstOwner, p.totalShares, p.location);
    }

    /**
     * @dev Split out purely to keep the stack shallow enough to compile.
     *      Agent powers go straight to the registrar and the shares are minted
     *      by the constructor, so this factory never holds authority over a
     *      title it has created.
     */
    function _deployTitle(TokenizeParams calldata p) private returns (address) {
        LandTitleToken t = new LandTitleToken(
            LandTitleToken.Config({
                name: p.name,
                symbol: p.symbol,
                parcelId: p.parcelId,
                titleURI: p.titleURI,
                minimumTier: p.minimumTier,
                identity: identity,
                enforcement: enforcement,
                authorityAdmin: _msgSender(),
                agent: _msgSender(),
                firstOwner: p.firstOwner,
                initialShares: p.totalShares
            })
        );
        return address(t);
    }

    function setParcelActive(bytes32 parcelId, bool active, bytes32 reason)
        external
        onlyRole(LAND_AUTHORITY_ROLE)
    {
        Parcel storage p = _parcels[parcelId];
        if (p.token == address(0)) revert UnknownParcel(parcelId);
        p.active = active;
        if (active) emit ParcelReactivated(parcelId, p.token);
        else emit ParcelDeactivated(parcelId, p.token, reason);
    }

    // ----------------------------------------------------------------- views

    function parcelOf(bytes32 parcelId) external view returns (Parcel memory) {
        return _parcels[parcelId];
    }

    function parcelCount() external view returns (uint256) {
        return _parcelIds.length;
    }

    function parcelIdAt(uint256 i) external view returns (bytes32) {
        return _parcelIds[i];
    }

    /**
     * @notice Is this token a title issued by this registry, and still current?
     * @dev The check a lending protocol should make before accepting collateral.
     *      Anyone can deploy a convincing-looking token; only the registry can
     *      say whether it corresponds to a registered parcel.
     */
    function isRegisteredTitle(address token) external view returns (bool) {
        bytes32 parcelId = parcelOfToken[token];
        if (parcelId == bytes32(0)) return false;
        return _parcels[parcelId].active;
    }
}
