const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Deploy Safe (Gnosis Safe) on CSB and create the first institutional multisig.
 *
 *   (cd vendor/safe && npm install)     # once; see below
 *   source ops/csb-env.sh
 *   CSB_SAFE_OWNERS=0xAAA...,0xBBB...,0xCCC... CSB_SAFE_THRESHOLD=2 \
 *     npx hardhat run scripts/deploy-safe.js --network csbRemote
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. docs/architecture.md §4 lists seven powers
 * split across institutions, and then admits that on this deployment every single
 * one is held by the same deployer key — a key whose private half was printed in
 * plain text by `avalanche blockchain describe`. The separation of powers is real
 * in the contracts and worth nothing in practice. A Safe is the first thing that
 * changes that, because it is the only way a role can require more than one
 * person without changing any of the contracts that grant it.
 *
 * WHAT IS DEPLOYED. Four Safe 1.4.1 contracts, unmodified from the published npm
 * package, plus one proxy — the actual wallet:
 *
 *   SafeL2                       the singleton holding the logic
 *   SafeProxyFactory             creates wallets as proxies to it
 *   CompatibilityFallbackHandler EIP-1271 signatures and ERC-165/721/1155 receipt
 *   MultiSendCallOnly            batching, without delegatecall
 *
 * SafeL2 RATHER THAN Safe, AND IT MATTERS LATER. The two are identical except
 * that SafeL2 emits an event for every execution. Subnet-EVM does not serve
 * Parity-style `trace_` RPCs, so the Safe Transaction Service — if this ever gets
 * a web UI — can only index CSB in its event-based mode, which requires SafeL2.
 * Choosing Safe here would mean redeploying every wallet to fix it.
 *
 * CANONICAL ADDRESSES ARE NOT ATTEMPTED. Safe's well-known addresses come from
 * Nick's method: a presigned transaction with a gas price hardcoded near 100
 * gwei. CSB runs around 55,000 gwei, because tRIEL is 18-decimal and a transfer
 * is priced at about one riel, so that transaction underpays by roughly 500x and
 * can never be included. Lowering the base fee through feeManager to fake it
 * would buy an address that matches Ethereum's — which is worth something only
 * to cross-chain tooling that CSB does not use. So these are deployed normally,
 * at ordinary addresses, and recorded in deployments.json where the app looks.
 *
 * Environment:
 *   CSB_SAFE_OWNERS      comma-separated owner addresses   (default: the deployer)
 *   CSB_SAFE_THRESHOLD   signatures required             (default: simple majority)
 *   CSB_SAFE_SALT        proxy salt nonce, to make more than one  (default 0)
 *   CSB_SAFE_KEY         deployments.json key to record under  (default "council")
 *   CSB_SKIP_ATTEST=1    do not register the Safe in the IdentityRegistry
 */

/**
 * WHY THE ARTIFACTS LIVE IN vendor/safe AND NOT IN package.json.
 *
 * Safe 1.4.1 declares `peerDependencies: { ethers: "5.4.0" }` — an exact pin on
 * a major version this project left behind. npm cannot satisfy that against
 * ethers 6, so adding it to the root package.json makes `npm install` fail for
 * everyone who clones this. Installing it with --no-save is worse and was tried
 * here first: npm treated the rest of the tree as extraneous and PRUNED
 * hardhat-toolbox's dependencies, leaving the repo unable to load its own config.
 *
 * vendor/safe has its own package.json, so npm resolves it as a separate tree
 * that never sees the root's ethers. The root install needs no flags and cannot
 * be damaged by this. Nothing of Safe's is copied into the repository — the
 * artifacts are LGPL-3.0 and stay in node_modules, exactly as the Aave and
 * Uniswap artifacts already do.
 */
const VENDORED = path.join(__dirname, "..", "vendor", "safe", "node_modules",
  "@safe-global", "safe-contracts", "build", "artifacts", "contracts");
