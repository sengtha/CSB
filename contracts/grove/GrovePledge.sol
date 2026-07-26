// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {GroveAnchor} from "./GroveAnchor.sol";

/**
 * @title GrovePledge
 * @notice Money that is only released when the tree is still alive.
 *
 * Everyone has met the tree-planting photograph: a hundred people, a hundred
 * saplings, a press release, and a field of dead sticks eighteen months later
 * that nobody photographs. The failure is not insincerity, it is that the money
 * arrives on planting day. Planting is what gets funded, so planting is what
 * happens.
 *
 * A pledge here pays for SURVIVAL. A sponsor deposits riel against a grove and
 * attaches milestones — 200 trees still standing at month 12, still standing at
 * month 24. Each milestone releases only when the grower brings back a fresh
 * signed observation that a LICENSED FIELD VERIFIER has confirmed, anchored
 * after the milestone opened. No proof, no payment; the sponsor takes the money
 * back after the deadline.
 *
 * Two things are deliberate and worth naming:
 *
 *  - THE VERIFIER IS PAID FROM THE MILESTONE. Verification is a motorbike ride
 *    down a dirt road and an afternoon of somebody's life; unpaid verification
 *    is verification that does not happen, which is how the whole voluntary
 *    market ended up trusting spreadsheets. The person who went and looked is a
 *    named payee, paid in the same transaction as the grower.
 *
 *  - PROOF MUST BE NEWER THAN THE MILESTONE. `anchoredAt >= notBefore` is
 *    checked against the block timestamp, not the phone's clock. Otherwise last
 *    year's healthy photograph pays out this year's survival milestone, which is
 *    precisely the trick this exists to make impossible.
 *
 * Compliance is not suspended in here. If the grower or the verifier is frozen
 * by an enforcement order, the token refuses them and the whole claim reverts —
 * the same ordering PaymentEscrow uses, for the same reason.
 *
 * PLACEHOLDER: a demonstration on a test network with valueless tokens. This is
 * not a financial product, and no pledge here funds anything real.
 */
