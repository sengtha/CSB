// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {LandTitleRegistry} from "./LandTitleRegistry.sol";

/**
 * @title LandCollateralVault
 * @notice Borrow tokenized riel against tokenized land.
 *
 * This exists to make the composability claim concrete rather than assert it.
 * Nothing here required cooperation from whoever issued the title: the vault
 * checks with LandTitleRegistry that the collateral is a genuinely registered
 * parcel, holds the shares while a loan is outstanding, and returns them on
 * repayment. A third-party developer could have written it, which is the point —
 * putting titles on a shared ledger lets a credit market form around them
 * without the registrar building one.
 *
 * Deliberately simple, and honest about it. A real lender needs a price oracle,
 * liquidation auctions, interest accrual, and a legal route to enforce against
 * the underlying parcel. What is modelled here is only the mechanism: collateral
 * in, credit out, collateral released on repayment, seizure on default. Valuation
 * is set by the lender per loan rather than discovered, because a land oracle is
 * a genuinely hard problem and pretending otherwise would be the dishonest part.
 *
 * PLACEHOLDER / DEMONSTRATION ONLY — not a lending product, not audited, and
 * operating on valueless test tokens.
 */
contract LandCollateralVault is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Funds the vault and sets loan terms (a licensed lender).
    bytes32 public constant LENDER_ROLE = keccak256("LENDER_ROLE");

    struct Loan {
        address borrower;
        address titleToken;
        uint256 shares; // collateral held
        uint256 principal; // KHRt owed
        uint64 dueAt;
        bool active;
    }

    LandTitleRegistry public immutable titles;
    IERC20 public immutable currency; // KHRt

    mapping(uint256 => Loan) private _loans;
    uint256 public loanCount;
    mapping(address => uint256[]) private _loansOf;

    event LoanOpened(
        uint256 indexed loanId, address indexed borrower, address indexed titleToken, uint256 shares, uint256 principal, uint64 dueAt
    );
    event LoanRepaid(uint256 indexed loanId, address indexed borrower, uint256 principal);
    event CollateralSeized(uint256 indexed loanId, address indexed borrower, address indexed to, uint256 shares);

    error NotARegisteredTitle(address token);
    error LoanNotActive(uint256 loanId);
    error NotBorrower(uint256 loanId, address caller);
    error NotYetDue(uint256 loanId, uint64 dueAt);
    error ZeroAmount();

    constructor(LandTitleRegistry titles_, IERC20 currency_, address councilAdmin, address lender) {
        titles = titles_;
        currency = currency_;
        _grantRole(DEFAULT_ADMIN_ROLE, councilAdmin);
        _grantRole(LENDER_ROLE, lender);
    }

    /**
     * @notice Open a loan against land shares.
     * @dev The borrower must have approved `shares` of the title token, and the
     *      vault must hold enough currency to lend. Terms are set by the lender,
     *      hence LENDER_ROLE: this models a licensed lender's book, not an
     *      open borrowing pool.
     *
     *      The registry check is the load-bearing line. Without it the vault
     *      would accept any ERC-20 that looked like a title.
     */
    function openLoan(address borrower, address titleToken, uint256 shares, uint256 principal, uint64 dueAt)
        external
        onlyRole(LENDER_ROLE)
        nonReentrant
        returns (uint256 loanId)
    {
        if (shares == 0 || principal == 0) revert ZeroAmount();
        if (!titles.isRegisteredTitle(titleToken)) revert NotARegisteredTitle(titleToken);

        IERC20(titleToken).safeTransferFrom(borrower, address(this), shares);
        currency.safeTransfer(borrower, principal);

        loanId = ++loanCount;
        _loans[loanId] = Loan({
            borrower: borrower,
            titleToken: titleToken,
            shares: shares,
            principal: principal,
            dueAt: dueAt,
            active: true
        });
        _loansOf[borrower].push(loanId);
        emit LoanOpened(loanId, borrower, titleToken, shares, principal, dueAt);
    }

    /// @notice Repay in full and take the land shares back.
    function repay(uint256 loanId) external nonReentrant {
        Loan storage l = _loans[loanId];
        if (!l.active) revert LoanNotActive(loanId);
        if (_msgSender() != l.borrower) revert NotBorrower(loanId, _msgSender());

        l.active = false;
        currency.safeTransferFrom(_msgSender(), address(this), l.principal);
        IERC20(l.titleToken).safeTransfer(l.borrower, l.shares);
        emit LoanRepaid(loanId, l.borrower, l.principal);
    }

    /**
     * @notice Take the collateral after default.
     * @dev Only once the term has actually expired. The recipient must itself be
     *      able to hold the title — the token's own compliance rules apply to a
     *      lender exactly as they do to anyone else, so seizing collateral cannot
     *      route land to an address the registry has not verified.
     */
    function seize(uint256 loanId, address to) external onlyRole(LENDER_ROLE) nonReentrant {
        Loan storage l = _loans[loanId];
        if (!l.active) revert LoanNotActive(loanId);
        if (block.timestamp <= l.dueAt) revert NotYetDue(loanId, l.dueAt);

        l.active = false;
        IERC20(l.titleToken).safeTransfer(to, l.shares);
        emit CollateralSeized(loanId, l.borrower, to, l.shares);
    }

    /// @notice Lender tops up the vault's lendable currency.
    function fund(uint256 amount) external {
        currency.safeTransferFrom(_msgSender(), address(this), amount);
    }

    /// @notice Lender withdraws currency that is not lent out.
    function withdraw(address to, uint256 amount) external onlyRole(LENDER_ROLE) {
        currency.safeTransfer(to, amount);
    }

    // ----------------------------------------------------------------- views

    function loanOf(uint256 loanId) external view returns (Loan memory) {
        return _loans[loanId];
    }

    function loansOf(address borrower) external view returns (uint256[] memory) {
        return _loansOf[borrower];
    }
}
