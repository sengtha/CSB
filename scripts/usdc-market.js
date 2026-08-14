const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deploy, at } = require("./lib/aave");

/**
 * SUPERSEDED — kept because it reproduces published findings, not because it
 * should be run again.
 *
 * The stand-in dollar this builds has an unguarded mint(), which is what made
 * every dollar figure on CSB arbitrary. Foreign currency is now ORIGINATED
 * against locked riel by contracts/currency/CurrencyVault.sol, and the site's
 * mint affordances for this token were removed on 2026-08-14. Nothing here was
 * deleted: the results in docs/defi.md and docs/oracle.md were measured with
 * exactly this script, and deleting it would leave those claims unreproducible.
 *
 * If you run it, you are creating a token anybody can mint without limit. Do not
 * add it to a lending market again.
 */
/**
 * Build a market around a bridged dollar, so the chain finally has TWO assets.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/usdc-market.js --network csbRemote
 *
 * Environment, all optional:
 *   CSB_BRIDGED_KEY   which entry in deployments.json `bridged` to use (default "usdc")
 *   CSB_USD_RATE      riel per dollar, for seeding and for the rate  (default 4000)
 *   CSB_SEED_USD      dollars of liquidity to seed the pool with     (default 1000)
 *   CSB_SKIP          comma-separated: pool,twap,rate,aave
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Until now every experiment on this chain
 * priced KHRt against itself or against a test token nobody trades. So Aave had one
 * reserve and "borrowing" meant depositing riel to borrow riel; the pool's ratio was
 * whatever it was seeded at; and the administered-versus-market divergence in
 * docs/oracle.md was two numbers we chose, subtracted. A dollar changes all three at
 * once, because a riel-dollar rate is the first quantity here with a genuinely
 * external answer.
 *
 * IDEMPOTENT PER MODULE, like scripts/experiments-live.js. Each block is skipped if
 * deployments.json already records it with code at that address, so a re-run after a
 * partial failure resumes rather than duplicating.
 *
 * WHAT IT GRANTS. The Uniswap pair is marked a KHRt system contract so it can custody
 * riel — the same discretionary grant the first pool and the Aave market needed. The
 * bridged token needs no such grant, because it is ungated (docs/architecture.md
 * §7.1) and enforces nothing against anybody.
 *
 * THE SEEDED RATE IS NOT A MEASUREMENT. Somebody has to put the first liquidity in,
 * and whatever ratio they choose IS the market price until someone trades against it.
 * The number only becomes evidence once a party with an independent view of the rate
 * arbitrages it. Until then, treat the TWAP here as instrumentation that works, not
 * as a finding.
 */

const FACTORY_ABI = [
  "function createPair(address,address) returns (address)",
  "function getPair(address,address) view returns (address)",
];
const PAIR_ABI = [
  "function mint(address) returns (uint256)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
  "function totalSupply() view returns (uint256)",
];
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];
const KHR_ABI = [
  ...ERC20_ABI,
  "function setSystemContract(address,bool)",
  "function isSystemContract(address) view returns (bool)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
];
const PROVIDER_ABI = ["function getPriceOracle() view returns (address)"];
const AAVE_ORACLE_ABI = [
  "function setAssetPrice(address,uint256)",
  "function getAssetPrice(address) view returns (uint256)",
];
const REF_ORACLE_ABI = [
  "function publish(address,uint256,bytes32)",
  "function describe(address) view returns (uint256,uint64,bytes32,bool)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function RATE_PUBLISHER_ROLE() view returns (bytes32)",
];

