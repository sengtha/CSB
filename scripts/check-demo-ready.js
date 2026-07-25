const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Why did that revert? Read-only preflight for the demo scripts.
 *
 * A permissioned chain refuses things for reasons that never reach the error
 * message: Subnet-EVM's allow-list precompiles reject before any contract runs,
 * so the provider reports a bare "execution reverted" with nothing to decode.
 *
 * EVERY probe here is individually guarded. An earlier version was not, and when
 * one precompile turned out to be absent the preflight itself threw the same
 * opaque error it existed to explain. A diagnostic that can fail the way the
 * thing it diagnoses fails is worse than none, so nothing below can throw.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/check-demo-ready.js --network csbRemote
 */
const PRECOMPILES = [
  ["txAllowList", "0x0200000000000000000000000000000000000002", "who may send transactions"],
  ["contractDeployerAllowList", "0x0200000000000000000000000000000000000000", "who may create contracts"],
  ["feeManager", "0x0200000000000000000000000000000000000003", "gas price"],
  ["nativeMinter", "0x0200000000000000000000000000000000000001", "tRIEL issuance"],
  ["rewardManager", "0x0200000000000000000000000000000000000004", "where gas fees go"],
];
const ALLOWLIST_ABI = ["function readAllowList(address addr) view returns (uint256)"];
const ROLE = { 0: "NOT ALLOWED", 1: "enabled", 2: "admin", 3: "manager" };

