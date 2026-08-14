// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * What a checkpointed token must answer for snapshot weighing. Deliberately the
 * shape OpenZeppelin's IVotes uses, so any ERC20Votes token qualifies without
 * adapting anything.
 */
interface IVotesLike {
    function getPastVotes(address account, uint256 blockNumber) external view returns (uint256);
    function getPastTotalSupply(uint256 blockNumber) external view returns (uint256);
}

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

/**
 * Token-weighted voting for anyone on CSB. One contract; many DAOs.
 *
 * A user picks any ERC-20 already on this chain — KHRt, a pool's LP token, a
 * staking token, something they issued — and creates a DAO around it. Holders
 * propose, holders vote, weight is what they put behind it. The chain records
 * who voted for what and the result is arithmetic anyone can recheck.
 *
 * WHY THIS IS ONE SHARED CONTRACT AND NOT A FACTORY.
 *
 * Subnet-EVM checks tx.origin against contractDeployerAllowList when a contract
 * is created — not the caller of CREATE — so on CSB a visitor cannot deploy
 * anything from their browser, and a factory does not help: the factory's own
 * CREATE is still attributed to whoever sent the transaction. A per-DAO Governor
 * plus timelock plus votes token would therefore need an operator to create
 * every single DAO, and would cost roughly 6M gas each against an 8M block.
 *
 * Here a DAO is a STORAGE RECORD. Creating one is an ordinary transaction —
 * about 50k gas, no deployer rights, instant, self-service. That is the whole
 * reason this shape was chosen over OpenZeppelin's Governor, which is the better
 * contract in every respect that does not involve being usable here.
 *
 * TWO WAYS TO WEIGH A VOTE, BECAUSE ONE IS NOT ENOUGH.
 *
 * Weighing by `balanceOf` at the moment of voting is trivially defeated: vote,
 * send the tokens to a second address, vote again. Something has to stop the
 * same tokens counting twice, and which mechanism is available depends entirely
 * on the token the DAO chose.
 *
 *   SNAPSHOT — the better option, and the default wherever it is possible. If
 *   the token keeps checkpoints (ERC20Votes, or anything with the same
 *   getPastVotes/getPastTotalSupply shape) then weight is read from a block that
 *   is already in the past when the proposal opens. Nobody can change what they
 *   held then, so nothing needs to be locked: voting is free, costs no
 *   liquidity, and tokens moved after the snapshot carry no weight.
 *
 *   ESCROW — the fallback, for the tokens actually on CSB today. KHRt, the LP
 *   tokens and the staking tokens keep no checkpoints, and requiring them would
 *   mean every DAO starts by deploying a token, which is the deployment problem
 *   again. For those, voting LOCKS the tokens until the proposal closes: the
 *   same tokens cannot vote twice because they are not in the voter's hands to
 *   move. It costs the voter liquidity for the duration, which is a real cost
 *   and is stated in the interface rather than hidden.
 *
 * The mode is fixed when the DAO is created and the token is PROBED at that
 * moment, so a DAO that asks for snapshot weighing against a token which cannot
 * support it is refused there — not silently downgraded, and not left to fail at
 * the first vote when somebody is trying to use it.
 *
 * FEE-ON-TRANSFER IS ASSUMED, NOT EXCLUDED. KHRt takes a configurable levy on
 * transfer, so `transferFrom(voter, here, 100)` can deliver less than 100.
 * Weight is therefore the balance actually RECEIVED, measured either side of the
 * transfer. Trusting the requested amount would credit weight this contract does
 * not hold and leave the last voter unable to withdraw.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not execute anything. A closed
 * proposal is a recorded decision, not a transaction — there is no treasury here
 * to drain and no call to be tricked into making. Executing on an outcome is a
 * job for a Safe whose owners can read the result (docs/multisig.md). Keeping
 * the vote and the execution apart means a bug in the counting cannot move
 * money.
 */
