const hre = require("hardhat");

/**
 * Get the real reason a transaction failed, from its hash. Read-only.
 *
 *   source ops/csb-env.sh
 *   CSB_TX=0x<hash> npx hardhat run scripts/why-did-tx-fail.js --network csbRemote
 *
 * Written because an executed transfer FAILED while an eth_call simulation of the
 * same call said it would succeed. That contradiction cannot be resolved by
 * reasoning about the contracts — one of the two is measuring something the other
 * is not, and the only way to find out which is to ask the chain what actually
 * happened.
 *
 * It reports the three things that distinguish the usual causes, which otherwise
 * all present identically as "failed" in a wallet:
 *
 *   OUT OF GAS      gasUsed == gasLimit, and no revert reason. The wallet
 *                   under-estimated. Nothing is wrong with the contracts.
 *   REVERTED        gasUsed < gasLimit, and re-simulating at the PARENT block
 *                   reproduces a revert reason. That reason is the answer.
 *   NOT REPRODUCIBLE Re-simulating at the parent block SUCCEEDS. Then the failure
 *                   depended on something not in the call — most often that the
 *                   state at the time differed from the state the simulation used,
 *                   or the gas limit.
 *
 * The re-simulation is done at the parent block deliberately. Simulating against
 * `latest` is what produced the original contradiction: state moves, and a call
 * that succeeds now says nothing about why one failed then.
 */

const AAVE_ERRORS = {
  "26": "INVALID_AMOUNT", "27": "RESERVE_INACTIVE", "28": "RESERVE_FROZEN",
  "29": "RESERVE_PAUSED", "30": "BORROWING_NOT_ENABLED",
  "32": "NOT_ENOUGH_AVAILABLE_USER_BALANCE", "33": "INVALID_INTEREST_RATE_MODE_SELECTED",
  "34": "COLLATERAL_BALANCE_IS_ZERO",
  "35": "HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD — the SENDER's own debt, not compliance",
  "36": "COLLATERAL_CANNOT_COVER_NEW_BORROW", "39": "NO_DEBT_OF_SELECTED_TYPE",
};

