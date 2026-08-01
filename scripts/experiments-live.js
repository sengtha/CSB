const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Deploy the remaining experiments on the live chain.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/experiments-live.js --network csbRemote
 *
 * Covers the four modules that had no live script: the two ERC-4626 vaults, the
 * market-derived TWAP oracle, and two Synthetix staking pools. Uniswap
 * (defi-experiment.js), Aave (aave-live.js) and the administered oracle
 * (oracle-deploy.js) already have their own.
 *
 * IDEMPOTENT PER MODULE. Each block is skipped if `deployments.json` already records
 * it with code at that address, so a re-run after a partial failure resumes rather
 * than duplicating. Skip a module deliberately with, e.g., CSB_SKIP=staking,twap.
 *
 * WHAT IT GRANTS, because these are real privileges on a live chain. Three contracts
 * are marked KHRt SYSTEM CONTRACTS — both vaults and the KHRt-reward staking pool —
 * which lets them custody KHRt without holding a KYC attestation. That is the same
 * power the bridge adapter and the Aave pool have. Every granted address is printed
 * with its revoke command at the end.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not point Aave at the TWAP oracle. A
 * TWAP costs as much to manipulate as the liquidity behind it and the CSB pool is
 * small, so it is a measurement instrument on this chain and not a valuation source
 * (docs/oracle.md). Wiring a lending market to it would be a mistake this script
 * will not make for you.
 */

const ERC20_ART = require("@uniswap/v2-core/build/ERC20.json");
const hex = (b) => (b.startsWith("0x") ? b : "0x" + b);

