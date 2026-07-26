// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title AttesterRegistry
 * @notice Who is licensed to go and look at a tree — the accountability layer
 *         underneath every environmental claim on this chain.
 *
 * Grove (the phone app) proves WHO SAID something: a device signs an observation
 * with a key nobody issued and nobody can revoke. That is genuinely useful and
 * genuinely not enough, because anyone can generate a thousand keys and have all
 * of them confirm each other. A trust score built on "confirmations from
 * distinct devices" is a Sybil count wearing a lab coat.
 *
 * This registry is the part a public chain cannot supply. An attester here is a
 * real, licensed person or body — a commune agriculture officer, an agronomist,
 * a school, a cooperative — recorded by a licensing registrar who can take the
 * licence away. Their confirmation is worth something precisely because losing
 * the licence costs them something. One accountable verifier beats fifty
 * anonymous ones, and that inversion is the entire argument for doing this here.
 *
 * Deliberately a licensing layer ONLY. It does not know about KYC, freezes, or
 * observations: GroveAnchor combines a licence from here with an active identity
 * attestation and a clean enforcement record before it will count a confirmation.
 * Same separation as MerchantRegistry vs SocialProgramRegistry elsewhere in CSB —
 * one office decides who is an agronomist, a different one decides what an
 * agronomist's signature is good for.
 *
 * PLACEHOLDER: the "licensing registrar" is a hypothetical role. No real
 * ministry, licence, agronomist, or cooperative is represented.
 */
contract AttesterRegistry is AccessControl {
    /// @notice Issues and withdraws field-verifier licences.
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    // Class bits. Values are part of the ABI — append, never renumber.
    uint32 public constant AGRONOMIST = 1 << 0; // qualified agricultural officer
    uint32 public constant COMMUNE = 1 << 1; // commune / sangkat local authority
    uint32 public constant SCHOOL = 1 << 2; // school or university programme
    uint32 public constant COOPERATIVE = 1 << 3; // farmer cooperative
    uint32 public constant NGO = 1 << 4; // registered environmental NGO
    uint32 public constant AUDITOR = 1 << 5; // independent verification body

    struct Attester {
        uint32 classes; // bitmask of the licences held
        bool suspended; // licence temporarily withdrawn
        string label; // e.g. "Commune agriculture officer, Sangkat Example"
        bytes32 licenceRef; // off-chain licence/registration reference
        uint64 registeredAt;
        uint64 confirmations; // work done, for a legible reputation
        uint64 disputesRaised;
    }

    mapping(address => Attester) private _attesters;
    address[] private _attesterList;

    /// @notice May report verification work back here so it lands on the record.
    ///         Held by GroveAnchor, never by an attester — a verifier must not be
    ///         able to write their own reputation.
    bytes32 public constant RECORDER_ROLE = keccak256("RECORDER_ROLE");

    event AttesterLicensed(address indexed attester, uint32 classes, bytes32 licenceRef, string label);
    event AttesterClassesChanged(address indexed attester, uint32 oldClasses, uint32 newClasses);
    event AttesterSuspended(address indexed attester, bool suspended);
    event AttesterRemoved(address indexed attester);
    event WorkRecorded(address indexed attester, uint64 confirmations, uint64 disputesRaised);

    error NotLicensed(address attester);
    error NoClasses();

    constructor(address councilAdmin, address registrar) {
        _grantRole(DEFAULT_ADMIN_ROLE, councilAdmin);
        _grantRole(REGISTRAR_ROLE, registrar);
    }

    // -------------------------------------------------------------- registrar

    function licenseAttester(address attester, uint32 classes, bytes32 licenceRef, string calldata label)
        external
        onlyRole(REGISTRAR_ROLE)
    {
        if (classes == 0) revert NoClasses();
        Attester storage a = _attesters[attester];
        uint32 old = a.classes;
        a.classes = classes;
        a.label = label;
        a.licenceRef = licenceRef;
        if (a.registeredAt == 0) {
            a.registeredAt = uint64(block.timestamp);
            _attesterList.push(attester);
            emit AttesterLicensed(attester, classes, licenceRef, label);
        } else {
            emit AttesterClassesChanged(attester, old, classes);
        }
    }

    /**
     * @notice Withdraw or restore a licence.
     * @dev Suspension keeps the registration row. The record of who was licensed
     *      when is the point of a licence: deleting it would erase the history a
     *      dispute over a past attestation has to be settled against.
     */
    function setSuspended(address attester, bool suspended) external onlyRole(REGISTRAR_ROLE) {
        if (_attesters[attester].registeredAt == 0) revert NotLicensed(attester);
        _attesters[attester].suspended = suspended;
        emit AttesterSuspended(attester, suspended);
    }

    function removeAttester(address attester) external onlyRole(REGISTRAR_ROLE) {
        if (_attesters[attester].registeredAt == 0) revert NotLicensed(attester);
        _attesters[attester].suspended = true;
        _attesters[attester].classes = 0;
        emit AttesterRemoved(attester);
    }

    // ------------------------------------------------------------- reputation

    /// @notice Called by GroveAnchor when this attester confirms or disputes.
    function recordWork(address attester, bool confirmed) external onlyRole(RECORDER_ROLE) {
        Attester storage a = _attesters[attester];
        if (a.registeredAt == 0) revert NotLicensed(attester);
        if (confirmed) a.confirmations += 1;
        else a.disputesRaised += 1;
        emit WorkRecorded(attester, a.confirmations, a.disputesRaised);
    }

    // ------------------------------------------------------------------ views

    function attesterOf(address attester) external view returns (Attester memory) {
        return _attesters[attester];
    }

    function classesOf(address attester) external view returns (uint32) {
        return _attesters[attester].classes;
    }

    function isRegistered(address attester) external view returns (bool) {
        return _attesters[attester].registeredAt != 0;
    }

    /// @notice Licensed, in good standing, and holding at least one class.
    function isLicensed(address attester) public view returns (bool) {
        Attester storage a = _attesters[attester];
        return a.registeredAt != 0 && !a.suspended && a.classes != 0;
    }

    /// @notice Does this attester hold any of the licences in `mask`, in good
    ///         standing? Lets a programme demand a specific competence — a
    ///         carbon audit wants an AUDITOR, a school planting is happy with a
    ///         SCHOOL.
    function hasAnyClass(address attester, uint32 mask) external view returns (bool) {
        if (!isLicensed(attester)) return false;
        return (_attesters[attester].classes & mask) != 0;
    }

    function attesterCount() external view returns (uint256) {
        return _attesterList.length;
    }

    function attesterAt(uint256 i) external view returns (address) {
        return _attesterList[i];
    }
}
