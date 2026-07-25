// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title MerchantRegistry
 * @notice What kind of business an address is — the licensing layer that
 *         "assigned spend target" money is checked against.
 *
 * Deliberately separate from SocialProgramRegistry, because these are two
 * different powers held by two different authorities, and collapsing them would
 * let one office both decide who counts as a grocer and decide what aid may buy.
 * Here: a licensing registrar records that an address is a licensed food shop.
 * There: a social-policy authority decides that food aid may be spent at food
 * shops. Same separation-of-powers logic as identity vs. enforcement elsewhere
 * in CSB.
 *
 * Categories are a bitmask so one merchant can hold several licences (a shop
 * that sells food and medicine) and a programme can permit several at once.
 *
 * PLACEHOLDER: "licensing registrar" is a hypothetical role. No real ministry,
 * agency, or company is implied or involved.
 */
contract MerchantRegistry is AccessControl {
    /// @notice Records and revokes merchant licences (a licensing authority).
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    // Category bits. Values are part of the ABI — append, never renumber.
    uint32 public constant FOOD = 1 << 0;
    uint32 public constant MEDICINE = 1 << 1;
    uint32 public constant EDUCATION = 1 << 2;
    uint32 public constant UTILITIES = 1 << 3;
    uint32 public constant TRANSPORT = 1 << 4;
    uint32 public constant AGRICULTURE = 1 << 5;

    struct Merchant {
        uint32 categories; // bitmask of the licences held
        bool suspended; // licence temporarily withdrawn
        string label; // e.g. "Psar Thmei grocery stall 14"
        uint64 registeredAt;
    }

    mapping(address => Merchant) private _merchants;

    event MerchantRegistered(address indexed merchant, uint32 categories, string label);
    event MerchantCategoriesChanged(address indexed merchant, uint32 oldCategories, uint32 newCategories);
    event MerchantSuspended(address indexed merchant, bool suspended);
    event MerchantRemoved(address indexed merchant);

    error NotRegistered(address merchant);
    error NoCategories();

    constructor(address councilAdmin, address registrar) {
        _grantRole(DEFAULT_ADMIN_ROLE, councilAdmin);
        _grantRole(REGISTRAR_ROLE, registrar);
    }

    // ------------------------------------------------------------- registrar

    function registerMerchant(address merchant, uint32 categories, string calldata label)
        external
        onlyRole(REGISTRAR_ROLE)
    {
        if (categories == 0) revert NoCategories();
        Merchant storage m = _merchants[merchant];
        uint32 old = m.categories;
        m.categories = categories;
        m.label = label;
        if (m.registeredAt == 0) {
            m.registeredAt = uint64(block.timestamp);
            emit MerchantRegistered(merchant, categories, label);
        } else {
            emit MerchantCategoriesChanged(merchant, old, categories);
        }
    }

    /// @notice Withdraw or restore a licence without losing the registration
    ///         record — an audit trail matters more than a tidy mapping.
    function setSuspended(address merchant, bool suspended) external onlyRole(REGISTRAR_ROLE) {
        if (_merchants[merchant].registeredAt == 0) revert NotRegistered(merchant);
        _merchants[merchant].suspended = suspended;
        emit MerchantSuspended(merchant, suspended);
    }

    function removeMerchant(address merchant) external onlyRole(REGISTRAR_ROLE) {
        if (_merchants[merchant].registeredAt == 0) revert NotRegistered(merchant);
        delete _merchants[merchant];
        emit MerchantRemoved(merchant);
    }

    // ----------------------------------------------------------------- views

    function merchantOf(address merchant) external view returns (Merchant memory) {
        return _merchants[merchant];
    }

    function categoriesOf(address merchant) external view returns (uint32) {
        return _merchants[merchant].categories;
    }

    function isSuspended(address merchant) external view returns (bool) {
        return _merchants[merchant].suspended;
    }

    function isRegistered(address merchant) external view returns (bool) {
        return _merchants[merchant].registeredAt != 0;
    }

    /// @notice Does this merchant hold *any* of the licences in `mask`, and is
    ///         it currently in good standing?
    function hasAnyCategory(address merchant, uint32 mask) external view returns (bool) {
        Merchant storage m = _merchants[merchant];
        if (m.registeredAt == 0 || m.suspended) return false;
        return (m.categories & mask) != 0;
    }
}
