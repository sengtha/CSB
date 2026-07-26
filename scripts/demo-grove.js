const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { enableTransactor, enableDeployer, explain } = require("./lib/csb-precompiles");

/**
 * Grove — a digital twin with money attached.
 *
 * Runs the whole story on a live chain, in the order it happens in the world:
 *
 *   1. A farmer plants 500 mangroves and records it on her phone. Grove signs
 *      the record on-device; only its content hash is anchored here.
 *   2. A licensed commune agriculture officer visits and confirms it. Anonymous
 *      keys can co-sign in Grove; only a licence counts on CSB.
 *   3. The grove becomes a title token whose supply IS the verified tree count.
 *   4. A sponsor abroad funds SURVIVAL, not planting — milestones that release
 *      only against a fresh, confirmed record.
 *   5. A year passes, 70 trees die, the officer confirms 430 standing. The money
 *      moves, the verifier is paid for the visit, and the token shrinks to 430.
 *
 * The refusals along the way are the demonstration: last year's photograph, an
 * unverified record, and a stranger's thriving grove are all offered as proof,
 * and the chain says exactly why each one is not.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/demo-grove.js --network csbRemote
 *
 * ILLUSTRATIVE. No real grove, licence, officer, sponsor, or payment. Tokens are
 * valueless test artifacts, and nothing here is a carbon credit.
 */
const YEAR = 365 * 24 * 3600;

