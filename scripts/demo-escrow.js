const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { enableTransactor, explain } = require("./lib/csb-precompiles");

/**
 * Delivery escrow — one payment, three payees, settled in a single transaction.
 *
 * A customer orders food for 20,000 riel. That payment is really three: the
 * restaurant, the rider, and the platform's commission. The split is agreed
 * before the customer pays, held by the contract rather than the platform, and
 * settles atomically on confirmation.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/demo-escrow.js --network csbRemote
 *
 * ILLUSTRATIVE. Generated demo accounts, valueless test tokens, no real merchant
 * or delivery service involved.
 */
async function main() {
  const { ethers } = hre;
  const file = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [deployer] = await ethers.getSigners();

  const identity = await ethers.getContractAt("IdentityRegistry", d.contracts.IdentityRegistry);
  const khr = await ethers.getContractAt("KHRStablecoin", d.contracts.KHRStablecoin);

  console.log(`Deployer / council / arbiter: ${deployer.address}\n`);

  // --- 1. contract --------------------------------------------------------
  let escrow;
  if (d.contracts.PaymentEscrow) {
    escrow = await ethers.getContractAt("PaymentEscrow", d.contracts.PaymentEscrow);
    console.log(`Using existing PaymentEscrow ${escrow.target}`);
  } else {
    console.log("Deploying PaymentEscrow…");
    escrow = await ethers.deployContract("PaymentEscrow", [deployer.address, deployer.address]);
    await escrow.waitForDeployment();
    d.contracts.PaymentEscrow = escrow.target;
    fs.writeFileSync(file, JSON.stringify(d, null, 2));
    console.log(`  PaymentEscrow ${escrow.target}`);
  }
  // It holds KHRt but has no personal identity, so the council vets it — the
  // same treatment the bridge adapter and the collateral vault get.
  if (!(await khr.isSystemContract(escrow.target))) {
    await (await khr.setSystemContract(escrow.target, true)).wait();
    console.log("  Vetted as a system contract (may custody KHRt)");
  }

  // --- 2. cast ------------------------------------------------------------
  d.pilot = d.pilot ?? {};
  const cast = d.pilot.escrow ?? {};
  const need = async (key, label, tier) => {
    if (!cast[key]) {
      const w = ethers.Wallet.createRandom();
      cast[key] = { address: w.address, key: w.privateKey, label };
    }
    if (!(await identity.isActive(cast[key].address))) {
      await (await identity.register(cast[key].address, ethers.id(`escrow-${key}-${cast[key].address}`), tier)).wait();
      console.log(`  registered ${label}: ${cast[key].address}`);
    } else {
      console.log(`  ${label}: ${cast[key].address}`);
    }
    await fundGas(ethers, deployer, cast[key].address);
    await enableTransactor(ethers, deployer, cast[key].address);
    return cast[key];
  };
  console.log("\nCast (KYC'd on chain):");
  const buyer = await need("buyer", "Customer", 2);
  const restaurant = await need("restaurant", "Restaurant", 3);
  const rider = await need("rider", "Delivery rider", 2);
  const platform = await need("platform", "Delivery platform", 3);
  d.pilot.escrow = cast;
  fs.writeFileSync(file, JSON.stringify(d, null, 2));

  // --- 3. the order -------------------------------------------------------
  const split = [
    { who: restaurant, label: "Restaurant", amount: 15_000_00n },
    { who: rider, label: "Delivery rider", amount: 3_500_00n },
    { who: platform, label: "Platform commission", amount: 1_500_00n },
  ];
  const total = split.reduce((a, s) => a + s.amount, 0n);

  console.log(`\n─── The order, agreed BEFORE the customer pays ───`);
  for (const s of split) console.log(`  ${s.label.padEnd(22)} ${fmt(s.amount).padStart(10)} KHRt`);
  console.log(`  ${"".padEnd(22)} ${"".padStart(10, "─")}`);
  console.log(`  ${"Customer pays".padEnd(22)} ${fmt(total).padStart(10)} KHRt`);

  const ref = ethers.id(`order/${Date.now()}`);
  const deadline = Math.floor(Date.now() / 1000) + 24 * 3600;
  await (await escrow.createOrder(
    ref, buyer.address, khr.target, split.map((s) => s.who.address), split.map((s) => s.amount), deadline,
  )).wait();
  const orderId = Number(await escrow.orderCount());
  console.log(`\n  Order #${orderId} created. Nothing has moved yet.`);

  // --- 4. pay into escrow -------------------------------------------------
  if ((await khr.balanceOf(buyer.address)) < total) {
    await (await khr.issue(buyer.address, total * 2n)).wait();
    console.log(`  (funded the customer's wallet with ${fmt(total * 2n)} KHRt for the demo)`);
  }
  const bw = new ethers.Wallet(buyer.key, ethers.provider);

  console.log(`\n─── Customer pays into escrow ───`);
  await (await khr.connect(bw).approve(escrow.target, total)).wait();
  await (await escrow.connect(bw).fund(orderId)).wait();
  console.log(`  Escrow holds:     ${fmt(await khr.balanceOf(escrow.target))} KHRt`);
  console.log(`  Platform holds:   ${fmt(await khr.balanceOf(platform.address))} KHRt  ← the platform never touches it`);
  console.log(`  Rider holds:      ${fmt(await khr.balanceOf(rider.address))} KHRt  ← not paid yet`);

  // --- 5. delivered → settle everyone at once -----------------------------
  console.log(`\n─── Delivered. Customer confirms — everyone is paid in ONE transaction ───`);
  const [ok, why] = await escrow.canRelease(orderId);
  console.log(`  canRelease → ${ok}${why ? ` (${why})` : ""}`);
  const rc = await (await escrow.connect(bw).confirmAndRelease(orderId)).wait();
  console.log(`  tx ${rc.hash}`);
  for (const s of split) {
    console.log(`  ${s.label.padEnd(22)} ${fmt(await khr.balanceOf(s.who.address)).padStart(10)} KHRt`);
  }
  console.log(`  ${"Escrow remaining".padEnd(22)} ${fmt(await khr.balanceOf(escrow.target)).padStart(10)} KHRt`);

  // --- 6. what happens when compliance says no ----------------------------
  console.log(`\n─── And if a payee is frozen by an enforcement order ───`);
  const enforcement = await ethers.getContractAt("EnforcementRegistry", d.contracts.EnforcementRegistry);
  const ref2 = ethers.id(`order/${Date.now()}-frozen`);
  await (await escrow.createOrder(
    ref2, buyer.address, khr.target, split.map((s) => s.who.address), split.map((s) => s.amount), deadline,
  )).wait();
  const id2 = Number(await escrow.orderCount());
  await (await khr.connect(bw).approve(escrow.target, total)).wait();
  await (await escrow.connect(bw).fund(id2)).wait();

  let froze = false;
  try {
    await (await enforcement.freeze(rider.address, ethers.id("demo court order"))).wait();
    froze = true;
    console.log(`  Rider frozen by enforcement order.`);
  } catch (e) {
    console.log(`  (could not freeze — needs the enforcer role: ${e.shortMessage ?? e.message})`);
  }

  if (froze) {
    try {
      await (await escrow.connect(bw).confirmAndRelease(id2)).wait();
      console.log("  ✗ UNEXPECTED: the release succeeded despite the freeze!");
      process.exitCode = 1;
    } catch (_) {
      console.log("  ✓ the whole settlement is refused — not even the restaurant is paid.");
      console.log("    Enforcement outranks the commercial obligation.");
    }
    await (await escrow.refundByArbiter(id2, ethers.id("payee frozen"))).wait();
    console.log(`  ✓ arbiter refunded the customer: escrow now holds ${fmt(await khr.balanceOf(escrow.target))} KHRt`);
    await (await enforcement.unfreeze(rider.address, ethers.id("demo over"))).wait();
    console.log(`  (rider unfrozen — demo cleanup)`);
  }

  console.log(`\nWhat this shows: the customer saw the rider's fare before paying,`);
  console.log(`the platform never held the money, and every party was paid in the same`);
  console.log(`transaction — or, when compliance said no, nobody was.`);
  console.log(`\nIllustrative demo — generated accounts, valueless test tokens.`);
}

async function fundGas(ethers, deployer, to) {
  const target = ethers.parseEther(process.env.CSB_DEMO_GAS ?? "100");
  const bal = await ethers.provider.getBalance(to);
  if (bal >= target) return;
  await (await deployer.sendTransaction({ to, value: target - bal })).wait();
}

function fmt(units) {
  return (Number(units) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

main().catch((e) => {
  console.error("\nFailed:", explain(e));
  process.exitCode = 1;
});
