// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title IdentityRegistry
 * @notice On-chain KYC attestation registry issued by the national Identity Authority.
 *
 * Design rules:
 *  - No PII on chain. An attestation binds an address to a salted commitment hash
 *    (`identity`) referencing a record in the Identity Authority's off-chain civil registry. The
 *    identity <-> person mapping never leaves Identity Authority systems.
 *  - One identity gets one address by default. Additional address slots are
 *    granted by the Identity Authority after an off-chain fee payment (`increaseAddressQuota`
 *    records the payment reference).
 *  - This contract holds identity powers only. Asset freezing/seizure lives in
 *    EnforcementRegistry under a different authority (separation of powers).
 *
 * Tiers:
 *  1 = citizen basic (capped payments)
 *  2 = full KYC (unrestricted DeFi)
 *  3 = business / KYB
 *  4 = institutional / qualified investor
 */
contract IdentityRegistry is AccessControl {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    uint8 public constant MIN_TIER = 1;
    uint8 public constant MAX_TIER = 4;

    enum Status {
        None,
        Active,
        Suspended,
        Revoked
    }

    struct Attestation {
        bytes32 identity; // salted commitment to the Identity Authority registry record
        uint8 tier;
        Status status;
        uint64 issuedAt;
    }

    mapping(address => Attestation) private _attestations;

    /// @notice Number of currently registered (non-revoked) addresses per identity.
    mapping(bytes32 => uint32) public addressCount;

    /// @dev Stored quota; 0 means the default of 1.
    mapping(bytes32 => uint32) private _addressQuota;

    event AddressRegistered(address indexed account, bytes32 indexed identity, uint8 tier);
    event AddressRevoked(address indexed account, bytes32 indexed identity);
    event AddressSuspended(address indexed account, bytes32 indexed identity);
    event AddressReactivated(address indexed account, bytes32 indexed identity);
    event TierChanged(address indexed account, uint8 oldTier, uint8 newTier);
    event AddressQuotaIncreased(bytes32 indexed identity, uint32 newQuota, bytes32 paymentRef);

    error InvalidTier(uint8 tier);
    error AlreadyRegistered(address account);
    error NotRegistered(address account);
    error QuotaExceeded(bytes32 identity, uint32 quota);
    error WrongStatus(address account, Status actual);

    constructor(address councilAdmin, address identityIssuer) {
        _grantRole(DEFAULT_ADMIN_ROLE, councilAdmin);
        _grantRole(ISSUER_ROLE, identityIssuer);
    }

    // ---------------------------------------------------------------- issuance

    /// @notice Register an address against an Identity Authority identity commitment.
    function register(address account, bytes32 identity, uint8 tier) external onlyRole(ISSUER_ROLE) {
        if (tier < MIN_TIER || tier > MAX_TIER) revert InvalidTier(tier);
        if (_attestations[account].status != Status.None) revert AlreadyRegistered(account);

        uint32 quota = addressQuota(identity);
        if (addressCount[identity] >= quota) revert QuotaExceeded(identity, quota);

        addressCount[identity] += 1;
        _attestations[account] = Attestation({
            identity: identity,
            tier: tier,
            status: Status.Active,
            issuedAt: uint64(block.timestamp)
        });
        emit AddressRegistered(account, identity, tier);
    }

    /// @notice Permanently revoke an address. Frees the identity's address slot.
    function revoke(address account) external onlyRole(ISSUER_ROLE) {
        Attestation storage a = _attestations[account];
        if (a.status != Status.Active && a.status != Status.Suspended) revert NotRegistered(account);

        addressCount[a.identity] -= 1;
        a.status = Status.Revoked;
        emit AddressRevoked(account, a.identity);
    }

    /// @notice Temporarily suspend an address (e.g. pending re-verification).
    function suspend(address account) external onlyRole(ISSUER_ROLE) {
        Attestation storage a = _attestations[account];
        if (a.status != Status.Active) revert WrongStatus(account, a.status);
        a.status = Status.Suspended;
        emit AddressSuspended(account, a.identity);
    }

    function reactivate(address account) external onlyRole(ISSUER_ROLE) {
        Attestation storage a = _attestations[account];
        if (a.status != Status.Suspended) revert WrongStatus(account, a.status);
        a.status = Status.Active;
        emit AddressReactivated(account, a.identity);
    }

    function setTier(address account, uint8 newTier) external onlyRole(ISSUER_ROLE) {
        if (newTier < MIN_TIER || newTier > MAX_TIER) revert InvalidTier(newTier);
        Attestation storage a = _attestations[account];
        if (a.status != Status.Active && a.status != Status.Suspended) revert NotRegistered(account);
        uint8 old = a.tier;
        a.tier = newTier;
        emit TierChanged(account, old, newTier);
    }

    /**
     * @notice Grant an identity additional address slots after an off-chain fee
     *         payment to the Identity Authority. `paymentRef` is the Identity Authority receipt/ledger reference.
     */
    function increaseAddressQuota(bytes32 identity, uint32 newQuota, bytes32 paymentRef)
        external
        onlyRole(ISSUER_ROLE)
    {
        require(newQuota > addressQuota(identity), "quota can only increase");
        _addressQuota[identity] = newQuota;
        emit AddressQuotaIncreased(identity, newQuota, paymentRef);
    }

    // ------------------------------------------------------------------- views

    function addressQuota(bytes32 identity) public view returns (uint32) {
        uint32 q = _addressQuota[identity];
        return q == 0 ? 1 : q;
    }

    function attestationOf(address account) external view returns (Attestation memory) {
        return _attestations[account];
    }

    /// @notice True when the address holds a currently active KYC attestation.
    function isActive(address account) external view returns (bool) {
        return _attestations[account].status == Status.Active;
    }

    /// @notice Tier of an active address; 0 for anything not currently active.
    function tierOf(address account) external view returns (uint8) {
        Attestation storage a = _attestations[account];
        return a.status == Status.Active ? a.tier : 0;
    }
}
