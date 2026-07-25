// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IdentityRegistry} from "../identity/IdentityRegistry.sol";
import {EnforcementRegistry} from "../enforcement/EnforcementRegistry.sol";
import {ISpendPolicy} from "../social/ISpendPolicy.sol";

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
    /// @dev Administrative move (clawback): skips compliance checks and the levy
    ///      the same way enforcement does, but is a separate flag so the two
    ///      powers stay distinguishable in the code that reads them.
    bool private _inAdminMove;

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

    /**
     * @notice Assigned spend target — the programmable-money half of KHRt.
     *
     * A social transfer is issued as an *earmarked* balance: the tokens are
     * ordinary KHRt, but `restrictedBalance` of them may only move to a
     * recipient the programme's policy permits (a licensed food merchant, say).
     * Everything else the holder owns stays ordinary money they control.
     *
     * Two properties make this actually mean something:
     *  - Restricted funds are spent FIRST on a permitted payment, so aid is used
     *    for its purpose before the holder's own money is touched.
     *  - A payment to a non-permitted recipient may only draw on the
     *    unrestricted balance, and reverts if that is not enough. This is what
     *    stops aid being handed to a moneylender.
     *
     * The earmark does NOT follow the money: the merchant receives ordinary
     * KHRt. A restriction that propagated forever would make the token
     * unbankable and quietly turn recipients into second-class holders.
     */
    ISpendPolicy public spendPolicy;
    mapping(address => uint256) public restrictedBalance;
    mapping(address => uint32) public restrictedProgram;
    uint256 public totalRestricted;

    event Issued(address indexed to, uint256 amount);
    event Redeemed(address indexed from, uint256 amount);
    event Confiscated(address indexed from, address indexed to, uint256 amount, bytes32 indexed orderRef);
    event TierTransferCapSet(uint8 indexed tier, uint256 cap);
    event SystemContractSet(address indexed account, bool allowed);
    event TransferLevySet(uint256 levy, address indexed recipient);
    event LevyExemptSet(address indexed account, bool exempt);
    event LevyCollected(address indexed from, address indexed recipient, uint256 amount);
    event SpendPolicySet(address indexed policy);
    event RestrictedIssued(address indexed to, uint256 amount, uint32 indexed programId);
    event RestrictedSpent(address indexed from, address indexed to, uint256 amount, uint32 indexed programId);
    event RestrictedClawedBack(address indexed from, address indexed to, uint256 amount, bytes32 reason);

    error NotKycActive(address account);
    error AccountFrozen(address account);
    error TierCapExceeded(address account, uint8 tier, uint256 cap, uint256 amount);
    error OrderRefRequired();
    error LevyRecipientRequired();
    /// @dev Raised when a payment would have to draw on earmarked funds to reach
    ///      a recipient the programme does not permit. `available` is the
    ///      holder's own (unrestricted) balance.
    error SpendTargetNotPermitted(address from, address to, uint256 requested, uint256 available, uint32 programId);
    error NoSpendPolicy();
    error ProgramRequired();
    error RestrictedBalanceExceeded(address account, uint256 restricted, uint256 amount);

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

    // ------------------------------------------------- assigned spend target

    /**
     * @notice Issue an earmarked social transfer: real KHRt that can only be
     *         spent where programme `programId` permits.
     * @dev A holder carries one programme at a time. Topping up the same
     *      programme adds to the earmark; switching programmes while an earmark
     *      is still unspent is refused rather than silently relabelling money
     *      that was granted under different rules.
     */
    function issueRestricted(address to, uint256 amount, uint32 programId) external onlyRole(ISSUER_ROLE) {
        if (programId == 0) revert ProgramRequired();
        if (address(spendPolicy) == address(0)) revert NoSpendPolicy();
        uint32 current = restrictedProgram[to];
        if (current != 0 && current != programId && restrictedBalance[to] > 0) {
            revert ProgramRequired();
        }
        _mint(to, amount);
        restrictedBalance[to] += amount;
        restrictedProgram[to] = programId;
        totalRestricted += amount;
        emit Issued(to, amount);
        emit RestrictedIssued(to, amount, programId);
    }

    /**
     * @notice Recover unspent earmarked funds — a programme closing, an
     *         eligibility change, an expired grant.
     * @dev Deliberately narrow: it can only reach the *earmarked* portion, never
     *      money the holder earned or was given otherwise. The power to place a
     *      restriction should not become a general power to take.
     */
    function clawbackRestricted(address from, uint256 amount, bytes32 reason) external onlyRole(ISSUER_ROLE) {
        uint256 r = restrictedBalance[from];
        if (amount > r) revert RestrictedBalanceExceeded(from, r, amount);
        restrictedBalance[from] = r - amount;
        totalRestricted -= amount;
        _inAdminMove = true;
        _update(from, _msgSender(), amount);
        _inAdminMove = false;
        emit RestrictedClawedBack(from, _msgSender(), amount, reason);
    }

    /// @notice The holder's own money — what they may spend anywhere.
    function unrestrictedBalanceOf(address account) public view returns (uint256) {
        uint256 bal = balanceOf(account);
        uint256 r = restrictedBalance[account];
        return bal > r ? bal - r : 0;
    }

    /// @notice Would this payment be allowed, and if not, why? Lets a wallet
    ///         explain the refusal before the user signs anything.
    function canSpend(address from, address to, uint256 amount)
        external
        view
        returns (bool allowed, string memory reason)
    {
        uint256 r = restrictedBalance[from];
        if (r == 0) return (amount <= balanceOf(from), amount <= balanceOf(from) ? "" : "insufficient balance");
        uint32 programId = restrictedProgram[from];
        if (address(spendPolicy) != address(0) && spendPolicy.isSpendAllowed(programId, from, to)) {
            return (amount <= balanceOf(from), amount <= balanceOf(from) ? "" : "insufficient balance");
        }
        uint256 free = unrestrictedBalanceOf(from);
        if (amount <= free) return (true, "");
        string memory why = address(spendPolicy) == address(0)
            ? "assistance funds cannot be spent while no programme policy is set"
            : spendPolicy.declineReason(programId, from, to);
        return (false, why);
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

    /// @notice Set (or clear) the policy that decides where earmarked social
    ///         transfers may be spent. Clearing it leaves existing earmarks
    ///         spendable only as the holder's own money would be — restrictive,
    ///         not permissive, so removing the policy cannot unlock aid.
    function setSpendPolicy(ISpendPolicy policy) external onlyRole(DEFAULT_ADMIN_ROLE) {
        spendPolicy = policy;
        emit SpendPolicySet(address(policy));
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
        if (_inEnforcement || _inAdminMove) return 0;       // enforcement / clawback untaxed
        if (from == address(0) || to == address(0)) return 0; // mint / burn untaxed
        if (from == levyRecipient || to == levyRecipient) return 0; // fund's own flows
        if (levyExempt[from] || levyExempt[to]) return 0;
        if (isSystemContract[from] || isSystemContract[to]) return 0; // bridges/converter
        if (value <= transferLevy) return 0;                // don't zero-out tiny transfers
        return transferLevy;
    }

    // -------------------------------------------------------------- compliance

    function _update(address from, address to, uint256 value) internal override {
        bool bypass = _inEnforcement || _inAdminMove;
        if (!bypass) {
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
        bool spentRestricted = _applySpendTarget(from, to, value, bypass);
        // Aid is not taxed: a levy on a food payment made with assistance money
        // would take the fee out of the assistance itself.
        uint256 levy = spentRestricted ? 0 : _levyOn(from, to, value);
        if (levy > 0) {
            super._update(from, levyRecipient, levy);   // public-good slice to the fund
            super._update(from, to, value - levy);      // remainder to the payee
            totalLevied += levy;
            emit LevyCollected(from, levyRecipient, levy);
        } else {
            super._update(from, to, value);
        }
    }

    /**
     * @dev Enforce the assigned spend target and consume the earmark.
     * @return spentRestricted whether any earmarked funds were used.
     *
     * Called with the balances as they stand BEFORE the transfer, which is what
     * makes `balanceOf(from) - restricted` the correct free balance here.
     *
     * Burns are exempt: `_burn` is only reachable through `redeem`, where the
     * issuer burns its own balance, so there is no path for a holder to destroy
     * an earmark to escape it.
     */
    function _applySpendTarget(address from, address to, uint256 value, bool bypass) private returns (bool) {
        if (bypass || from == address(0) || to == address(0)) return false;
        uint256 restricted = restrictedBalance[from];
        if (restricted == 0) return false;

        uint32 programId = restrictedProgram[from];
        bool permitted = address(spendPolicy) != address(0) && spendPolicy.isSpendAllowed(programId, from, to);

        if (!permitted) {
            // Only the holder's own money may go here.
            uint256 free = balanceOf(from) - restricted;
            if (value > free) {
                revert SpendTargetNotPermitted(from, to, value, free, programId);
            }
            return false;
        }

        // Permitted: spend the earmark first, so assistance is used for its
        // purpose before the holder's own money is drawn down.
        uint256 used = value > restricted ? restricted : value;
        restrictedBalance[from] = restricted - used;
        totalRestricted -= used;
        emit RestrictedSpent(from, to, used, programId);
        return true;
    }

    function _requireEligible(address account) private view {
        if (enforcement.isFrozen(account)) revert AccountFrozen(account);
        if (!isSystemContract[account] && !identity.isActive(account)) revert NotKycActive(account);
    }
}
