const hre = require("hardhat");

/**
 * Diagnose and, only if necessary, clear a blocked deployer nonce queue.
 *
 * Two very different situations look identical from outside — "my transaction
 * never confirms" — and the cure for one makes the other worse:
 *
 *   BACKLOG   The transactions are mineable and the chain is working through
 *             them. Nothing is wrong; it needs time. Sending replacements here
 *             competes with transactions that were going to succeed anyway.
 *   STUCK     A transaction at some nonce can never be mined — typically priced
 *             below the fee floor, and a zero-priced one is accepted by the node
 *             and then ignored forever. Everything behind it waits on a
 *             transaction that will never come.
 *
 * So this WATCHES FIRST and replaces only if the queue is not moving.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/unstick.js --network csbRemote
 *
 * The previous version read the mined nonce once and immediately sent at that
 * number. On a chain that was draining normally the value was stale by the time
 * it sent, and it died on "nonce too low: next nonce 235, tx nonce 225" — an
 * error that reads like a fault but was in fact proof the chain was healthy.
 */
const WATCH_SECONDS = Number(process.env.CSB_UNSTICK_WATCH ?? 45);
const POLL_MS = 5000;

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const counts = async () => ({
    mined: await provider.getTransactionCount(deployer.address, "latest"),
    pending: await provider.getTransactionCount(deployer.address, "pending"),
  });

  console.log(`Deployer ${deployer.address}`);
  let { mined, pending } = await counts();
  console.log(`Nonce: mined=${mined} pending=${pending}  (${pending - mined} waiting)\n`);

  if (pending <= mined) {
    console.log("Nothing queued — this account is clear. If something still hangs,");
    console.log("it is not this account's nonce queue.");
    return;
  }

  // --- watch before acting -------------------------------------------------
  console.log(`Watching ${WATCH_SECONDS}s to see whether the queue is moving…`);
  const started = mined;
  const deadline = Date.now() + WATCH_SECONDS * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const now = await counts();
    if (now.mined > mined) {
      console.log(`  mined ${mined} → ${now.mined}   (${now.pending - now.mined} still waiting)`);
    }
    ({ mined, pending } = now);
    if (pending <= mined) {
      console.log("\nQueue drained on its own. The chain was working, not stuck.");
      return;
    }
  }

  if (mined > started) {
    console.log(`\nThe queue IS moving — ${mined - started} mined while watching, ${pending - mined} to go.`);
    console.log("That is a backlog, not a stall. Replacing these would compete with");
    console.log("transactions that will succeed anyway. Let it finish and re-run this");
    console.log("if it is still going in a few minutes.");
    return;
  }

  // --- nothing moved: replace ---------------------------------------------
  console.log(`\nNothing mined in ${WATCH_SECONDS}s. Treating nonce ${mined} as stuck.`);
  console.log("Replacing each queued nonce with a priced no-op self-transfer.\n");

  for (let n = mined; n < pending; n++) {
    // Re-read every iteration: the chain may start moving mid-run, and sending
    // at an already-consumed nonce fails with a misleading "nonce too low".
    const fresh = await provider.getTransactionCount(deployer.address, "latest");
    if (fresh > n) {
      console.log(`  nonce ${n} already mined — skipping ahead to ${fresh}`);
      n = fresh - 1;
      continue;
    }
    try {
      const tx = await deployer.sendTransaction({ to: deployer.address, value: 0, nonce: n });
      console.log(`  replacing nonce ${n} … ${tx.hash}`);
      await tx.wait();
      console.log("  ✓ mined");
    } catch (e) {
      const msg = String(e.shortMessage ?? e.message ?? e);
      if (/nonce too low/i.test(msg)) {
        console.log(`  nonce ${n} was consumed while sending — skipping`);
        continue;
      }
      // Match what nodes ACTUALLY say. Hardhat answers "Known transaction:",
      // geth-family "already known" or "replacement transaction underpriced" —
      // an unmatched one here crashes with a stack trace instead of the one
      // sentence that tells you what to do next.
      if (/underpriced|already known|known transaction/i.test(msg)) {
        console.log(`  nonce ${n}: the node refuses a replacement — ${msg.slice(0, 90)}`);
        console.log("  (An identical replacement is rejected as a duplicate. This one needs a");
        console.log("   higher price than the transaction already sitting there.)");
        console.log("  A cluster restart clears the mempool, which is the remaining option.");
        return;
      }
      throw e;
    }
  }
  console.log("\nUnstuck. Re-run whatever was blocked.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
