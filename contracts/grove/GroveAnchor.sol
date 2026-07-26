// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IdentityRegistry} from "../identity/IdentityRegistry.sol";
import {EnforcementRegistry} from "../enforcement/EnforcementRegistry.sol";
import {AttesterRegistry} from "./AttesterRegistry.sol";

/**
 * @title GroveAnchor
 * @notice The chain's copy of a growing thing: the content hash of a signed
 *         Grove observation, the moment consensus first saw it, and who with a
 *         licence has since gone and looked at the tree.
 *
 * WHAT THIS DOES NOT DO, first, because it is the part usually lied about: it
 * does not make an observation true. A signature proves who said something, and
 * no arrangement of cryptography can prove a photographed tree exists. Grove's
 * own specification says this plainly and so does this contract. Nothing here
 * mints carbon, and no token in this repository claims a tonne of CO2.
 *
 * What it adds is narrow and real:
 *
 *  - AN INDEPENDENT CLOCK. A Grove record carries `observedAt` from the phone's
 *    own clock, which is a claim by the person making the claim. A block
 *    timestamp is agreed by a validator set that has never met them. "This
 *    record existed by this date" stops being self-reported.
 *
 *  - AN ACCOUNTABLE WITNESS. Confirmations are counted only from addresses that
 *    hold a live licence in AttesterRegistry, an active KYC attestation, and no
 *    enforcement freeze — checked at the moment of attesting. Anonymous devices
 *    can still co-sign in Grove; they do not count here.
 *
 *  - A CHAIN THAT CANNOT FORK. A plot's observations are linked by `prev` in
 *    Grove. Here each new anchor must extend the plot's current head, so nobody
 *    can quietly maintain two histories of the same garden and show whichever
 *    one suits them.
 *
 * ONLY THE HASH IS STORED. No GPS, no photo, no device key, no name. The
 * observation id is Grove's SHA-256 content hash, which reveals nothing and
 * proves everything: hand anyone the original record and they can recompute it.
 * Putting a garden's coordinates on a chain that a whole country can read would
 * be a poor trade for a farmer whose fruit trees are worth stealing.
 *
 * PLACEHOLDER: a demonstration on a test network. Anchoring a record here is not
 * certification, and confers no environmental credit of any kind.
 */
