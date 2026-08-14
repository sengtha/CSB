const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Deploy TokenVote — the DAO application users run on CSB.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/deploy-tokenvote.js --network csbRemote
 *
 * ONE CONTRACT, EVERY DAO. A DAO here is a storage record, not a deployment, so
 * this is the only thing an operator ever has to deploy. After it exists, any
 * address on the txAllowList can create a DAO from the website in one ordinary
 * transaction — no deployer rights, no queue, no operator.
 *
 * That is the point of the design rather than a shortcut. Subnet-EVM checks
 * tx.origin against contractDeployerAllowList when a contract is created, so a
 * per-DAO Governor would need an operator for every single DAO and would cost
 * roughly 6M gas each against an 8M block. See contracts/governance/TokenVote.sol.
 *
 * IT MUST BE ABLE TO HOLD THE TOKENS IT ESCROWS. Voting locks tokens until the
 * proposal closes, and KHRt refuses to move to an address the identity registry
 * does not know. So this attests the contract, exactly as a Safe is attested —
 * deliberately NOT setSystemContract, which would also exempt it from the
 * transfer levy and the tier caps. A voting escrow should be as constrained as
 * the people using it.
 *
 * Environment, all optional:
 *   CSB_SKIP_ATTEST=1   deploy without registering it in the IdentityRegistry
 */

const IDENTITY_ABI = [
  "function register(address account, bytes32 identity, uint8 tier)",
  "function isActive(address) view returns (bool)",
  "function ISSUER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
];

const bar = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const [signer] = await ethers.getSigners();
  const net = await provider.getNetwork();

  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};

  bar(`TokenVote on chain ${net.chainId}`);

  // Idempotent: redeploying would strand every DAO and every escrowed token in
  // the old contract, with the site pointing at an empty new one.
  const prior = d.dao?.tokenVote;
  if (prior && (await provider.getCode(prior)) !== "0x") {
    console.log(`Already deployed at ${prior}.`);
    console.log(`Delete dao.tokenVote from ${path.basename(file)} to deploy another —`);
    console.log(`but every existing DAO, proposal and escrowed token stays in the old one.`);
    return;
  }

  const before = await provider.getBalance(signer.address);
  const c = await (await ethers.getContractFactory("TokenVote")).deploy();
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`  TokenVote  ${addr}`);

  // Recorded BEFORE the attestation, which can fail for reasons that have
  // nothing to do with the deployment. Doing it afterwards means a failed
  // attestation loses the address entirely and the next run deploys another,
  // leaking a contract per attempt — which is exactly what happened the first
  // time this was run twice.
  d.dao = { ...(d.dao ?? {}), tokenVote: addr,
    note: "Shared token-weighted voting. A DAO is a record in this contract, not a "
      + "deployment — see contracts/governance/TokenVote.sol." };
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  console.log(`  min voting period  ${Number(await c.MIN_VOTING_PERIOD()) / 60} minutes`);
  console.log(`  max choices        ${await c.MAX_CHOICES()}`);

  // --- let it hold what it escrows -----------------------------------------
  bar("Identity");
  const idAddr = d.contracts?.IdentityRegistry;
  if (process.env.CSB_SKIP_ATTEST === "1") {
    console.log(`  skipped. Votes weighted in KHRt will revert until it is attested.`);
  } else if (!idAddr) {
    console.log(`  no IdentityRegistry recorded — skipped.`);
  } else {
    const id = new ethers.Contract(idAddr, IDENTITY_ABI, signer);
    if (await id.isActive(addr).catch(() => false)) {
      console.log(`  already attested.`);
    } else {
      const role = await id.ISSUER_ROLE().catch(() => null);
      const may = role ? await id.hasRole(role, signer.address).catch(() => false) : false;
      if (!may) {
        console.log(`  ${signer.address} does not hold ISSUER_ROLE. The Identity Authority`);
        console.log(`  must register it before any KHRt-weighted vote can be cast:`);
        console.log(`    identity.register("${addr}", <identity hash>, 3)`);
      } else {
        // Salted with the address. A fixed commitment tries to attach a SECOND
        // address to an identity whose quota is one, and fails with
        // QuotaExceeded — so a redeploy could never be attested. The same trap
        // is documented on the KYC approval path in app/public/admin.html.
        await (await id.register(addr, ethers.id(`csb:tokenvote:${addr}`), 3)).wait();
        console.log(`  registered at tier 3 — it can now escrow KHRt.`);
        console.log(`  NOT a system contract: the levy and tier caps apply to it, as they`);
        console.log(`  do to the people voting.`);
      }
    }
  }

  const spent = before - (await provider.getBalance(signer.address));
  console.log(`\nRecorded as dao.tokenVote. Cost ${ethers.formatEther(spent)} tRIEL.`);

  bar("Next");
  console.log(`Restart the app server and open /dao.html. Anyone on the transaction`);
  console.log(`allow list can now create a DAO around any ERC-20 on this chain —`);
  console.log(`KHRt, a pool's LP token, a staking token — with no further deployment.`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
