const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Collect owner signatures and execute a transaction through a CSB Safe.
 *
 *   source ops/csb-env.sh
 *
 *   # 1. what needs signing (run by anyone; signs nothing)
 *   npx hardhat run scripts/safe-exec.js --network csbRemote
 *
 *   # 2. each owner signs the printed hash on their OWN machine, then:
 *   CSB_SAFE_SIGNATURES=0xsig1,0xsig2 \
 *     npx hardhat run scripts/safe-exec.js --network csbRemote
 *
 * WHY THIS EXISTS. Safe's web app has no entry for chain 8555 and never will
 * unless somebody adds it, and the Transaction Service is a Postgres, RabbitMQ
 * and indexer deployment for one wallet. Without something like this a Safe on
 * CSB can be created and then never used — which is worse than not deploying
 * one, because roles would be moved to a wallet nobody can operate.
 *
 * THE SIGNATURES NEVER HAVE TO MEET. Safe verifies a concatenation of ordinary
 * ECDSA signatures over an EIP-712 hash. Nothing about that requires the owners
 * to be in the same place, trust a server, or hand their keys to anything: each
 * signs the hash wherever their key lives and sends back 65 bytes. This script
 * is a courier for those bytes, not a custodian.
 *
 * Environment:
 *   CSB_SAFE             which wallet in deployments.json        (default "council")
 *   CSB_SAFE_TO          call target             (default: the Safe itself, a no-op)
 *   CSB_SAFE_VALUE       native tRIEL to send, in wei                    (default 0)
 *   CSB_SAFE_DATA        calldata                                     (default "0x")
 *   CSB_SAFE_SIGNATURES  comma-separated owner signatures, any order
 *   CSB_SAFE_OWNER_KEYS  comma-separated private keys — PROTOTYPE ONLY, see below
 */

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
];

// Safe's EIP-712 domain carries no name or version — only these two fields.
// Getting that wrong produces signatures that verify locally and are rejected
// on chain, so it is checked against the contract before anything is submitted.
const TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

