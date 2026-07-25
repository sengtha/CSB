// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title PaymentEscrow
 * @notice Hold a buyer's payment until the job is done, then settle it to every
 *         party at once.
 *
 * The delivery case: a customer pays 20,000 riel for an order. That single
 * payment is really three — the restaurant, the rider, and the platform's
 * commission. Today the platform collects everything and pays the others later,
 * so the rider is an unsecured creditor of the platform and the customer has no
 * idea what share reaches whom.
 *
 * Here the split is declared WHEN THE ORDER IS CREATED, before the buyer parts
 * with any money, and settles atomically on release. Two consequences worth
 * naming:
 *
 *  - The buyer can see, before paying, exactly what the rider gets. That is a
 *    different relationship from "the platform will sort it out".
 *  - Nobody is trusted to forward anything. Either every payee is paid in the
 *    same transaction or none is, so a platform that goes under mid-delivery
 *    cannot take the rider's fare with it.
 *
 * Money is held by the contract, not by the platform. Releasing it requires the
 * buyer's confirmation, an arbiter's decision, or the deadline passing — and the
 * escrow itself can never move funds anywhere the order did not specify.
 *
 * Compliance is not suspended in here. A payee frozen by an enforcement order
 * cannot be paid, which makes the whole release revert; the arbiter's route is
 * then to refund the buyer. That ordering is deliberate — an enforcement freeze
 * should outrank a commercial obligation, not be worked around by an escrow.
 *
 * PLACEHOLDER: "arbiter" is a hypothetical dispute-resolution role. This is a
 * demonstration on a test network, not a payments product.
 */