const RAY = 10n ** 27n;
const pct = (n) => BigInt(Math.round(n * 100));
const TWAP_MIN_WINDOW = 600;
const TWAP_MAX_AGE = 7 * 24 * 3600;

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const [signer] = await ethers.getSigners();

  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const save = () => fs.writeFileSync(file, JSON.stringify(d, null, 2));
  const live = async (a) => a && (await provider.getCode(a)).length > 2;

  const key = process.env.CSB_BRIDGED_KEY ?? "usdc";
  const b = d.bridged?.[key];
  if (!b?.address) {
    throw new Error(`No bridged.${key} in deployments.json. Run scripts/usdc-ingress.js `
      + `first — and docs/usdc-ingress.md before that.`);
  }
  if (!(await live(b.address))) throw new Error(`No contract at bridged.${key} (${b.address}).`);

  const khrAddr = d.contracts?.KHRStablecoin;
  if (!khrAddr) throw new Error("KHRStablecoin missing from deployments.json");
  const khr = new ethers.Contract(khrAddr, KHR_ABI, signer);
  const usd = new ethers.Contract(b.address, ERC20_ABI, signer);

  const khrDec = Number(await khr.decimals());
  const usdDec = Number(await usd.decimals());
  const rate = BigInt(process.env.CSB_USD_RATE ?? 4000);          // riel per dollar
  const seedUsd = BigInt(process.env.CSB_SEED_USD ?? 1000);

  const skip = (process.env.CSB_SKIP ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const skipped = (n) => {
    if (skip.includes(n)) { console.log(`\n[${n}] skipped via CSB_SKIP`); return true; }
    return false;
  };

  const before = await provider.getBalance(signer.address);
  console.log(`Chain    ${(await provider.getNetwork()).chainId}`);
  console.log(`Deployer ${signer.address}`);
  console.log(`KHRt     ${khrAddr} (${khrDec} dp)`);
  console.log(`${b.symbol.padEnd(8)} ${b.address} (${usdDec} dp)  [UNGATED — §7.1]`);
  console.log(`Rate     ${rate} riel per ${b.symbol}\n`);

  if (!(await khr.hasRole(await khr.DEFAULT_ADMIN_ROLE(), signer.address))) {
    throw new Error("Signer lacks KHRt DEFAULT_ADMIN_ROLE — cannot let a pool custody riel.");
  }

  // === 1. the pool =========================================================
  if (!skipped("pool")) {
    // "Done" means SEEDED, not merely created. Checking only for code here would
    // report success for a pair that exists and holds nothing — which is exactly the
    // state a run that ran short of tokens leaves behind, and a re-run would never
    // finish the job it was re-run to finish.
    const seededAlready = await (async () => {
      if (!(await live(d.usdMarket?.pair))) return false;
      const [r0, r1] = await new ethers.Contract(d.usdMarket.pair, PAIR_ABI, provider)
        .getReserves();
      return r0 > 0n && r1 > 0n;
    })();

    if (seededAlready) {
      console.log(`\n[pool] already seeded: ${d.usdMarket.pair}`);
    } else if (!d.defi?.factory) {
      console.log(`\n[pool] SKIPPED — no defi.factory in deployments.json. Run `
        + `scripts/defi-experiment.js first; this reuses that Uniswap factory.`);
    } else {
      console.log(`\n[pool] creating ${b.symbol}/KHRt on factory ${d.defi.factory}`);
      const factory = new ethers.Contract(d.defi.factory, FACTORY_ABI, signer);

      let pairAddr = await factory.getPair(khrAddr, b.address);
      if (pairAddr === ethers.ZeroAddress) {
        await (await factory.createPair(khrAddr, b.address)).wait();
        pairAddr = await factory.getPair(khrAddr, b.address);
      } else {
        console.log(`  a pair already existed at ${pairAddr} — reusing it`);
      }
      console.log(`  pair ${pairAddr}`);

      // createPair moves no tokens, so it needs no permission. Seeding it does.
      if (!(await khr.isSystemContract(pairAddr))) {
        await (await khr.setSystemContract(pairAddr, true)).wait();
        console.log(`  pair vetted as a KHRt system contract`);
      }

      const usdAmount = seedUsd * 10n ** BigInt(usdDec);
      const khrAmount = seedUsd * rate * 10n ** BigInt(khrDec);
      const [haveUsd, haveKhr] = await Promise.all([
        usd.balanceOf(signer.address), khr.balanceOf(signer.address),
      ]);

      if (haveUsd < usdAmount || haveKhr < khrAmount) {
        console.log(`\n  NOT SEEDED — insufficient balance.`);
        console.log(`    need ${ethers.formatUnits(usdAmount, usdDec)} ${b.symbol}, `
          + `have ${ethers.formatUnits(haveUsd, usdDec)}`);
        console.log(`    need ${ethers.formatUnits(khrAmount, khrDec)} KHRt, `
          + `have ${ethers.formatUnits(haveKhr, khrDec)}`);
        console.log(`  Bridge more dollars in, or lower CSB_SEED_USD. The pair exists`);
        console.log(`  and is recorded; re-run to seed it.`);
      } else {
        await (await usd.transfer(pairAddr, usdAmount)).wait();
        await (await khr.transfer(pairAddr, khrAmount)).wait();
        await (await new ethers.Contract(pairAddr, PAIR_ABI, signer)
          .mint(signer.address)).wait();
        console.log(`  seeded ${ethers.formatUnits(usdAmount, usdDec)} ${b.symbol} `
          + `against ${ethers.formatUnits(khrAmount, khrDec)} KHRt`);
        console.log(`  THE SEEDED RATIO IS THE PRICE until somebody trades against it.`);
      }

      d.usdMarket = {
        ...(d.usdMarket ?? {}),
        pair: pairAddr, khr: khrAddr, bridged: b.address, symbol: b.symbol,
        seededRielPerUnit: Number(rate),
        note: "KHRt against a bridged dollar. The seeded ratio is an assumption, not a "
          + "measurement — see the header of scripts/usdc-market.js.",
      };
      save();
    }
  }

  // === 2. a TWAP over it ===================================================
  if (!skipped("twap")) {
    if (await live(d.usdMarket?.twap)) {
      console.log(`\n[twap] already deployed: ${d.usdMarket.twap}`);
    } else if (!d.usdMarket?.pair) {
      console.log(`\n[twap] SKIPPED — no pool yet.`);
    } else {
      const [r0, r1] = await new ethers.Contract(d.usdMarket.pair, PAIR_ABI, provider).getReserves();
      if (r0 === 0n || r1 === 0n) {
        console.log(`\n[twap] SKIPPED — the pool holds no liquidity, so there is no price `
          + `to average. Seed it first.`);
      } else {
        console.log(`\n[twap] deploying over ${d.usdMarket.pair}`);
        const args = [d.usdMarket.pair, khrAddr, 10n ** 18n, TWAP_MIN_WINDOW, TWAP_MAX_AGE];
        const factory = await ethers.getContractFactory("UniswapV2TwapOracle");

        // A constructor revert arrives as a bare "transaction execution reverted",
        // which names neither the check that failed nor the argument that failed it.
        // Replay it as an eth_call first and decode the custom error against the ABI,
        // so the reason is reported instead of the symptom.
        const deployTx = await factory.getDeployTransaction(...args);
        try {
          await provider.call({ ...deployTx, from: signer.address });
        } catch (e) {
          console.log(`  CONSTRUCTOR REVERTED — the reason, decoded:`);
          // Revert data hides in different places depending on how the node reports
          // it, and only a hex string can be decoded. Taking e.data blindly prints
          // "[object Object]", which is worse than no decode at all.
          const hexData = [e.data, e.data?.data, e.info?.error?.data, e.error?.data]
            .find((v) => typeof v === "string" && v.startsWith("0x") && v !== "0x");
          let named = null;
          if (hexData) {
            try {
              const parsed = factory.interface.parseError(hexData);
              named = parsed ? `${parsed.name}(${parsed.args.join(", ")})` : null;
            } catch { /* not one of our errors */ }
            named ??= `undecodable revert data ${hexData}`;
          }
          console.log(`    ${named ?? (e.shortMessage ?? e.message)}`);
          console.log(`  Arguments passed:`);
          console.log(`    pair          ${args[0]}`);
          console.log(`    baseCurrency  ${args[1]}  (KHRt)`);
          console.log(`    baseUnit      ${args[2]}`);
          console.log(`    minWindow     ${args[3]}s   maxAge ${args[4]}s`);
          const pr = new ethers.Contract(args[0],
            [...PAIR_ABI, "function token1() view returns (address)"], provider);
          const [t0, t1] = await Promise.all([pr.token0(), pr.token1().catch(() => null)]);
          console.log(`  The pair's tokens:`);
          console.log(`    token0        ${t0}`);
          console.log(`    token1        ${t1}`);
          console.log(`  NotAPairToken means baseCurrency is neither of those.`);
          throw new Error("TWAP constructor reverted — see above. Pool and rate are unaffected.");
        }

        const twap = await ethers.deployContract("UniswapV2TwapOracle", args);
        await twap.waitForDeployment();
        d.usdMarket.twap = await twap.getAddress();
        save();
        console.log(`  ${d.usdMarket.twap}`);
        console.log(`  No average yet. After ${TWAP_MIN_WINDOW}s:`);
        console.log(`    CSB_TWAP=${d.usdMarket.twap} npx hardhat run scripts/twap-update.js --network csbRemote`);
      }
    }
  }

  // === 3. the administered rate, for the same asset =========================
  if (!skipped("rate")) {
    const refAddr = d.oracle?.referenceRate;
    if (!refAddr || !(await live(refAddr))) {
      console.log(`\n[rate] SKIPPED — no oracle.referenceRate. Run scripts/oracle-deploy.js.`);
    } else {
      const ref = new ethers.Contract(refAddr, REF_ORACLE_ABI, signer);
      const canPublish = await ref.hasRole(await ref.RATE_PUBLISHER_ROLE(), signer.address)
        .catch(() => false);
      if (!canPublish) {
        console.log(`\n[rate] SKIPPED — this signer does not hold RATE_PUBLISHER_ROLE.`);
        console.log(`  The publisher must call:`);
        console.log(`    oracle.publish("${b.address}", "${rate * 10n ** 18n}", <sourceRef>)`);
      } else {
        // Published in the oracle's base-currency unit: one whole dollar is worth
        // `rate` whole riel, expressed at 1e18 rather than KHRt's own scale.
        const price = rate * 10n ** 18n;
        const src = ethers.id(`seeded-parity-${b.symbol}-${rate}`);
        // Re-publishing the identical figure would only reset the timestamp, making a
        // stale rate look fresh without anybody having reviewed it. Skip it — but
        // republish if the rate has genuinely changed, which is the whole point of
        // running this again with a different CSB_USD_RATE.
        const [existing, publishedAt] = await ref.describe(b.address);
        if (existing === price) {
          console.log(`\n[rate] already published at ${rate} riel `
            + `(${new Date(Number(publishedAt) * 1000).toISOString()}) — not refreshing`);
          console.log(`  Re-stamping an unchanged figure would make a stale rate look`);
          console.log(`  reviewed. Publish a genuinely new number with CSB_USD_RATE.`);
        } else {
          console.log(`\n[rate] publishing ${rate} riel per ${b.symbol}`);
          console.log(`  sourceRef ${src}`);
          if (existing > 0n) {
            console.log(`  replacing ${ethers.formatUnits(existing, 18)} — the oracle will`);
            console.log(`  refuse this if it exceeds the configured deviation bound.`);
          } else {
            console.log(`  THIS IS THE SAME NUMBER THE POOL WAS SEEDED AT. Until an`);
            console.log(`  independent figure is published here, the divergence against`);
            console.log(`  the TWAP is zero BY CONSTRUCTION and measures nothing.`);
          }
          await (await ref.publish(b.address, price, src)).wait();
        }
        d.usdMarket = { ...(d.usdMarket ?? {}), administeredRate: price.toString() };
        save();
      }
    }
  }

  // === 4. list it as a second Aave reserve =================================
  if (!skipped("aave")) {
    const a = d.aave;
    if (!a?.poolConfigurator || !(await live(a.poolConfigurator))) {
      console.log(`\n[aave] SKIPPED — no live aave.poolConfigurator. Run scripts/aave-live.js.`);
    } else if (a.reserves?.[key] && await live(a.reserves[key].aToken)) {
      console.log(`\n[aave] ${b.symbol} already listed: aToken ${a.reserves[key].aToken}`);
    } else {
      console.log(`\n[aave] listing ${b.symbol} as a second reserve`);
      console.log(`  This is what makes borrowing mean something: today the market has`);
      console.log(`  one asset, so "borrow" means depositing riel to borrow riel.`);

      const pool = at("Pool", a.pool, signer);
      const configurator = at("PoolConfigurator", a.poolConfigurator, signer);

      // Fresh implementations rather than reusing the first reserve's proxies —
      // initReserves takes IMPLEMENTATIONS and clones them per reserve. Passing the
      // existing aToken proxy here would list a reserve backed by another reserve's
      // storage, which deploys cleanly and then misbehaves.
      const aTokenImpl = await deploy("AToken", [a.pool], signer);
      const sdtImpl = await deploy("StableDebtToken", [a.pool], signer);
      const vdtImpl = await deploy("VariableDebtToken", [a.pool], signer);
      const irs = await deploy("IRS", [
        a.addressesProvider,
        (RAY * 80n) / 100n, 0n, (RAY * 4n) / 100n, (RAY * 75n) / 100n,
        (RAY * 5n) / 100n, (RAY * 75n) / 100n, (RAY * 2n) / 100n,
        (RAY * 8n) / 100n, (RAY * 20n) / 100n,
      ], signer);

      // The oracle MUST price the asset before the reserve is usable, or every read
      // reverts. Which oracle is live depends on whether oracle-deploy.js was run
      // with CSB_WIRE_AAVE=1, so read it rather than assume.
      const oracleAddr = await new ethers.Contract(a.addressesProvider, PROVIDER_ABI, provider)
        .getPriceOracle();
      const price = rate * 10n ** 18n;
      const aaveOracle = new ethers.Contract(oracleAddr, AAVE_ORACLE_ABI, signer);
      let priced = false;
      try {
        await (await aaveOracle.setAssetPrice(b.address, price)).wait();
        priced = true;
        console.log(`  priced at ${rate} riel in Aave's test oracle ${oracleAddr}`);
      } catch {
        const current = await aaveOracle.getAssetPrice(b.address).catch(() => 0n);
        priced = current > 0n;
        console.log(`  oracle ${oracleAddr} has no setAssetPrice — it is the administered`);
        console.log(`  oracle. Price ${priced ? "already published" : "NOT PUBLISHED"}.`);
      }
      if (!priced) {
        console.log(`\n  REFUSING to list an asset the market cannot price — every read`);
        console.log(`  would revert. Publish a rate first (module "rate" above).`);
        return;
      }

      await (await configurator.initReserves([{
        aTokenImpl: await aTokenImpl.getAddress(),
        stableDebtTokenImpl: await sdtImpl.getAddress(),
        variableDebtTokenImpl: await vdtImpl.getAddress(),
        underlyingAssetDecimals: usdDec,
        interestRateStrategyAddress: await irs.getAddress(),
        underlyingAsset: b.address,
        treasury: signer.address,
        incentivesController: ethers.ZeroAddress,
        aTokenName: `Aave CSB ${b.symbol}`,
        aTokenSymbol: `a${b.symbol}`,
        variableDebtTokenName: `Aave CSB Variable Debt ${b.symbol}`,
        variableDebtTokenSymbol: `variableDebt${b.symbol}`,
        stableDebtTokenName: `Aave CSB Stable Debt ${b.symbol}`,
        stableDebtTokenSymbol: `stableDebt${b.symbol}`,
        params: "0x",
      }])).wait();

      await (await configurator.configureReserveAsCollateral(
        b.address, pct(75), pct(80), pct(105))).wait();
      await (await configurator.setReserveBorrowing(b.address, true)).wait();
      await (await configurator.setReserveActive(b.address, true)).wait();

      const rd = await pool.getReserveData(b.address);
      d.aave.reserves = {
        ...(d.aave.reserves ?? {}),
        [key]: {
          underlying: b.address,
          decimals: usdDec,
          aToken: rd.aTokenAddress,
          variableDebtToken: rd.variableDebtTokenAddress,
          stableDebtToken: rd.stableDebtTokenAddress,
          ltv: 75, liquidationThreshold: 80, liquidationBonus: 105,
        },
      };
      save();
      console.log(`  aToken           ${rd.aTokenAddress}`);
      console.log(`  variableDebt     ${rd.variableDebtTokenAddress}`);
      console.log(`  LTV 75% · liquidation threshold 80% · bonus 105%`);
      console.log(`\n  The market now has two assets, so liquidation can be demonstrated`);
      console.log(`  by MOVING A PRICE rather than by tightening the threshold.`);
    }
  }

  const spent = before - (await provider.getBalance(signer.address));
  console.log(`\n${"=".repeat(68)}`);
  console.log(`Cost: ${ethers.formatEther(spent)} tRIEL`);
  console.log(`Recorded in ${path.basename(file)}`);
  console.log(`\nREMEMBER what is and is not evidence here. The pool ratio and the`);
  console.log(`administered rate are both numbers we chose. The instrumentation is`);
  console.log(`real; the measurement starts when somebody trades against it.`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
