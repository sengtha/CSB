// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ISpendPolicy} from "./ISpendPolicy.sol";
import {MerchantRegistry} from "./MerchantRegistry.sol";

/**
 * @title SocialProgramRegistry
 * @notice Social-transfer programmes and what their money is allowed to buy.
 *
 * This is the policy half of "assigned spend target": a programme says *which
 * categories of merchant* its money may reach (food, medicine, school fees), and
 * the token enforces it at transfer time. Cash aid that can only be spent on
 * food is not a report produced after the fact — it is a property of the money
 * itself.
 *
 * What it deliberately does NOT do: name the beneficiaries. The registry holds
 * programme rules, not a list of who is poor. Eligibility stays in the
 * administering agency's own records, and on chain a beneficiary is an address
 * holding an earmark — consistent with CSB's no-PII-on-chain rule, and important
 * for a programme where the recipient list is itself sensitive.
 *
 * PLACEHOLDER: "administering agency" is a hypothetical role. No real programme,
 * ministry, or beneficiary is implied. On the ID Poor programme specifically:
 * this models the *idea* of targeted social transfers. It is not built with,
 * for, or on behalf of anyone who runs such a programme.
 */
contract SocialProgramRegistry is AccessControl, ISpendPolicy {
    /// @notice Creates and configures programmes (a social-policy authority).
    bytes32 public constant PROGRAM_ADMIN_ROLE = keccak256("PROGRAM_ADMIN_ROLE");

    struct Program {
        string label;
        uint32 allowedCategories; // bitmask matched against MerchantRegistry
        uint64 expiresAt; // 0 = no expiry
        bool active;
        bool allowMerchantToMerchant; // may a paid merchant re-spend under the rules?
    }

    MerchantRegistry public immutable merchants;

    mapping(uint32 => Program) private _programs;
    uint32 public programCount;

    event ProgramCreated(uint32 indexed programId, string label, uint32 allowedCategories, uint64 expiresAt);
    event ProgramUpdated(uint32 indexed programId, uint32 allowedCategories, uint64 expiresAt);
    event ProgramActiveSet(uint32 indexed programId, bool active);

    error UnknownProgram(uint32 programId);
    error NoCategories();

    constructor(MerchantRegistry merchants_, address councilAdmin, address programAdmin) {
        merchants = merchants_;
        _grantRole(DEFAULT_ADMIN_ROLE, councilAdmin);
        _grantRole(PROGRAM_ADMIN_ROLE, programAdmin);
    }

    // ------------------------------------------------------------ programmes

    function createProgram(string calldata label, uint32 allowedCategories, uint64 expiresAt)
        external
        onlyRole(PROGRAM_ADMIN_ROLE)
        returns (uint32 programId)
    {
        if (allowedCategories == 0) revert NoCategories();
        programId = ++programCount; // ids start at 1; 0 means "not earmarked"
        _programs[programId] = Program({
            label: label,
            allowedCategories: allowedCategories,
            expiresAt: expiresAt,
            active: true,
            allowMerchantToMerchant: false
        });
        emit ProgramCreated(programId, label, allowedCategories, expiresAt);
    }

    function updateProgram(uint32 programId, uint32 allowedCategories, uint64 expiresAt)
        external
        onlyRole(PROGRAM_ADMIN_ROLE)
    {
        Program storage p = _requireProgram(programId);
        if (allowedCategories == 0) revert NoCategories();
        p.allowedCategories = allowedCategories;
        p.expiresAt = expiresAt;
        emit ProgramUpdated(programId, allowedCategories, expiresAt);
    }

    function setProgramActive(uint32 programId, bool active) external onlyRole(PROGRAM_ADMIN_ROLE) {
        _requireProgram(programId).active = active;
        emit ProgramActiveSet(programId, active);
    }

    // ------------------------------------------------------------- ISpendPolicy

    /**
     * @dev Note this never reverts, per the interface contract: an unknown or
     *      expired programme returns false so the transfer is declined, rather
     *      than throwing and taking down every payment the account attempts.
     */
    function isSpendAllowed(uint32 programId, address, address to) public view returns (bool) {
        Program storage p = _programs[programId];
        if (!p.active || p.allowedCategories == 0) return false;
        if (p.expiresAt != 0 && block.timestamp > p.expiresAt) return false;
        return merchants.hasAnyCategory(to, p.allowedCategories);
    }

    /// @notice Why a spend would be declined — for wallets to show something
    ///         better than a bare revert. Order matches isSpendAllowed.
    function declineReason(uint32 programId, address, address to) external view returns (string memory) {
        Program storage p = _programs[programId];
        if (p.allowedCategories == 0) return "no such assistance programme";
        if (!p.active) return "this assistance programme is not active";
        if (p.expiresAt != 0 && block.timestamp > p.expiresAt) return "this assistance programme has expired";
        if (!merchants.isRegistered(to)) return "the recipient is not a registered merchant";
        if (merchants.isSuspended(to)) return "the recipient's merchant licence is suspended";
        if (!merchants.hasAnyCategory(to, p.allowedCategories)) {
            return "this assistance can only be spent at merchants in the permitted categories";
        }
        return "";
    }

    // ----------------------------------------------------------------- views

    function programOf(uint32 programId) external view returns (Program memory) {
        return _programs[programId];
    }

    function isProgramActive(uint32 programId) external view returns (bool) {
        Program storage p = _programs[programId];
        return p.active && p.allowedCategories != 0 && (p.expiresAt == 0 || block.timestamp <= p.expiresAt);
    }

    function _requireProgram(uint32 programId) private view returns (Program storage p) {
        p = _programs[programId];
        if (p.allowedCategories == 0) revert UnknownProgram(programId);
    }
}