contract GrovePledge is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Resolves disputes: may release a milestone or return it.
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    enum MilestoneStatus {
        Pending, // waiting for proof
        Paid, // proved and settled
        Reclaimed // deadline passed, returned to the sponsor
    }

    enum PledgeStatus {
        None,
        Created, // terms agreed, nothing deposited
        Funded, // the sponsor's money is held here
        Closed // every milestone settled one way or the other
    }

    /// @notice What a sponsor sets when writing the pledge. Separate from the
    ///         stored Milestone so the terms a sponsor signs cannot contain a
    ///         status or a proof — those are the chain's to write, not theirs.
    struct MilestoneTerm {
        uint64 notBefore; // proof must be anchored at or after this
        uint64 deadline; // after this the sponsor may reclaim
        uint32 requiredCount; // living trees the record must show
        uint256 growerAmount;
        uint256 verifierAmount;
    }

    struct Milestone {
        uint64 notBefore;
        uint64 deadline;
        uint32 requiredCount;
        uint256 growerAmount;
        uint256 verifierAmount;
        MilestoneStatus status;
        bytes32 provedBy; // the observation id that released it
        address paidVerifier;
    }

    struct Pledge {
        bytes32 plotId;
        address sponsor;
        address grower;
        address token;
        uint256 total;
        uint256 remaining;
        PledgeStatus status;
        uint32 settledCount;
        string purpose; // "500 mangroves, Peam Krasop, 24-month survival"
    }

    GroveAnchor public immutable anchorRegistry;

    mapping(uint256 => Pledge) private _pledges;
    mapping(uint256 => Milestone[]) private _milestones;
    mapping(address => uint256[]) private _pledgesOfSponsor;
    mapping(bytes32 => uint256[]) private _pledgesOfPlot;
    uint256 public pledgeCount;

    event PledgeCreated(
        uint256 indexed pledgeId,
        bytes32 indexed plotId,
        address indexed sponsor,
        address grower,
        address token,
        uint256 total,
        uint32 milestones
    );
    event PledgeFunded(uint256 indexed pledgeId, address indexed sponsor, uint256 total);
    event MilestoneProved(
        uint256 indexed pledgeId,
        uint32 indexed index,
        bytes32 indexed observationId,
        uint32 liveCount,
        address grower,
        address verifier
    );
    event MilestonePaid(
        uint256 indexed pledgeId, uint32 indexed index, uint256 growerAmount, address verifier, uint256 verifierAmount
    );
    event MilestoneReclaimed(uint256 indexed pledgeId, uint32 indexed index, uint256 amount, bytes32 reason);
    event PledgeClosed(uint256 indexed pledgeId);

    error MilestonesRequired();
    error ZeroAmount();
    error ZeroAddress();
    error InvalidWindow(uint64 notBefore, uint64 deadline);
    error MilestonesOutOfOrder(uint32 index);
    error NotSponsor(uint256 pledgeId, address caller);
    error WrongPledgeStatus(uint256 pledgeId, PledgeStatus actual, PledgeStatus required);
    error WrongMilestoneStatus(uint256 pledgeId, uint32 index, MilestoneStatus actual);
    error UnknownMilestone(uint256 pledgeId, uint32 index);
    error WindowNotOpen(uint256 pledgeId, uint32 index, uint64 notBefore);
    error WindowClosed(uint256 pledgeId, uint32 index, uint64 deadline);
    error DeadlineNotReached(uint256 pledgeId, uint32 index, uint64 deadline);
    error ProofFromAnotherPlot(bytes32 expected, bytes32 actual);
    error ProofNotVerified(bytes32 observationId);
    error ProofTooOld(bytes32 observationId, uint64 anchoredAt, uint64 notBefore);
    error NotEnoughTrees(bytes32 observationId, uint32 found, uint32 required);
    error NoVerifierToPay(bytes32 observationId);
    error ReasonRequired();

    constructor(GroveAnchor anchorRegistry_, address councilAdmin, address arbiter) {
        anchorRegistry = anchorRegistry_;
        _grantRole(DEFAULT_ADMIN_ROLE, councilAdmin);
        _grantRole(ARBITER_ROLE, arbiter);
    }

    // -------------------------------------------------------------- lifecycle

    /**
     * @notice Agree a pledge and its milestones. No money moves yet.
     * @dev Open to anyone: sponsoring a grove should not require anybody's
     *      permission, and an unfunded pledge costs nobody anything. The total
     *      is derived from the milestones rather than passed in, so the amount
     *      the sponsor deposits can never disagree with the sum of the parts.
     */
    function createPledge(
        bytes32 plotId,
        address grower,
        address token,
        string calldata purpose,
        MilestoneTerm[] calldata milestones
    ) external returns (uint256 pledgeId) {
        if (milestones.length == 0) revert MilestonesRequired();
        if (grower == address(0) || token == address(0)) revert ZeroAddress();
        if (plotId == bytes32(0)) revert ZeroAddress();

        uint256 total;
        uint64 previousDeadline;
        for (uint256 i = 0; i < milestones.length; i++) {
            MilestoneTerm calldata m = milestones[i];
            if (m.growerAmount == 0) revert ZeroAmount();
            if (m.notBefore >= m.deadline) revert InvalidWindow(m.notBefore, m.deadline);
            if (m.deadline <= block.timestamp) revert InvalidWindow(m.notBefore, m.deadline);
            // Chronological, so "milestone 2" means what a reader assumes and a
            // UI can render a timeline without sorting anything.
            if (m.notBefore < previousDeadline) revert MilestonesOutOfOrder(uint32(i));
            previousDeadline = m.deadline;
            total += m.growerAmount + m.verifierAmount;

            _milestones[pledgeCount + 1].push(
                Milestone({
                    notBefore: m.notBefore,
                    deadline: m.deadline,
                    requiredCount: m.requiredCount,
                    growerAmount: m.growerAmount,
                    verifierAmount: m.verifierAmount,
                    status: MilestoneStatus.Pending,
                    provedBy: bytes32(0),
                    paidVerifier: address(0)
                })
            );
        }

        pledgeId = ++pledgeCount;
        Pledge storage p = _pledges[pledgeId];
        p.plotId = plotId;
        p.sponsor = _msgSender();
        p.grower = grower;
        p.token = token;
        p.total = total;
        p.remaining = total;
        p.status = PledgeStatus.Created;
        p.purpose = purpose;
        _pledgesOfSponsor[_msgSender()].push(pledgeId);
        _pledgesOfPlot[plotId].push(pledgeId);

        emit PledgeCreated(pledgeId, plotId, _msgSender(), grower, token, total, uint32(milestones.length));
    }

    /// @notice Sponsor deposits the whole pledge. Requires an ERC20 approval.
    /// @dev The full amount up front is the point. A promise to pay on delivery
    ///      is what a grower already cannot bank on; money sitting in a contract
    ///      they can see is a different proposition entirely.
    function fund(uint256 pledgeId) external nonReentrant {
        Pledge storage p = _pledges[pledgeId];
        if (p.status != PledgeStatus.Created) revert WrongPledgeStatus(pledgeId, p.status, PledgeStatus.Created);
        if (_msgSender() != p.sponsor) revert NotSponsor(pledgeId, _msgSender());
        p.status = PledgeStatus.Funded;
        IERC20(p.token).safeTransferFrom(p.sponsor, address(this), p.total);
        emit PledgeFunded(pledgeId, p.sponsor, p.total);
    }

    /**
     * @notice Claim a milestone with a verified observation as the proof.
     * @dev Callable by anyone, because every destination is fixed: the grower
     *      named in the pledge and the verifier named on the record. Nobody can
     *      redirect a riel of it, so requiring a particular caller would only
     *      make a grower with a flat battery wait for their money.
     */
    function claimMilestone(uint256 pledgeId, uint32 index, bytes32 observationId) external nonReentrant {
        Pledge storage p = _pledges[pledgeId];
        if (p.status != PledgeStatus.Funded) revert WrongPledgeStatus(pledgeId, p.status, PledgeStatus.Funded);
        Milestone storage m = _milestone(pledgeId, index);
        if (m.status != MilestoneStatus.Pending) revert WrongMilestoneStatus(pledgeId, index, m.status);
        if (block.timestamp < m.notBefore) revert WindowNotOpen(pledgeId, index, m.notBefore);
        if (block.timestamp > m.deadline) revert WindowClosed(pledgeId, index, m.deadline);

        GroveAnchor.Anchor memory a = anchorRegistry.anchorOf(observationId);
        if (a.anchoredAt == 0) revert ProofNotVerified(observationId);
        if (a.plotId != p.plotId) revert ProofFromAnotherPlot(p.plotId, a.plotId);
        // The proof has to be NEWER than the milestone, or an old healthy record
        // pays out every future survival check.
        if (a.anchoredAt < m.notBefore) revert ProofTooOld(observationId, a.anchoredAt, m.notBefore);
        if (!anchorRegistry.isVerified(observationId)) revert ProofNotVerified(observationId);
        if (a.liveCount < m.requiredCount) revert NotEnoughTrees(observationId, a.liveCount, m.requiredCount);

        address verifier = a.firstConfirmer;
        if (m.verifierAmount > 0 && verifier == address(0)) revert NoVerifierToPay(observationId);

        m.status = MilestoneStatus.Paid;
        m.provedBy = observationId;
        m.paidVerifier = verifier;

        emit MilestoneProved(pledgeId, index, observationId, a.liveCount, p.grower, verifier);
        _settle(pledgeId, p, index, m, p.grower, verifier);
    }

    /// @notice Sponsor takes back a milestone whose deadline passed unproved.
    function reclaimExpired(uint256 pledgeId, uint32 index) external nonReentrant {
        Pledge storage p = _pledges[pledgeId];
        if (p.status != PledgeStatus.Funded) revert WrongPledgeStatus(pledgeId, p.status, PledgeStatus.Funded);
        if (_msgSender() != p.sponsor) revert NotSponsor(pledgeId, _msgSender());
        Milestone storage m = _milestone(pledgeId, index);
        if (m.status != MilestoneStatus.Pending) revert WrongMilestoneStatus(pledgeId, index, m.status);
        if (block.timestamp <= m.deadline) revert DeadlineNotReached(pledgeId, index, m.deadline);
        _reclaim(pledgeId, p, index, m, "deadline passed unproved");
    }

    // ---------------------------------------------------------------- arbiter

    /**
     * @notice Arbiter settles a milestone to the grower without an on-chain
     *         proof — the record was made but the verifier's licence lapsed, the
     *         phone was lost, a flood took the road.
     * @dev The verifier's share goes to the grower here, because there is no
     *      verifier on the record to pay. An arbiter must never be able to name
     *      a payee: that would turn dispute resolution into a payment
     *      instruction, which is a different and much more dangerous power.
     */
    function releaseByArbiter(uint256 pledgeId, uint32 index, bytes32 reason)
        external
        onlyRole(ARBITER_ROLE)
        nonReentrant
    {
        if (reason == bytes32(0)) revert ReasonRequired();
        Pledge storage p = _pledges[pledgeId];
        if (p.status != PledgeStatus.Funded) revert WrongPledgeStatus(pledgeId, p.status, PledgeStatus.Funded);
        Milestone storage m = _milestone(pledgeId, index);
        if (m.status != MilestoneStatus.Pending) revert WrongMilestoneStatus(pledgeId, index, m.status);
        m.status = MilestoneStatus.Paid;
        _settle(pledgeId, p, index, m, p.grower, address(0));
    }

    /// @notice Arbiter returns a milestone to the sponsor before its deadline —
    ///         the grove is gone, the pledge cannot be met.
    function refundByArbiter(uint256 pledgeId, uint32 index, bytes32 reason)
        external
        onlyRole(ARBITER_ROLE)
        nonReentrant
    {
        if (reason == bytes32(0)) revert ReasonRequired();
        Pledge storage p = _pledges[pledgeId];
        if (p.status != PledgeStatus.Funded) revert WrongPledgeStatus(pledgeId, p.status, PledgeStatus.Funded);
        Milestone storage m = _milestone(pledgeId, index);
        if (m.status != MilestoneStatus.Pending) revert WrongMilestoneStatus(pledgeId, index, m.status);
        _reclaim(pledgeId, p, index, m, reason);
    }

    // --------------------------------------------------------------- internal

    function _settle(
        uint256 pledgeId,
        Pledge storage p,
        uint32 index,
        Milestone storage m,
        address grower,
        address verifier
    ) private {
        uint256 growerAmount = m.growerAmount;
        uint256 verifierAmount = m.verifierAmount;
        // No verifier on the record (the arbiter route): their share follows the
        // work that was actually done, which was the grower's.
        if (verifier == address(0)) {
            growerAmount += verifierAmount;
            verifierAmount = 0;
        }
        p.remaining -= (m.growerAmount + m.verifierAmount);

        // All or nothing. A payee the token refuses — frozen, KYC revoked —
        // reverts the whole settlement rather than paying the other and leaving
        // a share stranded here with no owner.
        IERC20(p.token).safeTransfer(grower, growerAmount);
        if (verifierAmount > 0) IERC20(p.token).safeTransfer(verifier, verifierAmount);

        emit MilestonePaid(pledgeId, index, growerAmount, verifier, verifierAmount);
        _maybeClose(pledgeId, p);
    }

    function _reclaim(uint256 pledgeId, Pledge storage p, uint32 index, Milestone storage m, bytes32 reason) private {
        uint256 amount = m.growerAmount + m.verifierAmount;
        m.status = MilestoneStatus.Reclaimed;
        p.remaining -= amount;
        IERC20(p.token).safeTransfer(p.sponsor, amount);
        emit MilestoneReclaimed(pledgeId, index, amount, reason);
        _maybeClose(pledgeId, p);
    }

    function _maybeClose(uint256 pledgeId, Pledge storage p) private {
        p.settledCount += 1;
        if (p.settledCount == _milestones[pledgeId].length) {
            p.status = PledgeStatus.Closed;
            emit PledgeClosed(pledgeId);
        }
    }

    function _milestone(uint256 pledgeId, uint32 index) private view returns (Milestone storage) {
        Milestone[] storage list = _milestones[pledgeId];
        if (index >= list.length) revert UnknownMilestone(pledgeId, index);
        return list[index];
    }

    // ------------------------------------------------------------------ views

    function pledgeOf(uint256 pledgeId) external view returns (Pledge memory) {
        return _pledges[pledgeId];
    }

    function milestoneCount(uint256 pledgeId) external view returns (uint256) {
        return _milestones[pledgeId].length;
    }

    function milestoneOf(uint256 pledgeId, uint32 index) external view returns (Milestone memory) {
        return _milestone(pledgeId, index);
    }

    function pledgesOfSponsor(address sponsor) external view returns (uint256[] memory) {
        return _pledgesOfSponsor[sponsor];
    }

    function pledgesOfPlot(bytes32 plotId) external view returns (uint256[] memory) {
        return _pledgesOfPlot[plotId];
    }

    /**
     * @notice Would this claim succeed right now, and if not, why?
     * @dev The refusals are the demonstration. "This pledge will not pay,
     *      because the newest record nobody has verified yet" is a far better
     *      explanation of what the chain is doing than any description of it,
     *      and a sponsor deciding whether to fund should be able to read it
     *      without signing anything.
     */
    function canClaim(uint256 pledgeId, uint32 index, bytes32 observationId)
        external
        view
        returns (bool ok, string memory reason)
    {
        Pledge storage p = _pledges[pledgeId];
        if (p.status == PledgeStatus.None) return (false, "no such pledge");
        if (p.status == PledgeStatus.Created) return (false, "the sponsor has not funded this pledge yet");
        if (p.status == PledgeStatus.Closed) return (false, "this pledge is closed");
        Milestone[] storage list = _milestones[pledgeId];
        if (index >= list.length) return (false, "no such milestone");
        Milestone storage m = list[index];
        if (m.status == MilestoneStatus.Paid) return (false, "this milestone has already been paid");
        if (m.status == MilestoneStatus.Reclaimed) return (false, "this milestone expired and was returned");
        if (block.timestamp < m.notBefore) return (false, "this milestone's survival window has not opened yet");
        if (block.timestamp > m.deadline) return (false, "this milestone's deadline has passed");

        GroveAnchor.Anchor memory a = anchorRegistry.anchorOf(observationId);
        if (a.anchoredAt == 0) return (false, "this observation has not been anchored on CSB");
        if (a.plotId != p.plotId) return (false, "this observation belongs to a different grove");
        if (a.anchoredAt < m.notBefore) {
            return (false, "this record predates the milestone: proof of survival has to be newer than the promise");
        }
        if (!anchorRegistry.isVerified(observationId)) {
            return (false, "no licensed field verifier has confirmed this record, or it is disputed");
        }
        if (a.liveCount < m.requiredCount) return (false, "fewer trees are still standing than this milestone requires");
        if (m.verifierAmount > 0 && a.firstConfirmer == address(0)) {
            return (false, "this milestone pays a verifier's fee, but no verifier is recorded on the proof");
        }
        if (IERC20(p.token).balanceOf(address(this)) < m.growerAmount + m.verifierAmount) {
            return (false, "the pledge does not hold enough to settle this milestone");
        }
        return (true, "");
    }
}
