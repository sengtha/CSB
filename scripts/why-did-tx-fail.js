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
  if (ratio > 0.97) {
    console.log(`  Gas used is ${(ratio * 100).toFixed(1)}% of the limit — this is very likely`);
    console.log(`  OUT OF GAS, not a contract refusal. The wallet under-estimated.`);
    console.log(`  Retry with a higher gas limit before concluding anything about`);
    console.log(`  the contracts. A revert normally uses well under the limit.`);
  }

  // Replay the exact call against the state its parent block had. This is the
  // only faithful reconstruction: replaying against `latest` asks a different
  // question and is how the original contradiction arose.
  console.log(`\n  Replaying the identical call at block ${rcpt.blockNumber - 1} (the parent):`);
  try {
    await provider.call({
      from: tx.from, to: tx.to, data: tx.data, value: tx.value,
    }, rcpt.blockNumber - 1);
    console.log(`    IT SUCCEEDS at that block.`);
    console.log(`    So the calldata and the state were both fine, and the failure`);
    console.log(`    came from something outside them — the gas limit above being the`);
    console.log(`    first thing to check.`);
  } catch (e) {
    console.log(`    REVERTS: ${explain(ethers, e)}`);
    console.log(`    This is the real reason. It reproduces from the state at the`);
    console.log(`    time, so it is not a gas or nonce artifact.`);
  }

  // And at latest, to show explicitly whether the answer is state-dependent.
  console.log(`\n  For contrast, the same call against the CURRENT state:`);
  try {
    await provider.call({ from: tx.from, to: tx.to, data: tx.data, value: tx.value });
    console.log(`    succeeds now — so the outcome DEPENDS ON STATE that has since`);
    console.log(`    changed. Any simulation run against 'latest' is therefore not`);
    console.log(`    evidence about what happened in block ${rcpt.blockNumber}.`);
  } catch (e) {
    console.log(`    still reverts: ${explain(ethers, e)}`);
  }
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