const bar = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const [signer] = await ethers.getSigners();
  const net = await provider.getNetwork();

  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const name = process.env.CSB_SAFE ?? "council";
  const w = d.safe?.wallets?.[name];
  if (!w?.address) {
    throw new Error(`No safe.wallets.${name} in deployments.json — run scripts/deploy-safe.js first.`);
  }

  const safe = new ethers.Contract(w.address, SAFE_ABI, signer);
  const owners = (await safe.getOwners()).map((o) => o.toLowerCase());
  const threshold = Number(await safe.getThreshold());
  const nonce = await safe.nonce();

  // Defaulting to a self-call moving nothing makes the first run a rehearsal:
  // it exercises hashing, signing, ordering and execution without any way to
  // lose value if some part of it is wrong.
  const tx = {
    to: process.env.CSB_SAFE_TO ?? w.address,
    value: BigInt(process.env.CSB_SAFE_VALUE ?? 0),
    data: process.env.CSB_SAFE_DATA ?? "0x",
    operation: 0,          // CALL. delegatecall is deliberately not reachable here.
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,          // no refund machinery: the submitting owner pays gas
    gasToken: ethers.ZeroAddress,
    refundReceiver: ethers.ZeroAddress,
    nonce,
  };

  bar(`Safe "${name}" on chain ${net.chainId}`);
  console.log(`Address    ${w.address}`);
  console.log(`Threshold  ${threshold} of ${owners.length}`);
  console.log(`Nonce      ${nonce}`);
  console.log(`\nTransaction to authorise:`);
  console.log(`  to     ${tx.to}${tx.to.toLowerCase() === w.address.toLowerCase() ? "  (itself — a no-op rehearsal)" : ""}`);
  console.log(`  value  ${ethers.formatEther(tx.value)} tRIEL`);
  console.log(`  data   ${tx.data === "0x" ? "none" : tx.data}`);

  const domain = { chainId: net.chainId, verifyingContract: w.address };
  const local = ethers.TypedDataEncoder.hash(domain, TYPES, tx);
  const onChain = await safe.getTransactionHash(
    tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas,
    tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce);
  // If these disagree, every signature collected would be worthless. Better to
  // stop here than to send owners off to sign the wrong thing.
  if (local.toLowerCase() !== onChain.toLowerCase()) {
    throw new Error(`EIP-712 mismatch: computed ${local}, contract says ${onChain}.`);
  }
  console.log(`\nsafeTxHash ${onChain}`);
  console.log(`           (verified against the contract's own getTransactionHash)`);

  // --- gather signatures ----------------------------------------------------
  let sigs = (process.env.CSB_SAFE_SIGNATURES ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  if (!sigs.length && process.env.CSB_SAFE_OWNER_KEYS) {
    // Every key in one environment variable is one compromise away from being
    // the single key the multisig existed to eliminate. Fine for proving the
    // mechanism on a testnet; say so loudly rather than let it become habit.
    console.log(`\n  CSB_SAFE_OWNER_KEYS is set: signing locally with keys held in one place.`);
    console.log(`  That reproduces exactly the single point of failure a multisig removes.`);
    console.log(`  Acceptable to rehearse with. Not acceptable for a wallet holding a role.`);
    for (const k of process.env.CSB_SAFE_OWNER_KEYS.split(",").map((s) => s.trim()).filter(Boolean)) {
      sigs.push(await new ethers.Wallet(k).signTypedData(domain, TYPES, tx));
    }
  }

  if (!sigs.length) {
    bar("Nothing signed yet");
    console.log(`Send this to each owner. Any wallet that can sign EIP-712 typed data`);
    console.log(`will do; nothing needs to be installed and no key leaves their machine.`);
    console.log(`\n  domain  ${JSON.stringify(domain, (_, v) => typeof v === "bigint" ? v.toString() : v)}`);
    console.log(`  types   SafeTx(address to,uint256 value,bytes data,uint8 operation,`);
    console.log(`          uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,`);
    console.log(`          address refundReceiver,uint256 nonce)`);
    console.log(`  message ${JSON.stringify(tx, (_, v) => typeof v === "bigint" ? v.toString() : v, 2).replace(/\n/g, "\n          ")}`);
    console.log(`\nCollect ${threshold} signature(s), then:`);
    console.log(`  CSB_SAFE_SIGNATURES=0x...,0x... npx hardhat run scripts/safe-exec.js --network csbRemote`);
    return;
  }

  // --- validate and order ---------------------------------------------------
  //
  // Safe requires signatures concatenated in ASCENDING OWNER ADDRESS order and
  // rejects the lot otherwise, with an error that names neither the offending
  // signature nor the ordering rule. Sorting here means the owners can return
  // their signatures in any order, which is the only realistic assumption.
  const recovered = [];
  for (const sig of sigs) {
    let who;
    try { who = ethers.verifyTypedData(domain, TYPES, tx, sig); }
    catch (e) { throw new Error(`A signature could not be recovered: ${e.shortMessage ?? e.message}`); }
    if (!owners.includes(who.toLowerCase())) {
      throw new Error(`Signature recovers to ${who}, which is not an owner of this Safe.`);
    }
    if (recovered.some((r) => r.who.toLowerCase() === who.toLowerCase())) {
      throw new Error(`${who} signed twice — Safe counts distinct owners, so this would not reach the threshold.`);
    }
    recovered.push({ who, sig });
  }
  recovered.sort((a, b) => (a.who.toLowerCase() < b.who.toLowerCase() ? -1 : 1));

  bar(`Signatures (${recovered.length} of ${threshold} required)`);
  for (const r of recovered) console.log(`  ${r.who}`);
  if (recovered.length < threshold) {
    console.log(`\nNot enough yet — ${threshold - recovered.length} more needed.`);
    return;
  }

  const packed = "0x" + recovered.map((r) => r.sig.slice(2)).join("");

  // --- execute --------------------------------------------------------------
  bar("Executing");
  console.log(`Submitted by ${signer.address} (pays the gas; does not need to be an owner)`);
  const rc = await (await safe.execTransaction(
    tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas,
    tx.gasPrice, tx.gasToken, tx.refundReceiver, packed)).wait();

  // A Safe reports a failed inner call by emitting ExecutionFailure rather than
  // reverting, so a green receipt does not mean the transaction did what it said.
  const failed = rc.logs.some((l) => l.topics[0]
    === hre.ethers.id("ExecutionFailure(bytes32,uint256)"));
  console.log(`  block ${rc.blockNumber}  gas ${rc.gasUsed}`);
  if (failed) {
    console.log(`\n  ExecutionFailure: the owners' authorisation was valid and the inner`);
    console.log(`  call reverted. The nonce has still advanced, so re-signing is required.`);
    process.exitCode = 1;
  } else {
    console.log(`  nonce is now ${await safe.nonce()}`);
    console.log(`\nThe wallet works. It can now be given a role — one, alongside the`);
    console.log(`deployer, exercised, and only then the deployer's copy renounced.`);
  }
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