let problems = 0;
const bad = (m) => { problems++; console.log(`  ✗ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);
const note = (m) => console.log(`  – ${m}`);

/** Run a probe; never throw. Returns {value} or {error}. */
async function probe(fn) {
  try {
    return { value: await fn() };
  } catch (e) {
    return { error: String(e?.shortMessage ?? e?.message ?? e).split("\n")[0] };
  }
}

async function main() {
  const { ethers } = hre;
  const file = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const [deployer] = await ethers.getSigners();

  const net = await probe(() => ethers.provider.getNetwork());
  console.log(`Chain ${net.value?.chainId ?? "?"} · deployer ${deployer.address}`);
  const bal = await probe(() => ethers.provider.getBalance(deployer.address));
  console.log(`Deployer native balance: ${bal.value != null ? ethers.formatEther(bal.value) : "?"} tRIEL\n`);

  // --- which precompiles does this chain actually have? -------------------
  // Precompiles can only be enabled at genesis, so a chain redeployed with
  // different wizard answers can be missing one the scripts assume.
  console.log("Precompiles present on this chain");
  const present = {};
  for (const [name, addr, what] of PRECOMPILES) {
    const c = new ethers.Contract(addr, ALLOWLIST_ABI, ethers.provider);
    const r = await probe(() => c.readAllowList(deployer.address));
    if (r.error) {
      present[name] = false;
      note(`${name.padEnd(26)} absent — no restriction on ${what}`);
    } else {
      present[name] = true;
      const role = ROLE[Number(r.value)] ?? String(r.value);
      if (r.value === 0n) bad(`${name.padEnd(26)} deployer is ${role} (${what})`);
      else ok(`${name.padEnd(26)} deployer is ${role}`);
    }
  }

  // --- addresses that must be able to act ---------------------------------
  if (present.txAllowList || present.contractDeployerAllowList) {
    console.log("\nAllow-list status of the demo participants");
    const tx = new ethers.Contract(PRECOMPILES[0][1], ALLOWLIST_ABI, ethers.provider);
    const dep = new ethers.Contract(PRECOMPILES[1][1], ALLOWLIST_ABI, ethers.provider);

    if (present.contractDeployerAllowList) {
      const reg = d.contracts?.LandTitleRegistry;
      if (reg) {
        const r = await probe(() => dep.readAllowList(reg));
        if (r.error) note(`LandTitleRegistry check failed: ${r.error}`);
        else if (r.value === 0n) {
          bad(`LandTitleRegistry ${reg} may NOT create contracts`);
          console.log("      It deploys a token per parcel, so tokenizeParcel reverts with no");
          console.log("      reason string. Re-running scripts/demo-land.js grants this.");
        } else ok("LandTitleRegistry may create title tokens");
      } else note("LandTitleRegistry not deployed yet");
    }

    if (present.txAllowList) {
      let any = false;
      for (const group of ["idpoor", "land"]) {
        for (const [key, a] of Object.entries(d.pilot?.[group] ?? {})) {
          if (!a || typeof a !== "object" || !a.address) continue;
          any = true;
          const r = await probe(() => tx.readAllowList(a.address));
          if (r.error) note(`${group}.${key}: ${r.error}`);
          else if (r.value === 0n) bad(`${group}.${key} ${a.address} may NOT send transactions`);
          else ok(`${group}.${key} may transact`);
        }
      }
      if (!any) note("no demo accounts created yet");
    }
  }

  // --- contract-level state -----------------------------------------------
  console.log("\nContract state");
  await checkContracts(ethers, d, deployer);

  console.log(problems === 0
    ? "\nNo blocking problems found."
    : `\n${problems} problem(s) above. Re-running the demo script fixes the allow-list ones.`);
  if (problems > 0) process.exitCode = 1;
}

async function checkContracts(ethers, d, deployer) {
  const addrs = d.contracts ?? {};
  for (const [label, key] of [
    ["IdentityRegistry", "IdentityRegistry"],
    ["KHRStablecoin", "KHRStablecoin"],
    ["MerchantRegistry", "MerchantRegistry"],
    ["SocialProgramRegistry", "SocialProgramRegistry"],
    ["LandTitleRegistry", "LandTitleRegistry"],
    ["LandCollateralVault", "LandCollateralVault"],
  ]) {
    const a = addrs[key];
    if (!a) { note(`${label.padEnd(22)} not deployed yet`); continue; }
    const code = await probe(() => ethers.provider.getCode(a));
    if (code.error) note(`${label.padEnd(22)} ${a} — ${code.error}`);
    else if (code.value === "0x") bad(`${label.padEnd(22)} ${a} — NO CONTRACT AT THIS ADDRESS (stale deployments.json?)`);
    else ok(`${label.padEnd(22)} ${a}`);
  }

  if (!addrs.KHRStablecoin || !addrs.IdentityRegistry) return;
  const khr = await ethers.getContractAt("KHRStablecoin", addrs.KHRStablecoin);
  const identity = await ethers.getContractAt("IdentityRegistry", addrs.IdentityRegistry);

  const issuer = await probe(async () => khr.hasRole(await khr.ISSUER_ROLE(), deployer.address));
  if (issuer.error) bad(`could not read ISSUER_ROLE: ${issuer.error}`);
  else if (!issuer.value) bad("deployer LACKS ISSUER_ROLE on KHRt (needed to issue assistance)");
  else ok("deployer has ISSUER_ROLE on KHRt");

  const admin = await probe(() => khr.hasRole(ethers.ZeroHash, deployer.address));
  if (admin.error) bad(`could not read DEFAULT_ADMIN_ROLE: ${admin.error}`);
  else if (!admin.value) bad("deployer LACKS DEFAULT_ADMIN_ROLE on KHRt (needed to set the spend policy)");
  else ok("deployer has DEFAULT_ADMIN_ROLE on KHRt");

  const idIssuer = await probe(async () => identity.hasRole(await identity.ISSUER_ROLE(), deployer.address));
  if (idIssuer.error) bad(`could not read IdentityRegistry ISSUER_ROLE: ${idIssuer.error}`);
  else if (!idIssuer.value) bad("deployer LACKS ISSUER_ROLE on IdentityRegistry (needed to KYC demo accounts)");
  else ok("deployer has ISSUER_ROLE on IdentityRegistry");

  // The extended KHRt is required by the ID Poor demo. An older deployment
  // predates it, and calling issueRestricted on it reverts with no reason.
  const policy = await probe(() => khr.spendPolicy());
  if (policy.error) {
    bad("KHRt at this address has NO spendPolicy() — it predates the assigned-spend-target");
    console.log("      upgrade, so scripts/demo-idpoor.js cannot work against it. Redeploy the");
    console.log("      contract suite (scripts/deploy.js) to get the extended KHRt.");
  } else if (policy.value === ethers.ZeroAddress) {
    note("KHRt spend policy not set yet (demo-idpoor sets it)");
  } else ok(`KHRt spend policy → ${policy.value}`);

  const kyc = await probe(() => identity.isActive(deployer.address));
  if (kyc.value === false) note("deployer has no KYC attestation (demo-land registers it automatically)");
  else if (kyc.value === true) ok("deployer holds an active KYC attestation");
}

main().catch((e) => {
  console.error("\nPreflight itself failed:", String(e?.shortMessage ?? e?.message ?? e));
  process.exitCode = 1;
});
