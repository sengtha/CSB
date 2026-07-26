const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { enableTransactor, explain } = require("./lib/csb-precompiles");

/**
 * License a field verifier, and make sure they can actually act.
 *
 * A verifier has to pass THREE independent gates before a confirmation counts,
 * and they fail in ways that look nothing alike:
 *
 *   licence      AttesterRegistry — refused with NotLicensedAttester
 *   KYC          IdentityRegistry — refused with NotVerifiedIdentity
 *   txAllowList  the chain itself — the transaction is rejected before any
 *                contract runs, so the provider reports a bare "execution
 *                reverted" with no data to decode
 *
 * Handing someone a licence and stopping there produces an officer who is
 * licensed on paper and cannot attest to anything, which is the worst of the
 * three to debug. So this checks all three and reports each one.
 *
 *   source ops/csb-env.sh
 *   ATTESTER_ADDR=0x… ATTESTER_CLASSES=commune \
 *   ATTESTER_LABEL="Commune agriculture officer, Sangkat Example" \
 *     npx hardhat run scripts/license-attester.js --network csbRemote
 *
 * Env:
 *   ATTESTER_ADDR        required — the verifier's address
 *   ATTESTER_CLASSES     names or a number: "commune", "agronomist,auditor", 2
 *   ATTESTER_LABEL       public label. A ROLE, not a person's name — this is a
 *                        ledger a whole country can read.
 *   ATTESTER_LICENCE_REF off-chain licence reference (hashed); defaults to one
 *                        derived from the address
 *   ATTESTER_TIER        KYC tier to register with if unregistered (default 2)
 *   ATTESTER_NO_KYC=1    do not register KYC even if missing — for when the
 *                        Identity Authority is a different institution, which is
 *                        the correct arrangement outside a pilot
 *
 * Idempotent: re-licensing an existing verifier updates their classes and label.
 * To withdraw a licence use setSuspended(addr, true) — never removeAttester for
 * a routine suspension, because the record of who was licensed WHEN is what a
 * dispute over a past attestation has to be settled against.
 *
 * PLACEHOLDER: "licensing registrar" is a hypothetical role on a test network.
 */
const CLASS_BITS = {
  agronomist: 1 << 0,
  commune: 1 << 1,
  school: 1 << 2,
  cooperative: 1 << 3,
  ngo: 1 << 4,
  auditor: 1 << 5,
};