contract PaymentEscrow is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Resolves disputes: may release to the payees or refund the buyer.
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    enum Status {
        None,
        Created, // split agreed, nothing paid yet
        Funded, // buyer's money is held here
        Released, // settled to the payees
        Refunded, // returned to the buyer
        Disputed // contested; only the arbiter can end it
    }

    struct Order {
        bytes32 ref; // off-chain order reference (receipt, tracking number)
        address payer;
        address token;
        uint256 total;
        uint64 deadline; // after this, an unreleased order can be reclaimed
        Status status;
        address[] payees;
        uint256[] amounts;
    }

    mapping(uint256 => Order) private _orders;
    uint256 public orderCount;
    mapping(address => uint256[]) private _ordersOf;

    event OrderCreated(
        uint256 indexed orderId, bytes32 indexed ref, address indexed payer, address token, uint256 total, uint64 deadline
    );
    event OrderFunded(uint256 indexed orderId, address indexed payer, uint256 total);
    event OrderReleased(uint256 indexed orderId, address indexed by, uint256 payeeCount, uint256 total);
    event PayeePaid(uint256 indexed orderId, address indexed payee, uint256 amount);
    event OrderRefunded(uint256 indexed orderId, address indexed to, uint256 total, bytes32 reason);
    event OrderDisputed(uint256 indexed orderId, address indexed by);

    error NotPayer(uint256 orderId, address caller);
    error WrongStatus(uint256 orderId, Status actual, Status required);
    error PayeesRequired();
    error LengthMismatch(uint256 payees, uint256 amounts);
    error ZeroAmount();
    error ZeroAddress();
    error DeadlineInPast(uint64 deadline);
    error DeadlineNotReached(uint256 orderId, uint64 deadline);
    error NotAParty(uint256 orderId, address caller);
    error ReasonRequired();

    constructor(address councilAdmin, address arbiter) {
        _grantRole(DEFAULT_ADMIN_ROLE, councilAdmin);
        _grantRole(ARBITER_ROLE, arbiter);
    }

    // ------------------------------------------------------------- lifecycle

    /**
     * @notice Agree an order and its split. No money moves yet.
     * @dev Open to anyone: an unfunded order costs nobody anything, and
     *      restricting creation to a merchant role would make the platform a
     *      gatekeeper of the very arrangement this exists to make transparent.
     *      The total is derived from the split rather than passed in, so the
     *      amount the buyer pays can never disagree with the sum of the parts.
     */
    function createOrder(
        bytes32 ref,
        address payer,
        address token,
        address[] calldata payees,
        uint256[] calldata amounts,
        uint64 deadline
    ) external returns (uint256 orderId) {
        if (payees.length == 0) revert PayeesRequired();
        if (payees.length != amounts.length) revert LengthMismatch(payees.length, amounts.length);
        if (payer == address(0) || token == address(0)) revert ZeroAddress();
        if (deadline <= block.timestamp) revert DeadlineInPast(deadline);

        uint256 total;
        for (uint256 i = 0; i < payees.length; i++) {
            if (payees[i] == address(0)) revert ZeroAddress();
            if (amounts[i] == 0) revert ZeroAmount();
            total += amounts[i];
        }

        orderId = ++orderCount;
        Order storage o = _orders[orderId];
        o.ref = ref;
        o.payer = payer;
        o.token = token;
        o.total = total;
        o.deadline = deadline;
        o.status = Status.Created;
        o.payees = payees;
        o.amounts = amounts;
        _ordersOf[payer].push(orderId);

        emit OrderCreated(orderId, ref, payer, token, total, deadline);
    }

    /// @notice Buyer pays into escrow. Requires an ERC20 approval for `total`.
    function fund(uint256 orderId) external nonReentrant {
        Order storage o = _require(orderId, Status.Created);
        if (_msgSender() != o.payer) revert NotPayer(orderId, _msgSender());
        o.status = Status.Funded;
        IERC20(o.token).safeTransferFrom(o.payer, address(this), o.total);
        emit OrderFunded(orderId, o.payer, o.total);
    }

    /// @notice Buyer confirms the job is done; everyone is paid in this call.
    function confirmAndRelease(uint256 orderId) external nonReentrant {
        Order storage o = _require(orderId, Status.Funded);
        if (_msgSender() != o.payer) revert NotPayer(orderId, _msgSender());
        _release(orderId, o);
    }

    /**
     * @notice Arbiter settles to the payees — the delivered-but-buyer-silent case.
     * @dev Works on a disputed order too; that is the point of an arbiter.
     */
    function releaseByArbiter(uint256 orderId, bytes32 reason) external onlyRole(ARBITER_ROLE) nonReentrant {
        if (reason == bytes32(0)) revert ReasonRequired();
        Order storage o = _orders[orderId];
        if (o.status != Status.Funded && o.status != Status.Disputed) {
            revert WrongStatus(orderId, o.status, Status.Funded);
        }
        _release(orderId, o);
    }

    /// @notice Arbiter returns the money to the buyer — order failed, or a payee
    ///         can no longer legally be paid.
    function refundByArbiter(uint256 orderId, bytes32 reason) external onlyRole(ARBITER_ROLE) nonReentrant {
        if (reason == bytes32(0)) revert ReasonRequired();
        Order storage o = _orders[orderId];
        if (o.status != Status.Funded && o.status != Status.Disputed) {
            revert WrongStatus(orderId, o.status, Status.Funded);
        }
        _refund(orderId, o, reason);
    }

    /**
     * @notice Buyer takes their money back after the deadline, if the order was
     *         never released.
     * @dev Blocked once disputed: otherwise a buyer could stall past the
     *      deadline and reclaim money for goods they actually received.
     */
    function reclaimAfterDeadline(uint256 orderId) external nonReentrant {
        Order storage o = _require(orderId, Status.Funded);
        if (_msgSender() != o.payer) revert NotPayer(orderId, _msgSender());
        if (block.timestamp <= o.deadline) revert DeadlineNotReached(orderId, o.deadline);
        _refund(orderId, o, "deadline passed");
    }

    /// @notice Buyer or any payee contests the order, freezing it for the arbiter.
    function raiseDispute(uint256 orderId) external {
        Order storage o = _require(orderId, Status.Funded);
        if (_msgSender() != o.payer && !_isPayee(o, _msgSender())) revert NotAParty(orderId, _msgSender());
        o.status = Status.Disputed;
        emit OrderDisputed(orderId, _msgSender());
    }

    // ---------------------------------------------------------------- internal

    function _release(uint256 orderId, Order storage o) private {
        o.status = Status.Released;
        uint256 n = o.payees.length;
        // All or nothing: a payee the token refuses — frozen, or KYC revoked —
        // reverts the whole settlement rather than paying the others and leaving
        // a remainder stranded in escrow with no owner.
        for (uint256 i = 0; i < n; i++) {
            IERC20(o.token).safeTransfer(o.payees[i], o.amounts[i]);
            emit PayeePaid(orderId, o.payees[i], o.amounts[i]);
        }
        emit OrderReleased(orderId, _msgSender(), n, o.total);
    }

    function _refund(uint256 orderId, Order storage o, bytes32 reason) private {
        o.status = Status.Refunded;
        IERC20(o.token).safeTransfer(o.payer, o.total);
        emit OrderRefunded(orderId, o.payer, o.total, reason);
    }

    function _require(uint256 orderId, Status required) private view returns (Order storage o) {
        o = _orders[orderId];
        if (o.status != required) revert WrongStatus(orderId, o.status, required);
    }

    function _isPayee(Order storage o, address who) private view returns (bool) {
        for (uint256 i = 0; i < o.payees.length; i++) {
            if (o.payees[i] == who) return true;
        }
        return false;
    }

    // ------------------------------------------------------------------ views

    function orderOf(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function splitOf(uint256 orderId) external view returns (address[] memory payees, uint256[] memory amounts) {
        Order storage o = _orders[orderId];
        return (o.payees, o.amounts);
    }

    function ordersOf(address payer) external view returns (uint256[] memory) {
        return _ordersOf[payer];
    }

    /// @notice Would a release succeed right now? Lets a UI warn before anyone
    ///         signs, instead of surfacing a compliance rule as a failed
    ///         transaction.
    function canRelease(uint256 orderId) external view returns (bool ok, string memory reason) {
        Order storage o = _orders[orderId];
        if (o.status != Status.Funded && o.status != Status.Disputed) return (false, "order is not awaiting release");
        if (IERC20(o.token).balanceOf(address(this)) < o.total) return (false, "escrow does not hold the full amount");
        return (true, "");
    }
}
