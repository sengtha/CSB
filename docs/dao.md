# DAOs on CSB

A DAO here is a group that decides things by vote, weighted by whatever ERC-20 it
chose — KHRt, a pool's LP token, a staking token, anything on the chain. Users
create them from `/dao.html` with no operator involved.

- Contract: `contracts/governance/TokenVote.sol` (11,692 bytes, `paris`)
- Deploy once: `npx hardhat run scripts/deploy-tokenvote.js --network csbRemote`
- Tests: `test/token-vote.test.js` — 29, covering both weighing modes and the
  ways each would be silently wrong rather than visibly broken

## Why one shared contract, and not OpenZeppelin Governor

Governor is the better contract in every respect that does not involve being
usable here. Two things rule it out as a **product for users** on CSB:

**Users cannot deploy contracts.** Subnet-EVM checks `tx.origin` against
`contractDeployerAllowList` when a contract is created — not the caller of
`CREATE` — so a factory does not help: the factory's own `CREATE` is still
attributed to whoever sent the transaction. A per-DAO Governor + timelock + votes
token would need an operator to create **every single DAO**.

**It would not fit anyway.** Governor measures 17,164 bytes and ~3.8M gas; with a
timelock and a token that is ~6M against an 8M block, so a one-transaction "create
my DAO" is impossible and it becomes a three-step operator ritual.

Here a DAO is a **storage record**. Creating one costs about **121k gas** —
measured, not estimated — and is an ordinary transaction any allow-listed address
can send. That is the whole reason for the shape.

## Two ways to weigh a vote

Weighing by `balanceOf` at vote time is defeated in three transactions: vote,
send the tokens to a fresh address, vote again. Something has to stop the same
tokens counting twice, and which mechanism is available depends on the token.

**Snapshot** — the better option, chosen per DAO. If the token keeps checkpoints
(`ERC20Votes`, or anything with the same `getPastVotes` / `getPastTotalSupply`
shape) then weight is read from a block already in the past when the proposal
opened. Nobody can change what they held then, so **nothing is locked**: voting
costs no liquidity, and tokens moved after the snapshot carry no weight.

The snapshot is `block.number - 1` at propose time, not the current block — using
the current one would let a proposer acquire tokens in the same block they open
the vote, which is the thing a snapshot exists to prevent. Quorum is measured
against the supply *at the snapshot*, so minting afterwards cannot raise the bar
retroactively and defeat a proposal that already passed.

**Escrow** — the fallback, and what the tokens actually on CSB need today. KHRt,
the LP tokens and the staking tokens keep no checkpoints. For those, voting locks
the tokens until the proposal closes: the same tokens cannot vote twice because
they are not in the voter's hands to move. It costs the voter liquidity for the
duration, and the interface says so before they commit.

Withdrawal is available as soon as the clock runs out, whether or not anyone has
called `close()` — otherwise a voter's tokens would be hostage to somebody else
sending a transaction. Taking the stake back does not retract the vote.

**The mode is fixed at DAO creation and the token is probed then.** A DAO asking
for snapshot weighing against a token that cannot support it is refused at that
moment — not silently downgraded to escrow, which would lock tokens somebody was
told they would keep, and not left to fail at the first vote.

`isCheckpointed(token)` is a `staticcall` probe rather than ERC-165: nothing in
the wild registers an interface id for this, and what matters is whether the call
*works*. Both functions are probed, because quorum needs the supply one and a
token with half the interface would fail at closing time — after the votes were
cast.

**A note for anyone wanting a votes token on CSB.** OpenZeppelin's `ERC20Votes`
reaches its EIP-712 machinery, which reaches `Bytes.sol`, which uses `mcopy` —
a Cancun opcode. This project compiles at `paris`, and a per-file compiler
override does not help because the offending file is a transitive dependency.
Moving the whole build to `cancun` is safe today (the chain runs Subnet-EVM from
avalanchego v1.15) and would not have been before the July 2026 upgrade.

## The CSB-specific parts

**It must be attested to hold KHRt.** Voting escrows tokens, and KHRt refuses to
move to an address the identity registry does not know — the same wall the Uniswap
pool hit (`docs/defi.md`). `deploy-tokenvote.js` registers it at tier 3 and
deliberately does **not** `setSystemContract`, which would also exempt it from the
transfer levy and the tier caps. A voting escrow should be as constrained as the
people using it.

**Weight is what arrived, not what was asked for.** KHRt takes a configurable levy
on transfer, so `transferFrom(voter, escrow, 100)` can deliver less than 100.
Weight is measured either side of the transfer. Crediting the requested amount
would promise withdrawals the contract cannot honour, and the shortfall would land
on whoever withdrew last — a failure appearing far from its cause. Tested with the
levy switched on.

**Voting power is ungated.** An LP token or staking token has no compliance hooks,
so a revoked address can hold voting weight in a DAO whose token is one of those.
This is the composability finding in `docs/defi.md` arriving in governance:
the perimeter governs custody, not influence.

## What it deliberately does not do

**It does not execute anything.** A closed proposal is a recorded decision, not a
transaction. There is no treasury here to drain and no call to be tricked into
making. Acting on an outcome is a job for a Safe whose owners can read the result
(`docs/multisig.md`). Keeping the counting apart from the spending means a bug in
one cannot move the other.

That is a real limitation, not a virtue by itself: a DAO here decides, and humans
carry it out. Wiring execution in would mean each DAO needing its own executor
contract — the deployment problem, once more.

## Settings that matter

| | |
|---|---|
| **Voting period** | Minimum 5 minutes, enforced. A vote too short to notice is the obvious way to pass something quietly; the floor makes "it closed before I saw it" a visible choice rather than an accident. |
| **Quorum** | Share of **total supply** at closing time, in basis points. Zero means no quorum. A supply that moved during the vote moves the bar with it. |
| **Proposal threshold** | Tokens a proposer must hold. Zero is valid and means anyone may propose. |
| **Choices** | Two to eight. A tie is reported **as a tie** — handing it to the lowest index would dress an arbitrary rule as an outcome. |