contract TokenVote {
    // A vote too short to notice is a vote nobody can participate in, and the
    // obvious way to pass something quietly. Five minutes is short enough for a
    // demonstration and long enough that "it closed before I saw it" is a choice
    // the creator made visibly, not an accident.
    uint32 public constant MIN_VOTING_PERIOD = 5 minutes;
    uint32 public constant MAX_VOTING_PERIOD = 365 days;
    uint8 public constant MAX_CHOICES = 8;
    uint8 public constant NO_RESULT = type(uint8).max;

    /// How a vote's weight is established. Fixed at DAO creation.
    enum Weighing { Escrow, Snapshot }

    struct Dao {
        string name;
        address token;
        Weighing weighing;
        uint16 quorumBps;          // share of total supply that must vote, in basis points
        uint32 votingPeriod;       // seconds a proposal stays open
        uint256 minProposeBalance; // tokens a proposer must hold, in token units
        address creator;
        uint64 createdAt;
    }

    struct Proposal {
        uint256 daoId;
        address proposer;
        string title;
        string body;
        uint64 opens;
        uint64 closes;
        uint256 snapshotBlock;     // Snapshot mode only; 0 under Escrow
        bool closed;
        bool tied;
        uint8 winner;              // NO_RESULT until closed, or if quorum failed
        uint256 totalWeight;
    }

    struct Ballot {
        uint8 choice;
        uint256 weight;            // what this contract actually received
        bool withdrawn;
    }

    Dao[] private _daos;
    Proposal[] private _proposals;
    mapping(uint256 => string[]) private _choices;            // proposalId => labels
    mapping(uint256 => uint256[]) private _weights;           // proposalId => per-choice weight
    mapping(uint256 => mapping(address => Ballot)) private _ballots;

    // Reentrancy: vote() and withdraw() both call an arbitrary ERC-20 chosen by
    // whoever created the DAO. That token can call back.
    uint256 private _entered;

    event DaoCreated(uint256 indexed daoId, address indexed token, address indexed creator, string name);
    event Proposed(uint256 indexed proposalId, uint256 indexed daoId, address indexed proposer, string title);
    event Voted(uint256 indexed proposalId, address indexed voter, uint8 choice, uint256 weight);
    event Closed(uint256 indexed proposalId, uint8 winner, bool tied, uint256 totalWeight, bool quorumMet);
    event Withdrawn(uint256 indexed proposalId, address indexed voter, uint256 amount);

    error Reentrant();
    error NoSuchDao();
    error NoSuchProposal();
    error NotAContract(address token);
    error BadQuorum();
    error BadPeriod();
    error BadChoices();
    error EmptyText();
    error BelowProposeThreshold(uint256 held, uint256 required);
    error NotOpen();
    error AlreadyVoted();
    error NoWeight();
    error NotCheckpointed(address token);
    error NoEscrowToWithdraw();
    error BadChoice();
    error StillOpen();
    error AlreadyClosed();
    error NothingToWithdraw();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrant();
        _entered = 1;
        _;
        _entered = 0;
    }

    /**
     * Can this token answer what an address held at a past block?
     *
     * A staticcall rather than ERC-165: nothing in the wild registers an
     * interface id for this, and what matters is whether the call WORKS, not
     * whether the token claims it does. Both functions are probed, because
     * quorum needs the supply one and a token with only half the interface
     * would fail at closing time — after the votes were cast.
     */
    function isCheckpointed(address token) public view returns (bool) {
        if (block.number == 0) return false;
        uint256 past = block.number - 1;
        (bool a, bytes memory ra) = token.staticcall(
            abi.encodeWithSelector(IVotesLike.getPastVotes.selector, address(0), past));
        if (!a || ra.length < 32) return false;
        (bool b, bytes memory rb) = token.staticcall(
            abi.encodeWithSelector(IVotesLike.getPastTotalSupply.selector, past));
        return b && rb.length >= 32;
    }

    // ------------------------------------------------------------------ create

    function createDao(
        string calldata name,
        address token,
        Weighing weighing,
        uint16 quorumBps,
        uint32 votingPeriod,
        uint256 minProposeBalance
    ) external returns (uint256 daoId) {
        if (bytes(name).length == 0 || bytes(name).length > 64) revert EmptyText();
        if (token.code.length == 0) revert NotAContract(token);
        if (quorumBps > 10_000) revert BadQuorum();
        if (votingPeriod < MIN_VOTING_PERIOD || votingPeriod > MAX_VOTING_PERIOD) revert BadPeriod();
        // Asked for here, once, rather than discovered by a voter later. A DAO
        // whose token cannot answer historical balances is refused at creation;
        // silently falling back to escrow would lock tokens somebody was
        // promised they would keep.
        if (weighing == Weighing.Snapshot && !isCheckpointed(token)) revert NotCheckpointed(token);

        _daos.push(Dao({
            name: name, token: token, weighing: weighing, quorumBps: quorumBps,
            votingPeriod: votingPeriod, minProposeBalance: minProposeBalance,
            creator: msg.sender, createdAt: uint64(block.timestamp)
        }));
        daoId = _daos.length - 1;
        emit DaoCreated(daoId, token, msg.sender, name);
    }

    function propose(
        uint256 daoId,
        string calldata title,
        string calldata body,
        string[] calldata choices
    ) external returns (uint256 proposalId) {
        if (daoId >= _daos.length) revert NoSuchDao();
        Dao storage d = _daos[daoId];
        if (bytes(title).length == 0 || bytes(title).length > 120) revert EmptyText();
        if (bytes(body).length > 4000) revert EmptyText();
        if (choices.length < 2 || choices.length > MAX_CHOICES) revert BadChoices();
        for (uint256 i = 0; i < choices.length; i++) {
            if (bytes(choices[i]).length == 0 || bytes(choices[i]).length > 64) revert BadChoices();
        }

        // A threshold keeps the list from being filled by someone holding
        // nothing. It is the DAO's own setting, and zero is a valid answer.
        uint256 held = IERC20(d.token).balanceOf(msg.sender);
        if (held < d.minProposeBalance) revert BelowProposeThreshold(held, d.minProposeBalance);

        // The block BEFORE this one. Using the current block would let the
        // proposer acquire tokens in the same block they open the vote, which is
        // the whole thing a snapshot is supposed to prevent.
        uint256 snap = d.weighing == Weighing.Snapshot ? block.number - 1 : 0;

        _proposals.push(Proposal({
            daoId: daoId, proposer: msg.sender, title: title, body: body,
            opens: uint64(block.timestamp),
            closes: uint64(block.timestamp) + d.votingPeriod,
            snapshotBlock: snap,
            closed: false, tied: false, winner: NO_RESULT, totalWeight: 0
        }));
        proposalId = _proposals.length - 1;
        for (uint256 i = 0; i < choices.length; i++) _choices[proposalId].push(choices[i]);
        _weights[proposalId] = new uint256[](choices.length);
        emit Proposed(proposalId, daoId, msg.sender, title);
    }

    // -------------------------------------------------------------------- vote

    /**
     * Lock `amount` behind `choice`. The tokens come back after the proposal
     * closes; until then they are what stops the same tokens voting twice.
     *
     * Requires an allowance to this contract for `amount`.
     */
    function vote(uint256 proposalId, uint8 choice, uint256 amount) external nonReentrant {
        if (proposalId >= _proposals.length) revert NoSuchProposal();
        Proposal storage p = _proposals[proposalId];
        if (p.closed || block.timestamp >= p.closes) revert NotOpen();
        if (choice >= _choices[proposalId].length) revert BadChoice();
        if (_ballots[proposalId][msg.sender].weight != 0) revert AlreadyVoted();

        Dao storage d = _daos[p.daoId];
        uint256 received;

        if (d.weighing == Weighing.Snapshot) {
            // Nothing moves. Weight is what they held at a block that was already
            // in the past when the vote opened, so `amount` is not theirs to
            // choose — passing one is ignored rather than honoured.
            received = IVotesLike(d.token).getPastVotes(msg.sender, p.snapshotBlock);
            if (received == 0) revert NoWeight();
        } else {
            if (amount == 0) revert NoWeight();
            IERC20 token = IERC20(d.token);
            // Measured, not assumed: KHRt's levy means less can arrive than was
            // sent, and crediting the requested amount would promise a withdrawal
            // this contract cannot honour.
            uint256 before = token.balanceOf(address(this));
            token.transferFrom(msg.sender, address(this), amount);
            received = token.balanceOf(address(this)) - before;
            if (received == 0) revert NoWeight();
        }

        _ballots[proposalId][msg.sender] = Ballot({ choice: choice, weight: received, withdrawn: false });
        _weights[proposalId][choice] += received;
        p.totalWeight += received;
        emit Voted(proposalId, msg.sender, choice, received);
    }

    /**
     * Settle the result. Callable by anyone once the clock runs out — a result
     * that depends on the proposer bothering to come back is not a result.
     */
    function close(uint256 proposalId) external {
        if (proposalId >= _proposals.length) revert NoSuchProposal();
        Proposal storage p = _proposals[proposalId];
        if (p.closed) revert AlreadyClosed();
        if (block.timestamp < p.closes) revert StillOpen();

        Dao storage d = _daos[p.daoId];
        // Under Snapshot the bar is the supply AT THE SNAPSHOT, so minting after
        // the vote opened cannot raise the threshold retroactively and defeat a
        // proposal that already passed.
        uint256 supply = d.weighing == Weighing.Snapshot
            ? IVotesLike(d.token).getPastTotalSupply(p.snapshotBlock)
            : IERC20(d.token).totalSupply();
        // Quorum against supply at closing time. A supply that moved during the
        // vote moves the bar with it, which is the honest reading of "this share
        // of the token agreed".
        bool quorumMet = d.quorumBps == 0
            || (supply > 0 && p.totalWeight * 10_000 >= uint256(d.quorumBps) * supply);

        p.closed = true;
        if (!quorumMet || p.totalWeight == 0) {
            p.winner = NO_RESULT;
            emit Closed(proposalId, NO_RESULT, false, p.totalWeight, quorumMet);
            return;
        }

        uint256[] storage w = _weights[proposalId];
        uint8 best = 0;
        bool tie = false;
        for (uint8 i = 1; i < w.length; i++) {
            if (w[i] > w[best]) { best = i; tie = false; }
            else if (w[i] == w[best]) { tie = true; }
        }
        // A tie is reported as a tie. Silently handing it to the lowest index
        // would make an arbitrary rule look like an outcome.
        p.tied = tie;
        p.winner = tie ? NO_RESULT : best;
        emit Closed(proposalId, p.winner, tie, p.totalWeight, true);
    }

    /**
     * Take back what you locked. Available as soon as the clock runs out, whether
     * or not anyone has called close() — otherwise a voter's tokens would be
     * hostage to somebody else's transaction.
     */
    function withdraw(uint256 proposalId) external nonReentrant {
        if (proposalId >= _proposals.length) revert NoSuchProposal();
        Proposal storage p = _proposals[proposalId];
        if (block.timestamp < p.closes) revert StillOpen();

        if (_daos[p.daoId].weighing == Weighing.Snapshot) revert NoEscrowToWithdraw();

        Ballot storage b = _ballots[proposalId][msg.sender];
        if (b.weight == 0 || b.withdrawn) revert NothingToWithdraw();
        b.withdrawn = true;                       // effects before interaction
        IERC20(_daos[p.daoId].token).transfer(msg.sender, b.weight);
        emit Withdrawn(proposalId, msg.sender, b.weight);
    }

    // ------------------------------------------------------------------- views

    function daoCount() external view returns (uint256) { return _daos.length; }
    function proposalCount() external view returns (uint256) { return _proposals.length; }
    function daoAt(uint256 daoId) external view returns (Dao memory) {
        if (daoId >= _daos.length) revert NoSuchDao();
        return _daos[daoId];
    }
    function proposalAt(uint256 proposalId) external view returns (Proposal memory) {
        if (proposalId >= _proposals.length) revert NoSuchProposal();
        return _proposals[proposalId];
    }
    function choicesOf(uint256 proposalId) external view returns (string[] memory) {
        return _choices[proposalId];
    }
    function weightsOf(uint256 proposalId) external view returns (uint256[] memory) {
        return _weights[proposalId];
    }
    function ballotOf(uint256 proposalId, address voter) external view returns (Ballot memory) {
        return _ballots[proposalId][voter];
    }

    /// Everything a list view needs about a proposal, in one call.
    function summaryOf(uint256 proposalId) external view returns (
        Proposal memory proposal,
        string[] memory choices,
        uint256[] memory weights,
        address token,
        string memory daoName
    ) {
        if (proposalId >= _proposals.length) revert NoSuchProposal();
        Proposal memory p = _proposals[proposalId];
        Dao memory d = _daos[p.daoId];
        return (p, _choices[proposalId], _weights[proposalId], d.token, d.name);
    }
}