contract GroveAnchor is AccessControl {
    // The verification threshold and the minimum KYC tier are the council's
    // (DEFAULT_ADMIN_ROLE), deliberately not the licensing registrar's — the
    // office that appoints verifiers should not also set how many are needed.

    struct Anchor {
        bytes32 plotId; // keccak256 of the Grove plot id
        bytes32 prevId; // the observation this one succeeds (0 for the first)
        bytes32 species; // short species tag, for a legible record
        address anchoredBy; // the KYC'd steward who committed it
        uint64 anchoredAt; // BLOCK time — consensus, not the device's clock
        uint32 liveCount; // living plants this record covers
        uint32 confirms; // confirmations from licensed attesters
        uint32 disputes; // disputes from licensed attesters
        address firstConfirmer; // who first put their licence behind it
    }

    IdentityRegistry public immutable identity;
    EnforcementRegistry public immutable enforcement;
    AttesterRegistry public immutable attesters;

    /// @notice Licensed confirmations needed before a record counts as verified.
    uint32 public requiredConfirmations = 1;
    /// @notice Minimum KYC tier to anchor a record. 1 = any verified citizen —
    ///         recording your own garden should not require a business licence.
    uint8 public minimumTier = 1;

    mapping(bytes32 => Anchor) private _anchors;
    /// @notice Newest anchored observation for a plot — the chain's head.
    mapping(bytes32 => bytes32) public plotHead;
    mapping(bytes32 => uint32) public plotLength;
    /**
     * @notice Who opened this plot's chain, and may extend it.
     * @dev Bound on the first anchor and never reassigned. Without it, anyone
     *      could append to a stranger's garden history — and since a pledge pays
     *      out against that history, that is a way to be paid for someone else's
     *      trees.
     */
    mapping(bytes32 => address) public plotSteward;
    /// @notice Additional addresses the steward lets record for their plot (a
    ///         second phone, a family member, a cooperative's field tablet).
    mapping(bytes32 => mapping(address => bool)) public plotRecorder;

    mapping(bytes32 => mapping(address => bool)) public hasAttested;

    bytes32[] private _observationIds;

    event Anchored(
        bytes32 indexed observationId,
        bytes32 indexed plotId,
        address indexed anchoredBy,
        bytes32 prevId,
        uint32 liveCount,
        uint64 anchoredAt
    );
    event Attested(
        bytes32 indexed observationId,
        address indexed attester,
        bool confirmed,
        uint32 confirms,
        uint32 disputes,
        bytes32 noteRef
    );
    event RecorderSet(bytes32 indexed plotId, address indexed recorder, bool allowed);
    event RequiredConfirmationsSet(uint32 required);
    event MinimumTierSet(uint8 tier);

    error InvalidObservationId();
    error InvalidPlotId();
    error AlreadyAnchored(bytes32 observationId);
    error UnknownObservation(bytes32 observationId);
    error NotPlotRecorder(bytes32 plotId, address caller);
    error PlotAlreadyOpened(bytes32 plotId, bytes32 head);
    error PrevNotHead(bytes32 plotId, bytes32 head, bytes32 given);
    error NotVerifiedIdentity(address account);
    error TierTooLow(address account, uint8 tier, uint8 required);
    error AccountFrozen(address account);
    error NotLicensedAttester(address account);
    error SelfAttestation(bytes32 observationId, address attester);
    error AlreadyAttested(bytes32 observationId, address attester);
    error NotPlotSteward(bytes32 plotId, address caller);

    constructor(
        IdentityRegistry identity_,
        EnforcementRegistry enforcement_,
        AttesterRegistry attesters_,
        address councilAdmin
    ) {
        identity = identity_;
        enforcement = enforcement_;
        attesters = attesters_;
        _grantRole(DEFAULT_ADMIN_ROLE, councilAdmin);
    }

    // --------------------------------------------------------------- anchoring

    /**
     * @notice Commit a signed Grove observation's content hash to the chain.
     * @param observationId Grove's SHA-256 id of the canonical record (32 bytes).
     * @param plotId keccak256 of the Grove plot id — a stable garden reference.
     * @param prevId The plot's current head, or 0 to open a new plot.
     * @param liveCount Living plants this record covers.
     * @param species Short species tag from the record.
     *
     * @dev Idempotence comes free: the id IS the content, so re-anchoring the
     *      same record is always the same call and is refused rather than
     *      double-counted. Nothing about the record's contents is verified
     *      here — the chain cannot see the signed bytes and should not pretend
     *      to. What it enforces is that a plot has one history, extended by
     *      someone entitled to extend it.
     */
    function anchor(bytes32 observationId, bytes32 plotId, bytes32 prevId, uint32 liveCount, bytes32 species)
        external
        returns (uint64 anchoredAt)
    {
        if (observationId == bytes32(0)) revert InvalidObservationId();
        if (plotId == bytes32(0)) revert InvalidPlotId();
        if (_anchors[observationId].anchoredAt != 0) revert AlreadyAnchored(observationId);
        _requireCanAnchor(_msgSender());

        bytes32 head = plotHead[plotId];
        address steward = plotSteward[plotId];
        if (steward == address(0)) {
            // Opening a plot. A first record must say so by passing prev = 0;
            // claiming a predecessor that was never anchored would leave a
            // history with a hole in it that later reads as continuous.
            if (prevId != bytes32(0)) revert PrevNotHead(plotId, bytes32(0), prevId);
            plotSteward[plotId] = _msgSender();
        } else {
            if (_msgSender() != steward && !plotRecorder[plotId][_msgSender()]) {
                revert NotPlotRecorder(plotId, _msgSender());
            }
            if (prevId != head) revert PrevNotHead(plotId, head, prevId);
        }

        anchoredAt = uint64(block.timestamp);
        _anchors[observationId] = Anchor({
            plotId: plotId,
            prevId: prevId,
            species: species,
            anchoredBy: _msgSender(),
            anchoredAt: anchoredAt,
            liveCount: liveCount,
            confirms: 0,
            disputes: 0,
            firstConfirmer: address(0)
        });
        plotHead[plotId] = observationId;
        plotLength[plotId] += 1;
        _observationIds.push(observationId);

        emit Anchored(observationId, plotId, _msgSender(), prevId, liveCount, anchoredAt);
    }

    /// @notice Let another address record for your plot — a second phone, a
    ///         cooperative's field tablet, a family member.
    function setPlotRecorder(bytes32 plotId, address recorder, bool allowed) external {
        if (plotSteward[plotId] != _msgSender()) revert NotPlotSteward(plotId, _msgSender());
        plotRecorder[plotId][recorder] = allowed;
        emit RecorderSet(plotId, recorder, allowed);
    }

    // ------------------------------------------------------------ attestation

    /**
     * @notice A licensed verifier puts their licence behind a record — or
     *         against it.
     * @param noteRef Reference to the verifier's off-chain field note. A hash or
     *                a case number, never the note itself: a dispute may name a
     *                person, and this is a public ledger.
     *
     * @dev Three checks, all at the moment of attesting, because a licence
     *      revoked yesterday must not confirm anything today: a live licence, an
     *      active KYC attestation, and no enforcement freeze. Self-attestation is
     *      refused — a signature over your own claim adds nothing to it, and
     *      allowing it would let a licensed grower verify their own trees and
     *      collect a pledge for them.
     */
    function attest(bytes32 observationId, bool confirm, bytes32 noteRef) external {
        Anchor storage a = _anchors[observationId];
        if (a.anchoredAt == 0) revert UnknownObservation(observationId);
        address who = _msgSender();
        if (a.anchoredBy == who) revert SelfAttestation(observationId, who);
        if (hasAttested[observationId][who]) revert AlreadyAttested(observationId, who);
        if (!attesters.isLicensed(who)) revert NotLicensedAttester(who);
        if (enforcement.isFrozen(who)) revert AccountFrozen(who);
        if (!identity.isActive(who)) revert NotVerifiedIdentity(who);

        hasAttested[observationId][who] = true;
        if (confirm) {
            a.confirms += 1;
            if (a.firstConfirmer == address(0)) a.firstConfirmer = who;
        } else {
            a.disputes += 1;
        }
        // Best effort: a registry that has not granted RECORDER_ROLE should not
        // be able to block verification of real work in the field.
        try attesters.recordWork(who, confirm) {} catch {}

        emit Attested(observationId, who, confirm, a.confirms, a.disputes, noteRef);
    }

    // ------------------------------------------------------------- governance

    function setRequiredConfirmations(uint32 required) external onlyRole(DEFAULT_ADMIN_ROLE) {
        requiredConfirmations = required;
        emit RequiredConfirmationsSet(required);
    }

    function setMinimumTier(uint8 tier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minimumTier = tier;
        emit MinimumTierSet(tier);
    }

    // ------------------------------------------------------------------ views

    function anchorOf(bytes32 observationId) external view returns (Anchor memory) {
        return _anchors[observationId];
    }

    function isAnchored(bytes32 observationId) public view returns (bool) {
        return _anchors[observationId].anchoredAt != 0;
    }

    /**
     * @notice Anchored, confirmed by enough licensed verifiers, and undisputed.
     * @dev A single dispute withholds verification rather than being outvoted.
     *      A verifier who says "these trees are not there" has staked a licence
     *      on it; the right response is a human looking again, not arithmetic.
     */
    function isVerified(bytes32 observationId) public view returns (bool) {
        Anchor storage a = _anchors[observationId];
        if (a.anchoredAt == 0) return false;
        return a.disputes == 0 && a.confirms >= requiredConfirmations;
    }

    /// @notice Living plants at this plot's head record, if that record is
    ///         verified — 0 otherwise. The only tree count anything downstream
    ///         is allowed to trust.
    function verifiedCountOf(bytes32 plotId) external view returns (uint32) {
        bytes32 head = plotHead[plotId];
        if (head == bytes32(0)) return 0;
        if (!isVerified(head)) return 0;
        return _anchors[head].liveCount;
    }

    function headOf(bytes32 plotId) external view returns (Anchor memory) {
        return _anchors[plotHead[plotId]];
    }

    function observationCount() external view returns (uint256) {
        return _observationIds.length;
    }

    function observationIdAt(uint256 i) external view returns (bytes32) {
        return _observationIds[i];
    }

    /// @notice Can this address anchor a record right now, and if not, why?
    ///         So a wallet can explain a refusal instead of showing a revert.
    function canAnchor(address who) external view returns (bool ok, string memory reason) {
        if (enforcement.isFrozen(who)) return (false, "this account is frozen by an enforcement order");
        if (!identity.isActive(who)) return (false, "this address has no active KYC attestation on CSB");
        if (identity.tierOf(who) < minimumTier) return (false, "this address's KYC tier is too low to anchor records");
        return (true, "");
    }

    /// @notice Can this address attest to this record right now, and if not, why?
    function canAttest(address who, bytes32 observationId) external view returns (bool ok, string memory reason) {
        Anchor storage a = _anchors[observationId];
        if (a.anchoredAt == 0) return (false, "this observation has not been anchored on CSB");
        if (a.anchoredBy == who) return (false, "a record cannot be verified by the person who recorded it");
        if (hasAttested[observationId][who]) return (false, "this verifier has already attested to this record");
        if (!attesters.isLicensed(who)) return (false, "this address holds no current field-verifier licence");
        if (enforcement.isFrozen(who)) return (false, "this account is frozen by an enforcement order");
        if (!identity.isActive(who)) return (false, "this address has no active KYC attestation on CSB");
        return (true, "");
    }

    // --------------------------------------------------------------- internal

    function _requireCanAnchor(address who) private view {
        if (enforcement.isFrozen(who)) revert AccountFrozen(who);
        if (!identity.isActive(who)) revert NotVerifiedIdentity(who);
        uint8 tier = identity.tierOf(who);
        if (tier < minimumTier) revert TierTooLow(who, tier, minimumTier);
    }
}