function explain(ethers, e) {
  const raw = e?.shortMessage ?? e?.message ?? String(e);
  const num = raw.match(/reverted(?:\s+with\s+reason\s+string)?:?\s*["']?(\d{1,2})["']?/);
  if (num) {
    const c = num[1];
    return `Aave code ${c}${AAVE_ERRORS[c] ? ` — ${AAVE_ERRORS[c]}` : ""}`;
  }
  const custom = e?.revert?.name ?? raw.match(/custom error '?([A-Za-z0-9_]+)/)?.[1];
  if (custom) return `custom error ${custom}`;
  const str = raw.match(/reason string ['"]([^'"]+)['"]/);
  if (str) return `revert string "${str[1]}"`;
  // A bare "execution reverted" means the node returned no revert data at all,
  // which is itself informative: it rules out a contract that reverts with a
  // reason, and points at a require with no message or a precompile refusal.
  return raw;
}

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const hash = process.env.CSB_TX;
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error(`CSB_TX must be a full 66-character transaction hash, got: ${JSON.stringify(hash)}\n`
      + `  Copy it in full from the wallet — an abbreviated one (0x6e5f0...8a903) will not work.`);
  }

  const [tx, rcpt] = await Promise.all([
    provider.getTransaction(hash), provider.getTransactionReceipt(hash),
  ]);
  if (!tx) throw new Error(`No such transaction on this chain: ${hash}`);
  if (!rcpt) {
    console.log("Transaction is known but has no receipt yet — still pending.");
    return;
  }

  console.log(`\nTRANSACTION ${hash}`);
  console.log(`  block        ${rcpt.blockNumber}`);
  console.log(`  status       ${rcpt.status === 1 ? "SUCCESS" : "FAILED"}`);
  console.log(`  from         ${tx.from}`);
  console.log(`  to           ${tx.to}`);
  console.log(`  value        ${ethers.formatEther(tx.value ?? 0n)} tRIEL`);
  console.log(`  gas limit    ${tx.gasLimit}`);
  console.log(`  gas used     ${rcpt.gasUsed}`);
  const ratio = Number(rcpt.gasUsed) / Number(tx.gasLimit);
  console.log(`  used/limit   ${(ratio * 100).toFixed(1)}%`);
  console.log(`  gas price    ${ethers.formatUnits(tx.gasPrice ?? 0n, "gwei")} gwei`);
  console.log(`  calldata     ${(tx.data ?? "0x").slice(0, 74)}${(tx.data ?? "").length > 74 ? "…" : ""}`);

  if (rcpt.status === 1) {
    console.log(`\nThis transaction SUCCEEDED. Nothing to diagnose.`);
    return;
  }

  console.log(`\nWHY IT FAILED`);

  // A TOP-LEVEL out-of-gas consumes the whole limit, so gasUsed == gasLimit
  // exactly. A ratio a few percent short of 100% with nothing else wrong is the
  // signature of an INNER call running out: EIP-150 hands a sub-call at most
  // 63/64 of the remaining gas, so when the sub-call exhausts its allocation the
  // outer frame still holds an unspent sliver, and each level of nesting leaves
  // another. Both are gas problems, and neither says anything about the contracts.
  if (ratio >= 0.999) {
    console.log(`  gasUsed EQUALS the limit — top-level OUT OF GAS. The contracts`);
    console.log(`  did not refuse anything; the gas limit was too low.`);
  } else if (ratio > 0.90) {
    console.log(`  gasUsed is ${(ratio * 100).toFixed(1)}% of the limit but not all of it. That gap`);
    console.log(`  is the EIP-150 1/64 reserve, which is what an INNER call running`);
    console.log(`  out of gas looks like — a nested call exhausted its allocation`);
    console.log(`  while the outer frame kept the reserve. Still a gas problem.`);
    console.log(`  The gas-constrained replay below settles it.`);
  }

  const base = { from: tx.from, to: tx.to, data: tx.data, value: tx.value };
  const parent = rcpt.blockNumber - 1;

  // THE faithful reconstruction: parent block AND the original gas limit. Getting
  // either wrong produces a false exoneration — replaying at `latest` asks about
  // different state, and replaying without the gas cap hands the call far more
  // gas than it had, so a gas failure silently "succeeds".
  console.log(`\n  1. Identical call, parent block ${parent}, ORIGINAL gas limit ${tx.gasLimit}:`);
  let faithfulOk = false;
  try {
    await provider.call({ ...base, gasLimit: tx.gasLimit }, parent);
    faithfulOk = true;
    console.log(`     SUCCEEDS — so neither the state, the calldata, nor the gas`);
    console.log(`     limit explains the failure. Look at nonce or ordering.`);
  } catch (e) {
    console.log(`     FAILS: ${explain(ethers, e)}`);
  }

  // Same state, generous gas. If this succeeds where the above failed, gas is
  // the whole story and the contracts permitted the action.
  console.log(`\n  2. Same call and block, but with generous gas:`);
  let richOk = false;
  try {
    await provider.call(base, parent);
    richOk = true;
    console.log(`     SUCCEEDS.`);
  } catch (e) {
    console.log(`     FAILS: ${explain(ethers, e)}`);
  }

  // What the call actually needs. If this exceeds the limit the wallet used, the
  // wallet under-estimated, and that is the entire explanation.
  console.log(`\n  3. Gas the call actually requires, at that block:`);
  try {
    const need = await provider.estimateGas({ ...base }, parent);
    const over = need > tx.gasLimit;
    console.log(`     needs ~${need}, the transaction was given ${tx.gasLimit}`);
    if (over) {
      console.log(`     ** SHORT BY ${need - tx.gasLimit} — the wallet UNDER-ESTIMATED. **`);
    } else {
      console.log(`     within the limit, so a plain shortfall is not the explanation.`);
    }
  } catch (e) {
    console.log(`     estimate failed: ${explain(ethers, e)}`);
  }

  console.log(`\nVERDICT`);
  if (!faithfulOk && richOk) {
    console.log(`  GAS, NOT REFUSAL. With the gas it was actually given the call`);
    console.log(`  fails; with more gas, at the same block and state, it succeeds.`);
    console.log(`  The contracts permitted this action. Retry with a higher limit.`);
  } else if (!faithfulOk && !richOk) {
    console.log(`  A GENUINE REFUSAL. It fails even with ample gas at the state it`);
    console.log(`  ran against, so the reason in (2) is the real one.`);
  } else {
    console.log(`  NOT REPRODUCIBLE from the call itself. The state, calldata and`);
    console.log(`  gas limit all replay cleanly, so the cause lies outside them.`);
  }
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
