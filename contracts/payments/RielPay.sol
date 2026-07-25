// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title RielPay
 * @notice Native-tRIEL payments with an optional, council-governed public-good
 *         levy. Lets CSB be fully usable **before any tokenized-riel stablecoin
 *         (KHRt) is licensed** — users transact in tRIEL (the riel-pegged base
 *         coin) directly, so nobody is stuck waiting for KHRt.
 *
 *  Design goals:
 *   - **Flexible / non-blocking.** The levy is OFF by default (`levyBps == 0`),
 *     so payments are free until the council deliberately turns it on. It can be
 *     re-disabled or paused at any time. CSB never depends on the levy to work.
 *   - **Optional public-good funding.** When enabled, a portion of each payment
 *     routes to a `publicFund` address (e.g. a hospital fund), transparently —
 *     `totalRaised` and `Paid` events let the explorer show what was collected.
 *   - **Targetable.** Either party can be marked `levyExempt`, so e.g. citizen
 *     P2P can be exempt while merchant/commercial flows are levied.
 *
 *  KYC note: sending a payment is a transaction, so the sender is already gated
 *  by the chain's txAllowList precompile — only KYC-provisioned addresses can
 *  call `pay`. No extra identity check is needed here.
 *
 *  Direct wallet-to-wallet tRIEL transfers bypass this contract entirely (and
 *  are free); `RielPay` is for payments that want a memo/receipt and/or the levy.
 */
contract RielPay is AccessControl, ReentrancyGuard, Pausable {
    bytes32 public constant COUNCIL_ROLE = keccak256("COUNCIL_ROLE");

    uint16 public constant BPS_DENOMINATOR = 10000; // 100.00%
    uint16 public constant MAX_LEVY_BPS = 1000;     // hard cap: 10%

    /// @notice Where the levy goes. address(0) disables the levy.
    address public publicFund;
    /// @notice Levy in basis points. 0 = free (default).
    uint16 public levyBps;
    /// @notice Payer or payee exempt from the levy.
    mapping(address => bool) public levyExempt;
    /// @notice Cumulative tRIEL routed to the public fund through this contract.
    uint256 public totalRaised;

    event Paid(address indexed from, address indexed to, uint256 net, uint256 levy, bytes32 memo);
    event LevySet(uint16 levyBps, address indexed publicFund);
    event ExemptSet(address indexed account, bool exempt);

    error ZeroAddress();
    error ZeroAmount();
    error LevyTooHigh(uint16 bps);
    error TransferFailed();

    constructor(address council, address publicFund_) {
        _grantRole(DEFAULT_ADMIN_ROLE, council);
        _grantRole(COUNCIL_ROLE, council);
        publicFund = publicFund_;
        emit LevySet(0, publicFund_);
    }

    /**
     * @notice Pay `to` in native tRIEL, forwarding `msg.value` minus any levy.
     * @param to    recipient
     * @param memo  optional reference (invoice id, purpose) — 0 for none
     */
    function pay(address to, bytes32 memo) external payable nonReentrant whenNotPaused {
        if (to == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();
        uint256 levy = _levyOn(msg.sender, to, msg.value);
        uint256 net = msg.value - levy;
        if (levy > 0) {
            totalRaised += levy; // effects before interactions
            _send(publicFund, levy);
        }
        _send(to, net);
        emit Paid(msg.sender, to, net, levy, memo);
    }

    /// @notice The levy that would apply to a payment — for wallet previews.
    function quoteLevy(address from, address to, uint256 amount) external view returns (uint256) {
        return _levyOn(from, to, amount);
    }

    function _levyOn(address from, address to, uint256 amount) internal view returns (uint256) {
        if (levyBps == 0 || publicFund == address(0)) return 0;
        if (levyExempt[from] || levyExempt[to]) return 0;
        return (amount * levyBps) / BPS_DENOMINATOR;
    }

    function _send(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ----------------------------------------------------------- governance

    /// @notice Council sets the levy rate and destination. bps=0 disables it.
    function setLevy(uint16 bps, address publicFund_) external onlyRole(COUNCIL_ROLE) {
        if (bps > MAX_LEVY_BPS) revert LevyTooHigh(bps);
        if (bps > 0 && publicFund_ == address(0)) revert ZeroAddress();
        levyBps = bps;
        publicFund = publicFund_;
        emit LevySet(bps, publicFund_);
    }

    function setExempt(address account, bool exempt) external onlyRole(COUNCIL_ROLE) {
        levyExempt[account] = exempt;
        emit ExemptSet(account, exempt);
    }

    function pause() external onlyRole(COUNCIL_ROLE) { _pause(); }
    function unpause() external onlyRole(COUNCIL_ROLE) { _unpause(); }
}