async function main() {
  const { ethers } = hre;
  const file = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!d.contracts?.AttesterRegistry) {
    throw new Error("AttesterRegistry is not deployed — run scripts/deploy-grove.js first");
  }

  const who = process.env.ATTESTER_ADDR;
  if (!who || !ethers.isAddress(who)) {
    throw new Error("set ATTESTER_ADDR to the verifier's address");
  }
  const classes = parseClasses(process.env.ATTESTER_CLASSES ?? "commune");
  const label = process.env.ATTESTER_LABEL ?? "Field verifier (illustrative)";
  const licenceRef = process.env.ATTESTER_LICENCE_REF
    ? ethers.id(process.env.ATTESTER_LICENCE_REF)
    : ethers.id(`licence/field-verifier/${who.toLowerCase()}`);

  const [signer] = await ethers.getSigners();
  const attesters = await ethers.getContractAt("AttesterRegistry", d.contracts.AttesterRegistry);
  const identity = await ethers.getContractAt("IdentityRegistry", d.contracts.IdentityRegistry);
  const enforcement = await ethers.getContractAt("EnforcementRegistry", d.contracts.EnforcementRegistry);

  console.log(`Registrar: ${signer.address}`);
  console.log(`Verifier:  ${who}`);
  console.log(`Classes:   ${nameClasses(classes)} (${classes})`);
  console.log(`Label:     ${label}\n`);

  // --- 1. the licence -----------------------------------------------------
  const REGISTRAR = await attesters.REGISTRAR_ROLE();
  if (!(await attesters.hasRole(REGISTRAR, signer.address))) {
    console.log(`! This key does not hold REGISTRAR_ROLE on AttesterRegistry.`);
    console.log(`  The licensing registrar must call:`);
    console.log(`    licenseAttester(${who}, ${classes}, ${licenceRef}, "${label}")`);
    process.exitCode = 1;
    return;
  }
  const existing = await attesters.attesterOf(who);
  await (await attesters.licenseAttester(who, classes, licenceRef, label)).wait();
  console.log(existing.registeredAt === 0n ? "✓ licensed" : "✓ licence updated");

  // --- 2. KYC -------------------------------------------------------------
  // A licence says what someone is qualified to do. KYC says the chain knows
  // who they are. GroveAnchor requires both, checked at the moment of
  // attesting, so a licence issued to an unregistered address is inert.
  if (await identity.isActive(who)) {
    console.log(`✓ KYC active (tier ${await identity.tierOf(who)})`);
  } else if (process.env.ATTESTER_NO_KYC === "1") {
    console.log(`! No active KYC attestation, and ATTESTER_NO_KYC=1.`);
    console.log(`  The Identity Authority must register ${who} before they can attest.`);
  } else {
    const ISSUER = await identity.ISSUER_ROLE();
    if (await identity.hasRole(ISSUER, signer.address)) {
      const tier = Number(process.env.ATTESTER_TIER ?? 2);
      await (await identity.register(who, ethers.id(`grove-attester-${who.toLowerCase()}`), tier)).wait();
      console.log(`✓ registered KYC (tier ${tier})`);
    } else {
      console.log(`! No active KYC, and this key is not the Identity Authority issuer.`);
      console.log(`  Ask them to register ${who} — the licence is inert until they do.`);
    }
  }

  // --- 3. the chain-level gate -------------------------------------------
  // Below the contract layer: an address not on the txAllowList cannot send ANY
  // transaction, however well licensed and KYC'd. It fails with no reason
  // string, which looks nothing like a permissions problem.
  await enableTransactor(ethers, signer, who, "verifier");

  // --- report -------------------------------------------------------------
  console.log("");
  if (await enforcement.isFrozen(who)) {
    console.log(`! ${who} is frozen by an enforcement order — attestations will be refused.`);
  }
  const licensed = await attesters.isLicensed(who);
  const kyc = await identity.isActive(who);
  console.log(`licensed ${licensed} · KYC ${kyc} · ready to attest: ${licensed && kyc}`);

  if (d.contracts.GroveAnchor) {
    const anchor = await ethers.getContractAt("GroveAnchor", d.contracts.GroveAnchor);
    console.log(`\nGroveAnchor requires ${await anchor.requiredConfirmations()} licensed confirmation(s).`);
    console.log(`Confirm a record with:  attest(<observationId>, true, <noteRef>)`);
    console.log(`Check before signing:   canAttest(${who}, <observationId>)`);
  }
}

/** "commune" | "commune,auditor" | "2" → bitmask. */
function parseClasses(input) {
  const raw = String(input).trim();
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n > 0) return n;
    throw new Error("ATTESTER_CLASSES must be non-zero");
  }
  let mask = 0;
  for (const part of raw.split(/[,\s|]+/).filter(Boolean)) {
    const bit = CLASS_BITS[part.toLowerCase()];
    if (!bit) throw new Error(`unknown class "${part}" — one of ${Object.keys(CLASS_BITS).join(", ")}`);
    mask |= bit;
  }
  if (!mask) throw new Error("ATTESTER_CLASSES resolved to nothing");
  return mask;
}

const nameClasses = (mask) =>
  Object.entries(CLASS_BITS).filter(([, b]) => (mask & b) !== 0).map(([n]) => n).join(", ") || "none";

main().catch((e) => {
  console.error("\nFailed:", explain(e));
  process.exitCode = 1;
});