async function main() {
  const { ethers } = hre;
  const file = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [deployer] = await ethers.getSigners();

  const identity = await ethers.getContractAt("IdentityRegistry", d.contracts.IdentityRegistry);
  const khr = await ethers.getContractAt("KHRStablecoin", d.contracts.KHRStablecoin);

  console.log(`Registrar / sponsor (pilot: all one key): ${deployer.address}\n`);

  // The deployer stands in for the sponsor, and a sponsor holds KHRt — so it
  // needs its own KYC attestation like anyone else. Chain admin is not a KYC
  // exemption anywhere in CSB, and this is no exception.
  if (!(await identity.isActive(deployer.address))) {
    await (await identity.register(deployer.address, ethers.id("grove-sponsor-institution"), 4)).wait();
    console.log("Registered the sponsor institution (tier 4) — admin rights are not a KYC exemption.\n");
  }

  // --- 1. contracts -------------------------------------------------------
  const attesters = await ensure(d, "AttesterRegistry", () =>
    ethers.deployContract("AttesterRegistry", [deployer.address, deployer.address]));
  const anchor = await ensure(d, "GroveAnchor", () =>
    ethers.deployContract("GroveAnchor", [
      d.contracts.IdentityRegistry, d.contracts.EnforcementRegistry, attesters.target, deployer.address,
    ]));
  const registry = await ensure(d, "GroveTitleRegistry", () =>
    ethers.deployContract("GroveTitleRegistry", [
      d.contracts.IdentityRegistry, d.contracts.EnforcementRegistry, anchor.target,
      deployer.address, deployer.address,
    ]));
  const pledge = await ensure(d, "GrovePledge", () =>
    ethers.deployContract("GrovePledge", [anchor.target, deployer.address, deployer.address]));

  // The anchor writes verifier reputation back into the licence registry.
  const RECORDER = await attesters.RECORDER_ROLE();
  if (!(await attesters.hasRole(RECORDER, anchor.target))) {
    await (await attesters.grantRole(RECORDER, anchor.target)).wait();
    console.log("  granted GroveAnchor the right to record verifier work");
  }
  // The registry deploys a GroveTitle per grove, and that create is performed BY
  // THE REGISTRY — so on a chain with contractDeployerAllowList the registry's
  // own address must be enabled, or registerGrove reverts with no reason at all.
  await enableDeployer(ethers, deployer, registry.target, "GroveTitleRegistry");
  // The pledge custodies KHRt with no personal identity, so the council vets it
  // exactly as it vets the escrow and the bridge adapter.
  if (!(await khr.isSystemContract(pledge.target))) {
    await (await khr.setSystemContract(pledge.target, true)).wait();
    console.log("  vetted GrovePledge as a system contract (may custody KHRt)");
  }
  fs.writeFileSync(file, JSON.stringify(d, null, 2));

  // --- 2. cast ------------------------------------------------------------
  d.pilot = d.pilot ?? {};
  const cast = d.pilot.grove ?? {};
  const need = async (key, label, tier) => {
    if (!cast[key]) {
      const w = ethers.Wallet.createRandom();
      cast[key] = { address: w.address, key: w.privateKey, label };
    }
    // Check the CHAIN, not the cache: deployments.json survives a chain reset,
    // and a cached account can name an address this IdentityRegistry has never
    // heard of — every later step then fails in a way that looks like policy.
    if (!(await identity.isActive(cast[key].address))) {
      await (await identity.register(cast[key].address, ethers.id(`grove-${key}-${cast[key].address}`), tier)).wait();
      console.log(`  registered ${label}: ${cast[key].address}`);
    } else {
      console.log(`  ${label}: ${cast[key].address}`);
    }
    await fundGas(ethers, deployer, cast[key].address);
    await enableTransactor(ethers, deployer, cast[key].address);
    return cast[key];
  };
  console.log("\nCast (KYC'd on chain):");
  // Tier 1: recording your own garden should not require a business licence.
  const farmer = await need("farmer", "Farmer / grove steward", 1);
  const officer = await need("officer", "Commune agriculture officer", 2);
  d.pilot.grove = cast;
  fs.writeFileSync(file, JSON.stringify(d, null, 2));

  const farmerW = new ethers.Wallet(farmer.key, ethers.provider);
  const officerW = new ethers.Wallet(officer.key, ethers.provider);

  if (!(await attesters.isLicensed(officer.address))) {
    await (await attesters.licenseAttester(
      officer.address, await attesters.COMMUNE(),
      ethers.id(`licence/agri-officer/${officer.address}`),
      "Commune agriculture officer (illustrative)",
    )).wait();
    console.log("  licensed the officer as a field verifier — a licence they can lose");
  }

  // --- 3. plant and anchor ------------------------------------------------
  const plotRef = process.env.CSB_PLOT_REF ?? `demo-grove-${Date.now()}`;
  const plotId = ethers.id(plotRef);
  // Stands in for Grove's SHA-256 content hash of the signed observation. In
  // production this comes straight off the phone; the chain never sees the
  // record itself, only this.
  const obs1 = ethers.id(`${plotRef}/observation-1`);

  console.log(`\n─── 1. The farmer records 500 mangroves on her phone ───`);
  console.log(`  plot            "${plotRef}"`);
  console.log(`  observation id  ${obs1}`);
  await (await anchor.connect(farmerW).anchor(obs1, plotId, ethers.ZeroHash, 500, tag("rhizophora"))).wait();
  const a1 = await anchor.anchorOf(obs1);
  console.log(`  anchored at     ${new Date(Number(a1.anchoredAt) * 1000).toISOString()} (block time — not her phone's clock)`);
  console.log(`  verified?       ${await anchor.isVerified(obs1)}  ← nobody has been to look yet`);

  console.log(`\n─── 2. Anyone with a keyboard tries to verify it ───`);
  const nobody = ethers.Wallet.createRandom().address;
  let [ok, why] = await anchor.canAttest(nobody, obs1);
  console.log(`  canAttest → ${ok}`);
  console.log(`  reason    → "${why}"`);
  [ok, why] = await anchor.canAttest(farmer.address, obs1);
  console.log(`  and the farmer, verifying her own record → ${ok}: "${why}"`);

  console.log(`\n─── 3. The licensed officer visits and confirms ───`);
  await (await anchor.connect(officerW).attest(obs1, true, ethers.id(`field-note/${plotRef}/1`))).wait();
  console.log(`  verified?              ${await anchor.isVerified(obs1)}`);
  console.log(`  verified tree count    ${await anchor.verifiedCountOf(plotId)}`);

  // --- 4. tokenize --------------------------------------------------------
  console.log(`\n─── 4. The grove becomes a title — one share, one verified tree ───`);
  let titleAddr = (await registry.groveOf(plotId)).token;
  if (titleAddr === ethers.ZeroAddress) {
    await (await registry.registerGrove({
      plotId,
      name: "Demo Mangrove Grove",
      symbol: "GROVE1",
      location: "Demo commune, Koh Kong (illustrative)",
      groveURI: `grove://${plotRef}`,
      minimumTier: 1,
      steward: farmer.address,
    })).wait();
    titleAddr = (await registry.groveOf(plotId)).token;
  }
  const title = await ethers.getContractAt("GroveTitle", titleAddr);
  console.log(`  title token   ${titleAddr}`);
  console.log(`  supply        ${await title.totalSupply()} shares — the count a licensed verifier confirmed`);
  console.log(`  farmer holds  ${await title.balanceOf(farmer.address)}`);
  console.log(`  the registrar cannot mint one more: AGENT_ROLE is the registry's,`);
  console.log(`  and its only mint path reads the anchored, attested record.`);

  // --- 5. the pledge ------------------------------------------------------
  console.log(`\n─── 5. A sponsor funds SURVIVAL, not planting ───`);
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  // Demo windows are short so the whole story runs in one sitting. A real
  // pledge uses 12 and 24 months; nothing in the contract knows the difference.
  const window = Number(process.env.CSB_PLEDGE_WINDOW ?? 60);
  const notBefore = now + window;
  const growerAmount = 600_000_00n;
  const verifierAmount = 50_000_00n;

  await (await pledge.createPledge(
    plotId, farmer.address, khr.target,
    "500 mangroves — survival milestone (illustrative)",
    [{
      notBefore,
      deadline: notBefore + YEAR,
      requiredCount: 400,
      growerAmount,
      verifierAmount,
    }],
  )).wait();
  const pledgeId = await pledge.pledgeCount();
  const p = await pledge.pledgeOf(pledgeId);
  if ((await khr.balanceOf(deployer.address)) < p.total) {
    await (await khr.issue(deployer.address, p.total)).wait();
  }
  await (await khr.approve(pledge.target, p.total)).wait();
  await (await pledge.fund(pledgeId)).wait();
  console.log(`  pledge #${pledgeId}: ${fmt(p.total)} KHRt deposited, in the contract, not a promise`);
  console.log(`    grower gets   ${fmt(growerAmount)} KHRt if 400 are still standing`);
  console.log(`    verifier gets ${fmt(verifierAmount)} KHRt for going to look`);

  const show = async (label, obsId) => {
    const [can, reason] = await pledge.canClaim(pledgeId, 0, obsId);
    console.log(`  ${label}\n    → ${can}: "${reason}"`);
  };
  console.log(`\n─── 6. Claiming it early, on the day it was planted ───`);
  await show("The planting record, offered the moment the money landed:", obs1);

  // --- 6. a year passes ---------------------------------------------------
  console.log(`\n─── 7. Waiting ${window}s for the survival window (a year, compressed) ───`);
  // A stranger's thriving grove, anchored while we wait — to be offered later
  // as proof that THIS grove survived.
  const otherPlot = ethers.id(`${plotRef}/somebody-elses`);
  const otherObs = ethers.id(`${plotRef}/somebody-elses/1`);
  await (await anchor.anchor(otherObs, otherPlot, ethers.ZeroHash, 900, tag("rhizophora"))).wait();
  await waitUntil(ethers, deployer, notBefore + 5);

  console.log(`\n─── 8. Three ways to get paid without the trees ───`);
  await show("Last year's healthy photograph, as proof of this year:", obs1);
  await show("Somebody else's 900-tree grove:", otherObs);

  const obs2 = ethers.id(`${plotRef}/observation-2`);
  await (await anchor.connect(farmerW).anchor(obs2, plotId, obs1, 430, tag("rhizophora"))).wait();
  console.log(`  (the farmer records 430 still standing — 70 did not make it)`);
  await show("Her own new record, before anyone has been to look:", obs2);

  console.log(`\n─── 9. The officer visits again and confirms ───`);
  await (await anchor.connect(officerW).attest(obs2, true, ethers.id(`field-note/${plotRef}/2`))).wait();
  await show("The same record, confirmed by a licensed verifier:", obs2);

  // --- 7. settle ----------------------------------------------------------
  console.log(`\n─── 10. The money moves ───`);
  const growerBefore = await khr.balanceOf(farmer.address);
  const officerBefore = await khr.balanceOf(officer.address);
  await (await pledge.connect(farmerW).claimMilestone(pledgeId, 0, obs2)).wait();
  console.log(`  farmer  +${fmt((await khr.balanceOf(farmer.address)) - growerBefore)} KHRt`);
  console.log(`  officer +${fmt((await khr.balanceOf(officer.address)) - officerBefore)} KHRt  ← paid for the visit, on chain`);

  // --- leave a live demonstration behind ----------------------------------
  // The story above consumes itself. Its head record is confirmed and its
  // milestone is paid, so every question the use-cases page could ask about
  // them answers "already attested" or "this pledge is closed" — true, and it
  // teaches nothing. So it also leaves two things standing: a record nobody has
  // confirmed, and a milestone nobody has claimed.
  console.log(`\n─── 12. Leaving something for the public page to refuse ───`);

  const showcasePlot = ethers.id(`${plotRef}/neighbour`);
  const showcaseObs = ethers.id(`${plotRef}/neighbour/1`);
  if (!(await anchor.isAnchored(showcaseObs))) {
    await (await anchor.connect(farmerW).anchor(showcaseObs, showcasePlot, ethers.ZeroHash, 120, tag("mangifera"))).wait();
  }
  console.log(`  a neighbouring grove, recorded and not yet visited by anyone`);

  // A second pledge whose window is ALREADY open and whose milestone is left
  // unclaimed. notBefore sits between the two records deliberately: the survival
  // record qualifies, last year's planting record is too old, and somebody
  // else's grove belongs to another plot. Three answers, one of them yes.
  const openNotBefore = Number(a1.anchoredAt) + 1;
  await (await pledge.createPledge(
    plotId, farmer.address, khr.target,
    "500 mangroves — open survival milestone (illustrative)",
    [{
      notBefore: openNotBefore,
      deadline: (await ethers.provider.getBlock("latest")).timestamp + YEAR,
      requiredCount: 400,
      growerAmount,
      verifierAmount,
    }],
  )).wait();
  const openPledgeId = await pledge.pledgeCount();
  const openTotal = (await pledge.pledgeOf(openPledgeId)).total;
  if ((await khr.balanceOf(deployer.address)) < openTotal) {
    await (await khr.issue(deployer.address, openTotal)).wait();
  }
  await (await khr.approve(pledge.target, openTotal)).wait();
  await (await pledge.fund(openPledgeId)).wait();
  console.log(`  pledge #${openPledgeId}: ${fmt(openTotal)} KHRt funded and unclaimed, window open`);

  // Record what this run created, so the public use-cases page can show a LIVE
  // grove instead of a screenshot. Ids only — no keys, and the plot string is
  // already public in the Grove feed, so nothing here is newly disclosed.
  cast.demo = {
    plotRef,
    plotId,
    otherPlotId: otherPlot,
    titleToken: titleAddr,
    // The OPEN pledge, not the one the story settled — the page needs a
    // question the chain still has an interesting answer to.
    pledgeId: Number(openPledgeId),
    milestone: 0,
    settledPledgeId: Number(pledgeId),
    // A record nobody has confirmed, so "who may verify this?" is still a live
    // question rather than "somebody already did".
    showcase: { plotId: showcasePlot, observationId: showcaseObs, liveCount: 120 },
    observations: [
      { id: obs2, label: "This year's record — 430 standing, confirmed in the field" },
      { id: obs1, label: "Last year's planting record — 500, healthy" },
      { id: otherObs, label: "Somebody else's 900-tree grove" },
    ],
    attesters: [
      { address: officer.address, label: "The licensed commune agriculture officer" },
      { address: farmer.address, label: "The farmer who recorded it herself" },
    ],
  };
  d.pilot.grove = cast;
  fs.writeFileSync(file, JSON.stringify(d, null, 2));

  console.log(`\n─── 11. The twin follows the real grove — downwards ───`);
  await (await registry.syncSupply(plotId)).wait();
  console.log(`  supply was 500, is now ${await title.totalSupply()} — because 70 trees died and the ledger says so`);
  const [supply, verified, inSync] = await registry.supplyStatus(plotId);
  console.log(`  supply ${supply} · verified ${verified} · in sync: ${inSync}`);

  console.log(`\nWhat this shows: nothing here mints a tonne of CO2, because nobody can`);
  console.log(`check one. It records a tree, which somebody with a licence to lose went`);
  console.log(`and looked at — and it pays them both only when the tree is still there.`);
  console.log(`\nCamboVerse renders this same plot as a virtual grove, reading the anchor`);
  console.log(`status straight off this chain. The 3D garden and the payment are the`);
  console.log(`same record, which is what a digital twin actually means.`);
  console.log(`\nIllustrative demo — no real grove, no real payment, valueless test tokens.`);
}