const TWAP_MIN_WINDOW = 600;            // 10 minutes
const TWAP_MAX_AGE = 7 * 24 * 3600;     // a week, generous for a testnet

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const [signer] = await ethers.getSigners();
  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  const khrAddr = d.contracts?.KHRStablecoin;
  const identityAddr = d.contracts?.IdentityRegistry;
  const enforcementAddr = d.contracts?.EnforcementRegistry;
  if (!khrAddr) throw new Error("KHRStablecoin missing from deployments.json");

  const skip = (process.env.CSB_SKIP ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const skipped = (name) => {
    if (skip.includes(name)) { console.log(`\n[${name}] skipped via CSB_SKIP`); return true; }
    return false;
  };

  const khr = new ethers.Contract(khrAddr, [
    "function decimals() view returns (uint8)",
    "function setSystemContract(address,bool)",
    "function isSystemContract(address) view returns (bool)",
    "function transfer(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  ], signer);

  if (!(await khr.hasRole(await khr.DEFAULT_ADMIN_ROLE(), signer.address))) {
    throw new Error("Signer lacks KHRt DEFAULT_ADMIN_ROLE — it could deploy these "
      + "contracts but not let them custody KHRt, leaving them unusable.");
  }

  const before = await provider.getBalance(signer.address);
  const dec = Number(await khr.decimals());
  console.log(`Chain    ${(await provider.getNetwork()).chainId}`);
  console.log(`Deployer ${signer.address}`);
  console.log(`Balance  ${ethers.formatEther(before)} tRIEL`);
  console.log(`KHRt     ${khrAddr} (${dec} decimals)\n`);

  const granted = [];
  const vet = async (label, addr) => {
    if (await khr.isSystemContract(addr)) {
      console.log(`  ${label} already vetted`);
    } else {
      await (await khr.setSystemContract(addr, true)).wait();
      console.log(`  ${label} vetted as a KHRt system contract`);
    }
    granted.push([label, addr]);
  };
  const live = async (addr) => addr && (await provider.getCode(addr)).length > 2;
  const save = () => fs.writeFileSync(file, JSON.stringify(d, null, 2));

  // === 1. the two vaults ===================================================
  if (!skipped("vaults")) {
    if (await live(d.vaults?.plain) && await live(d.vaults?.compliant)) {
      console.log(`\n[vaults] already deployed:`);
      for (const [k, v] of Object.entries(d.vaults)) console.log(`  ${k.padEnd(12)} ${v}`);
    } else if (!identityAddr || !enforcementAddr) {
      console.log(`\n[vaults] SKIPPED — IdentityRegistry/EnforcementRegistry missing from `
        + `deployments.json, and the compliant vault needs both.`);
    } else {
      console.log(`\n[vaults] deploying`);
      const plain = await ethers.deployContract("KHRtVault", [
        khrAddr, "CSB KHRt Vault", "vKHRt",
      ]);
      await plain.waitForDeployment();
      const compliant = await ethers.deployContract("CompliantKHRtVault", [
        khrAddr, "CSB KHRt Vault (compliant)", "cvKHRt",
        identityAddr, enforcementAddr, signer.address,
      ]);
      await compliant.waitForDeployment();

      const plainAddr = await plain.getAddress();
      const compliantAddr = await compliant.getAddress();
      console.log(`  plain     ${plainAddr}`);
      console.log(`  compliant ${compliantAddr}`);
      await vet("plain vault", plainAddr);
      await vet("compliant vault", compliantAddr);

      d.vaults = {
        plain: plainAddr,
        compliant: compliantAddr,
        underlying: khrAddr,
        decimals: dec,
        note: "ERC-4626 over KHRt. `plain` adds nothing to OpenZeppelin; `compliant` "
          + "adds one hook gating the SHARE. The pair is a controlled comparison — "
          + "see docs/defi.md.",
      };
      save();
    }
  }

  // === 2. the TWAP oracle, over the existing Uniswap pool ==================
  if (!skipped("twap")) {
    if (await live(d.oracle?.twap)) {
      console.log(`\n[twap] already deployed: ${d.oracle.twap}`);
    } else if (!d.defi?.pair) {
      console.log(`\n[twap] SKIPPED — no defi.pair in deployments.json. Run `
        + `scripts/defi-experiment.js first; the TWAP reads that pool.`);
    } else {
      console.log(`\n[twap] deploying against pool ${d.defi.pair}`);
      const twap = await ethers.deployContract("UniswapV2TwapOracle", [
        d.defi.pair, khrAddr, 10n ** 18n, TWAP_MIN_WINDOW, TWAP_MAX_AGE,
      ]);
      await twap.waitForDeployment();
      const twapAddr = await twap.getAddress();
      console.log(`  ${twapAddr}`);
      console.log(`  NOT wired into Aave, deliberately — this pool is too small to `
        + `price a lending market safely.`);
      console.log(`  It has no average yet. Call update() after ${TWAP_MIN_WINDOW}s, `
        + `then again periodically.`);

      d.oracle = { ...(d.oracle ?? {}), twap: twapAddr, twapPair: d.defi.pair,
        twapMinWindow: TWAP_MIN_WINDOW, twapMaxAge: TWAP_MAX_AGE,
        twapNote: "Market rate from the chain's own pool. Measurement instrument, "
          + "NOT a valuation source — see docs/oracle.md." };
      save();
    }
  }

  // === 3. staking, in both configurations ==================================
  if (!skipped("staking")) {
    if (await live(d.staking?.ungatedPool) && await live(d.staking?.gatedPool)) {
      console.log(`\n[staking] already deployed:`);
      for (const [k, v] of Object.entries(d.staking)) console.log(`  ${k.padEnd(14)} ${v}`);
    } else {
      console.log(`\n[staking] deploying`);

      // Fresh plain tokens rather than reusing the Uniswap test token, so the
      // deployer's balance is known rather than assumed.
      const mk = async (label) => {
        const t = await new ethers.ContractFactory(
          ERC20_ART.abi, hex(ERC20_ART.bytecode), signer
        ).deploy(ethers.parseUnits("1000000", 18));
        await t.waitForDeployment();
        const a = await t.getAddress();
        console.log(`  ${label.padEnd(14)} ${a}`);
        return { t, a };
      };
      const stakeTok = await mk("stake token");
      const rewardTok = await mk("reward token");

      // (a) ungated reward — an unattested staker can collect real spendable value.
      const ungated = await ethers.deployContract("StakingRewards", [
        signer.address, signer.address, rewardTok.a, stakeTok.a,
      ]);
      await ungated.waitForDeployment();
      const ungatedAddr = await ungated.getAddress();
      console.log(`  ungated pool   ${ungatedAddr}`);
      const rewardAmount = ethers.parseUnits("70000", 18);
      await (await rewardTok.t.transfer(ungatedAddr, rewardAmount)).wait();
      await (await ungated.notifyRewardAmount(rewardAmount)).wait();

      // (b) gated reward — rewards accrue to an unattested staker and can never be
      //     collected. The stranded-liability finding.
      const gated = await ethers.deployContract("StakingRewards", [
        signer.address, signer.address, khrAddr, stakeTok.a,
      ]);
      await gated.waitForDeployment();
      const gatedAddr = await gated.getAddress();
      console.log(`  gated pool     ${gatedAddr}`);
      await vet("gated staking pool", gatedAddr);

      const khrReward = 100_000n * BigInt(10 ** dec);
      const bal = await khr.balanceOf(signer.address);
      if (bal < khrReward) {
        console.log(`  WARNING: deployer holds ${ethers.formatUnits(bal, dec)} KHRt, `
          + `less than the ${ethers.formatUnits(khrReward, dec)} reward. Funding skipped;`);
        console.log(`  transfer KHRt to ${gatedAddr} and call notifyRewardAmount yourself.`);
      } else {
        await (await khr.transfer(gatedAddr, khrReward)).wait();
        await (await gated.notifyRewardAmount(khrReward)).wait();
        console.log(`  funded gated pool with ${ethers.formatUnits(khrReward, dec)} KHRt`);
      }

      d.staking = {
        stakeToken: stakeTok.a,
        rewardToken: rewardTok.a,
        ungatedPool: ungatedAddr,
        gatedPool: gatedAddr,
        note: "Unmodified Synthetix StakingRewards. The ungated pool leaks spendable "
          + "value to an unattested staker; the gated pool accrues rewards it can "
          + "never pay. See docs/defi.md.",
      };
      save();
    }
  }

  // === summary =============================================================
  const spent = before - (await provider.getBalance(signer.address));
  console.log(`\n${"=".repeat(66)}`);
  console.log(`Total cost: ${ethers.formatEther(spent)} tRIEL`);
  console.log(`Recorded in ${path.basename(file)}`);

  if (granted.length) {
    console.log(`\nKHRt SYSTEM-CONTRACT GRANTS MADE. Each of these can now custody KHRt`);
    console.log(`without a KYC attestation. Revoke when the demonstration is done:`);
    for (const [label, addr] of granted) {
      console.log(`  khr.setSystemContract("${addr}", false)   // ${label}`);
    }
  }

  if (d.oracle?.twap) {
    console.log(`\nThe TWAP needs feeding. After ${TWAP_MIN_WINDOW}s:`);
    console.log(`  CSB_TWAP=${d.oracle.twap} npx hardhat run scripts/twap-update.js --network csbRemote`);
  }
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