const ARTIFACTS = {
  SafeL2: "SafeL2.sol/SafeL2.json",
  SafeProxyFactory: "proxies/SafeProxyFactory.sol/SafeProxyFactory.json",
  CompatibilityFallbackHandler:
    "handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json",
  MultiSendCallOnly: "libraries/MultiSendCallOnly.sol/MultiSendCallOnly.json",
};
const TX_ALLOWLIST = "0x0200000000000000000000000000000000000002";
const ALLOWLIST_ABI = ["function readAllowList(address) view returns (uint256)"];
const ROLE = { 0: "NOT ALLOWED", 1: "enabled", 2: "admin", 3: "manager" };
const IDENTITY_ABI = [
  "function register(address account, bytes32 identity, uint8 tier)",
  "function isActive(address) view returns (bool)",
  "function ISSUER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
];

function loadArtifact(rel) {
  const p = path.join(VENDORED, rel);
  if (!fs.existsSync(p)) {
    throw new Error(
      `Safe artifacts are not installed (looked in vendor/safe).\n\n`
      + `  (cd vendor/safe && npm install)\n\n`
      + `They are deliberately not in the root package.json: Safe 1.4.1 pins a peer\n`
      + `dependency on ethers 5.4.0 and this project runs ethers 6, so adding it there\n`
      + `breaks npm install for everyone. Do NOT work around that with --no-save — it\n`
      + `prunes hardhat-toolbox's dependencies and leaves the repo unable to load.`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const bar = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const [signer] = await ethers.getSigners();
  const net = await provider.getNetwork();

  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const key = process.env.CSB_SAFE_KEY ?? "council";

  // --- owners and threshold, decided before anything is deployed ------------
  const owners = (process.env.CSB_SAFE_OWNERS ?? signer.address)
    .split(",").map((s) => s.trim()).filter(Boolean);
  for (const o of owners) {
    if (!ethers.isAddress(o)) throw new Error(`CSB_SAFE_OWNERS contains "${o}", which is not an address.`);
  }
  const lower = owners.map((o) => o.toLowerCase());
  if (new Set(lower).size !== lower.length) {
    throw new Error("CSB_SAFE_OWNERS lists the same address twice — Safe rejects duplicate owners.");
  }
  // A simple majority is the honest default: it is what "the council decided"
  // normally means, and it is the smallest threshold that survives one owner
  // being unavailable or compromised.
  const threshold = Number(process.env.CSB_SAFE_THRESHOLD ?? Math.floor(owners.length / 2) + 1);
  if (!(threshold >= 1 && threshold <= owners.length)) {
    throw new Error(`CSB_SAFE_THRESHOLD must be between 1 and ${owners.length}, got ${threshold}.`);
  }

  bar(`Safe on chain ${net.chainId}`);
  console.log(`Deployer   ${signer.address}`);
  console.log(`Owners     ${owners.length}`);
  owners.forEach((o, i) => console.log(`   ${i + 1}. ${o}`));
  console.log(`Threshold  ${threshold} of ${owners.length}`);

  // A 1-of-1 Safe is a valid wallet and proves nothing about separation of
  // powers. It is allowed — it is a reasonable first step — but it must not be
  // mistaken later for the thing the architecture document describes.
  const placeholder = owners.length < 2 || threshold < 2;
  if (placeholder) {
    console.log(`\n  WARNING: ${threshold}-of-${owners.length} is not a multisig in any`);
    console.log(`  meaningful sense. One key still decides, exactly as today, and`);
    console.log(`  compromising it compromises the wallet. Recorded as a placeholder.`);
    console.log(`  Pass CSB_SAFE_OWNERS with real institutional addresses.`);
  }

  // --- pre-flight: owners must be able to send transactions ----------------
  //
  // The Safe is a contract; it never originates a transaction. An owner does,
  // calling execTransaction. On CSB txAllowList decides who may send anything at
  // all, so an owner who is not listed holds a signing key that cannot be used —
  // and the failure arrives as a bare "execution reverted" from the precompile,
  // long after the ceremony, with nothing naming the cause.
  const allow = new ethers.Contract(TX_ALLOWLIST, ALLOWLIST_ABI, provider);
  const blocked = [];
  for (const o of owners) {
    const role = await allow.readAllowList(o).then(Number).catch(() => null);
    console.log(`  txAllowList ${o}  ${role === null ? "unreadable" : (ROLE[role] ?? role)}`);
    if (role === 0) blocked.push(o);
  }
  if (blocked.length) {
    throw new Error(
      `${blocked.length} owner(s) cannot send transactions on CSB, so they could never\n`
      + `co-sign anything. Add them first:\n`
      + blocked.map((o) => `  CSB_ALLOW=${o} npx hardhat run scripts/allow-dev.js --network csbRemote`).join("\n"));
  }

  // --- the four Safe contracts, reused if already deployed ------------------
  const existing = d.safe ?? {};
  const infra = {};
  bar("Safe infrastructure");
  for (const [name, rel] of Object.entries(ARTIFACTS)) {
    const prior = existing[name[0].toLowerCase() + name.slice(1)];
    if (prior && (await provider.getCode(prior)) !== "0x") {
      console.log(`  ${name.padEnd(30)} ${prior}  (already deployed)`);
      infra[name] = prior;
      continue;
    }
    const art = loadArtifact(rel);
    const f = new ethers.ContractFactory(art.abi, art.bytecode, signer);
    const c = await f.deploy();
    await c.waitForDeployment();
    infra[name] = await c.getAddress();
    console.log(`  ${name.padEnd(30)} ${infra[name]}`);
  }

  // --- the wallet itself ----------------------------------------------------
  bar("Creating the wallet");
  const singleton = new ethers.Contract(infra.SafeL2, loadArtifact(ARTIFACTS.SafeL2).abi, provider);
  // setup() runs once, inside the proxy's storage. Everything after the handler
  // is payment machinery for relayed deployment, which CSB does not use.
  const initializer = singleton.interface.encodeFunctionData("setup", [
    owners,
    threshold,
    ethers.ZeroAddress,               // no delegatecall on setup
    "0x",                             //   ...and no data for it
    infra.CompatibilityFallbackHandler,
    ethers.ZeroAddress,               // paymentToken
    0,                                // payment
    ethers.ZeroAddress,               // paymentReceiver
  ]);

  const factoryAbi = loadArtifact(ARTIFACTS.SafeProxyFactory).abi;
  const factory = new ethers.Contract(infra.SafeProxyFactory, factoryAbi, signer);
  const salt = BigInt(process.env.CSB_SAFE_SALT ?? 0);
  const rc = await (await factory.createProxyWithNonce(infra.SafeL2, initializer, salt)).wait();

  // Read the address from the event rather than computing it: the CREATE2 salt
  // is keccak(keccak(initializer), saltNonce), and recomputing it by hand is a
  // way to be confidently wrong about which contract was just created.
  let safeAddr = null;
  for (const log of rc.logs) {
    try {
      const p = factory.interface.parseLog(log);
      if (p?.name === "ProxyCreation") { safeAddr = p.args.proxy; break; }
    } catch (_) { /* not ours */ }
  }
  if (!safeAddr) throw new Error("No ProxyCreation event — the wallet address is unknown.");
  console.log(`  Safe  ${safeAddr}`);
  console.log(`  gas   ${rc.gasUsed}  (${ethers.formatEther(rc.gasUsed * rc.gasPrice)} tRIEL)`);

  // Ask the deployed wallet what it thinks, rather than trusting the arguments
  // that were sent. A setup that silently did nothing leaves a proxy with no
  // owners and no threshold, which is an unopenable safe.
  const safe = new ethers.Contract(safeAddr, loadArtifact(ARTIFACTS.SafeL2).abi, provider);
  const onChainOwners = await safe.getOwners();
  const onChainThreshold = Number(await safe.getThreshold());
  console.log(`  owners on chain    ${onChainOwners.length}`);
  console.log(`  threshold on chain ${onChainThreshold}`);
  if (onChainThreshold !== threshold || onChainOwners.length !== owners.length) {
    throw new Error("The deployed wallet does not match what was requested — do not use it.");
  }

  // --- make it able to hold the currency it governs ------------------------
  //
  // KHRStablecoin._update calls _requireEligible on both sides, which is
  //   if (!isSystemContract[a] && !identity.isActive(a)) revert NotKycActive(a);
  // so an unattested Safe cannot receive a single riel. There are two ways to
  // satisfy it and they are NOT equivalent: setSystemContract would also exempt
  // the wallet from the tier transfer cap and from the public-good levy, which
  // is right for a bridge and wrong for a governance wallet that should be as
  // constrained as everyone else. So it is attested, like any other holder.
  bar("Identity");
  const idAddr = d.contracts?.IdentityRegistry;
  if (process.env.CSB_SKIP_ATTEST === "1") {
    console.log(`  skipped (CSB_SKIP_ATTEST=1). The Safe cannot hold KHRt until attested.`);
  } else if (!idAddr) {
    console.log(`  no IdentityRegistry in deployments.json — skipped.`);
  } else {
    const id = new ethers.Contract(idAddr, IDENTITY_ABI, signer);
    if (await id.isActive(safeAddr).catch(() => false)) {
      console.log(`  already attested.`);
    } else {
      const issuer = await id.ISSUER_ROLE().catch(() => null);
      const may = issuer ? await id.hasRole(issuer, signer.address).catch(() => false) : false;
      if (!may) {
        console.log(`  ${signer.address} does not hold ISSUER_ROLE, so it cannot attest.`);
        console.log(`  The Identity Authority must register the wallet before it can hold KHRt:`);
        console.log(`    identity.register("${safeAddr}", <identity hash>, <tier>)`);
      } else {
        // Tier 3 is what the deployer process uses for vetted institutions; the
        // identity hash names what this is rather than pretending to be a person.
        const idHash = ethers.id(`csb:safe:${key}`);
        await (await id.register(safeAddr, idHash, 3)).wait();
        console.log(`  registered, tier 3, identity ${idHash}`);
        console.log(`  NOT marked a system contract — the levy and tier caps apply to it.`);
      }
    }
  }

  // --- record ---------------------------------------------------------------
  d.safe = {
    ...(d.safe ?? {}),
    safeL2: infra.SafeL2,
    safeProxyFactory: infra.SafeProxyFactory,
    compatibilityFallbackHandler: infra.CompatibilityFallbackHandler,
    multiSendCallOnly: infra.MultiSendCallOnly,
    version: "1.4.1",
    note: "Safe 1.4.1, unmodified from @safe-global/safe-contracts (LGPL-3.0). "
      + "SafeL2 rather than Safe so the Transaction Service could index CSB from "
      + "events — Subnet-EVM serves no Parity traces. Addresses are NOT Safe's "
      + "canonical ones; see scripts/deploy-safe.js.",
    wallets: {
      ...(d.safe?.wallets ?? {}),
      [key]: {
        address: safeAddr,
        owners,
        threshold,
        placeholder,
        ...(placeholder
          ? { placeholderReason: `${threshold}-of-${owners.length} — one key still decides` }
          : {}),
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  console.log(`\nRecorded as safe.wallets.${key} in ${path.basename(file)}.`);

  bar("Next");
  console.log(`Prove it works before it holds any power. It needs no tRIEL to do this:`);
  console.log(`the owner who submits pays the gas, and the wallet only needs a balance`);
  console.log(`if it is going to send value itself.`);
  console.log(`  CSB_SAFE=${key} npx hardhat run scripts/safe-exec.js --network csbRemote`);
  console.log(``);
  console.log(`Then move ONE role to it, ALONGSIDE the deployer rather than instead of it:`);
  console.log(`  grantRole(<ROLE>, "${safeAddr}")`);
  console.log(`Exercise the role through the Safe, and only then have the deployer`);
  console.log(`renounce its own copy. Leave the precompile admin until last —`);
  console.log(`a misconfigured wallet holding txAllowList admin ends the chain.`);
  console.log(`See docs/multisig.md.`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