/** Deploy a contract if deployments.json doesn't already name one. */
async function ensure(d, name, deploy) {
  const { ethers } = hre;
  if (d.contracts[name]) {
    console.log(`Using existing ${name} ${d.contracts[name]}`);
    return ethers.getContractAt(name, d.contracts[name]);
  }
  console.log(`Deploying ${name}…`);
  const c = await deploy();
  await c.waitForDeployment();
  d.contracts[name] = c.target;
  console.log(`  ${name} ${c.target}`);
  return c;
}

/**
 * Wait for the chain's clock to pass `when`.
 *
 * Chain time is not wall-clock time. Subnet-EVM (and a local Hardhat node)
 * produce a block when there is something to put in it, so a quiet chain's
 * `block.timestamp` simply stops — and a poll loop waiting for it to advance
 * waits forever. Every poll therefore sends a zero-value transaction to self,
 * which costs a little gas and produces the block whose timestamp we are
 * waiting for. Milestone windows are checked against block time, so this is the
 * clock that matters.
 */
async function waitUntil(ethers, signer, when) {
  for (;;) {
    const t = (await ethers.provider.getBlock("latest")).timestamp;
    if (t >= when) return;
    process.stdout.write(`\r  ${when - t}s…   `);
    await new Promise((r) => setTimeout(r, 3000));
    await (await signer.sendTransaction({ to: signer.address, value: 0 })).wait();
  }
}

async function fundGas(ethers, deployer, to) {
  const target = ethers.parseEther(process.env.CSB_DEMO_GAS ?? "100");
  const bal = await ethers.provider.getBalance(to);
  if (bal >= target) return;
  await (await deployer.sendTransaction({ to, value: target - bal })).wait();
}

const tag = (s) => hre.ethers.encodeBytes32String(s);

function fmt(units) {
  return (Number(units) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

main().catch((e) => {
  console.error("\nFailed:", explain(e));
  process.exitCode = 1;
});
