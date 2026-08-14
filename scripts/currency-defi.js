const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deploy, at } = require("./lib/aave");

/**
 * Put the CSB-issued currencies into the DeFi that already exists here.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/currency-defi.js --network csbRemote
 *
 * For each synthetic currency: a Uniswap V2 pair against KHRt, seeded from a
 * position this script opens in the vault, and an Aave reserve so it can be
 * supplied and borrowed. Idempotent per currency and per module — a second run
 * finishes what a first run ran short of tokens for and touches nothing else.
 *
 * THE INTERESTING PART IS THE ATTESTATION, NOT THE PLUMBING.
 *
 * khUSD checks the identity registry on every transfer, exactly as KHRt does. So
 * a Uniswap pair cannot hold it, and an Aave aToken cannot hold it, until the
 * Identity Authority attests THE CONTRACT. That is the composability cost
 * docs/defi.md measured on the ERC-4626 control, arriving as an operational step:
 * every venue that will ever custody a CSB-issued currency has to be named, one
 * at a time, by a human with ISSUER_ROLE. An ungated token needs none of this,
 * which is precisely why an ungated token cannot be governed.
 *
 * It is also where the gate quietly does its job. The pair address is attested;
 * the LP token minted against it is not, and cannot be — it is Uniswap's contract.
 * So the same leak this project has documented four times over is still here, one
 * layer up, and listing these currencies does not close it.
 *
 * WHY THEY ARE NOT COLLATERAL IN AAVE BY DEFAULT.
 *
 * khUSD is already a claim created against locked riel. Accepting it as Aave
 * collateral to borrow KHRt closes a loop: lock riel, mint khUSD, post it, borrow
 * riel, lock that too. Each turn is bounded by the vault's 150% ratio and its debt
 * ceiling, so this is not unbounded — but it is leverage assembled out of two
 * mechanisms neither of which can see the other, which is how these things break.
 * Listed borrowable with LTV 0: you may borrow dollars against your riel, which is
 * the useful direction, and not the reverse. Set CSB_SYNTH_LTV to enable it.
 *
 * Environment, all optional:
 *   CSB_CURRENCIES=khUSD,khJPY   subset to wire up (default: all in the vault)
 *   CSB_SKIP=pool,aave           modules to leave alone
 *   CSB_SYNTH_LTV=50             list synths as collateral at this LTV (default 0)
 *   CSB_SEED_RIEL=200000         riel of depth per side of each pool
 *   CSB_SEED_RATIO=200           collateral ratio, in percent, for the seed position
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
  "function approve(address,uint256) returns (bool)",
];
const KHR_ABI = [
  ...ERC20_ABI,
  "function setSystemContract(address,bool)",
  "function isSystemContract(address) view returns (bool)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
];
const IDENTITY_ABI = [
  "function register(address account, bytes32 identity, uint8 tier)",
  "function isActive(address) view returns (bool)",
  "function ISSUER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
];
const VAULT_ABI = [
  "function currencyCount() view returns (uint256)",
  "function currencyAt(uint256) view returns (tuple(address synth, uint8 synthDecimals, uint16 minRatioBps, uint16 liqThresholdBps, uint16 liqPenaltyBps, uint256 debtCeiling, uint256 totalDebt, bool mintingPaused))",
  "function positionOf(uint256,address) view returns (tuple(uint256 collateral, uint256 debt))",
  "function rielValueOf(uint256,uint256) view returns (uint256)",
  "function deposit(uint256,uint256)",
  "function mint(uint256,uint256)",
];
const PROVIDER_ABI = ["function getPriceOracle() view returns (address)"];
const AAVE_ORACLE_ABI = [
  "function setAssetPrice(address,uint256)",
  "function getAssetPrice(address) view returns (uint256)",
];

const RAY = 10n ** 27n;
const pctBps = (n) => BigInt(Math.round(n * 100));
const bar = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const [signer] = await ethers.getSigners();

  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const save = () => fs.writeFileSync(file, JSON.stringify(d, null, 2));
  const live = async (a) => a && (await provider.getCode(a)).length > 2;

  const skip = (process.env.CSB_SKIP ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const skipped = (n) => {
    if (skip.includes(n)) { console.log(`\n[${n}] skipped via CSB_SKIP`); return true; }
    return false;
  };

  const vaultAddr = d.currency?.vault;
  if (!(await live(vaultAddr))) {
    throw new Error("No live currency.vault in deployments.json — run scripts/deploy-currency-vault.js first.");
  }
  const khrAddr = d.contracts?.KHRStablecoin;
  const idAddr = d.contracts?.IdentityRegistry;
  if (!khrAddr || !idAddr) throw new Error("KHRStablecoin or IdentityRegistry missing from deployments.json.");

  const vault = new ethers.Contract(vaultAddr, VAULT_ABI, signer);
  const khr = new ethers.Contract(khrAddr, KHR_ABI, signer);
  const identity = new ethers.Contract(idAddr, IDENTITY_ABI, signer);
  const khrDec = Number(await khr.decimals());

  bar(`Currency DeFi on chain ${(await provider.getNetwork()).chainId}`);
  console.log(`Deployer ${signer.address}`);
  console.log(`Vault    ${vaultAddr}`);

  const isAdmin = await khr.hasRole(await khr.DEFAULT_ADMIN_ROLE(), signer.address);
  const issuerRole = await identity.ISSUER_ROLE();
  const isIssuer = await identity.hasRole(issuerRole, signer.address);
  if (!isIssuer) {
    // Refused up front rather than three deployments in: without it the pair and
    // the aToken cannot be attested, so every venue built here would exist and
    // reject the first transfer into it.
    throw new Error(
      "This signer does not hold ISSUER_ROLE on the IdentityRegistry. Every venue that "
      + "custodies a CSB-issued currency has to be attested, so nothing built here would "
      + "work. Have the Identity Authority run it, or register the addresses by hand.");
  }
  if (!isAdmin) {
    console.log(`\nNOTE: no KHRt DEFAULT_ADMIN_ROLE — pools cannot be vetted as KHRt system`);
    console.log(`contracts, so the KHRt leg of each pool will pay the transfer levy.`);
  }

  /** Attest an address so it may hold a gated token. Idempotent. */
  async function attest(addr, what) {
    if (await identity.isActive(addr).catch(() => false)) {
      console.log(`    ${what} already attested`);
      return;
    }
    // Salted by address: a fixed commitment can only ever carry one address, and
    // the second registration fails with QuotaExceeded.
    await (await identity.register(addr, ethers.id(`csb:venue:${addr}`), 3)).wait();
    console.log(`    ${what} attested at tier 3 — it may now hold CSB-issued currency`);
  }

  /*
   * THE DEPLOYER NEEDS ONE TOO, and this is the least obvious step in the script.
   *
   * KHRt exempts system contracts from its checks, and the deployer has moved KHRt
   * before, so it is easy to assume it can hold anything here. A SyntheticCurrency
   * has no system-contract concept at all — its only gate is `identity.isActive`,
   * applied to issuance as well as transfer. So an unattested deployer cannot
   * receive the synth it mints, and the run would fail at `vault.mint` with
   * NotKycActive naming the operator's own address.
   *
   * Attesting it is a real act: the chain's root key acquires a KYC identity. It
   * is done because seeding a pool with a gated currency is impossible without it,
   * and it is logged rather than done quietly.
   */
  if (!(await identity.isActive(signer.address))) {
    console.log(`\nThe deployer holds no KYC attestation, and a CSB-issued currency cannot`);
    console.log(`be minted to an address without one. Registering ${signer.address}`);
    console.log(`at tier 3 — note that this gives the chain's root key an identity.`);
    await (await identity.register(
      signer.address, ethers.id(`csb:operator:${signer.address}`), 3)).wait();
    console.log(`  done.`);
  }

  // --- which currencies -----------------------------------------------------
  const want = process.env.CSB_CURRENCIES
    ? process.env.CSB_CURRENCIES.split(",").map((s) => s.trim())
    : null;

  const n = await vault.currencyCount();
  const list = [];
  for (let i = 0n; i < n; i++) {
    const c = await vault.currencyAt(i);
    const t = new ethers.Contract(c.synth, ERC20_ABI, provider);
    const symbol = await t.symbol();
    if (want && !want.includes(symbol)) continue;
    list.push({ id: i, symbol, addr: c.synth, decimals: Number(c.synthDecimals), cfg: c });
  }
  if (!list.length) throw new Error("No matching currencies in the vault.");
  console.log(`Currencies ${list.map((x) => x.symbol).join(", ")}`);

  const seedRiel = BigInt(process.env.CSB_SEED_RIEL ?? 200_000);      // whole riel per side
  const seedRatioPct = BigInt(process.env.CSB_SEED_RATIO ?? 200);
  const synthLtv = Number(process.env.CSB_SYNTH_LTV ?? 0);
  const before = await provider.getBalance(signer.address);

  d.currency.synths = d.currency.synths ?? {};
  const record = (sym, patch) => {
    const cur = d.currency.synths[sym] ?? {};
    d.currency.synths[sym] = { ...cur, ...patch };
    save();
  };

  // =========================================================== 1. the pools
  if (!skipped("pool")) {
    bar("Uniswap pools");
    if (!d.defi?.factory || !(await live(d.defi.factory))) {
      console.log(`SKIPPED — no live defi.factory. Run scripts/defi-experiment.js first;`);
      console.log(`this reuses that Uniswap factory rather than deploying a second one.`);
    } else {
      const factory = new ethers.Contract(d.defi.factory, FACTORY_ABI, signer);
      for (const c of list) {
        console.log(`\n  ${c.symbol}`);

        let pairAddr = await factory.getPair(khrAddr, c.addr);
        if (pairAddr === ethers.ZeroAddress) {
          await (await factory.createPair(khrAddr, c.addr)).wait();
          pairAddr = await factory.getPair(khrAddr, c.addr);
          console.log(`    pair created ${pairAddr}`);
        } else {
          console.log(`    pair exists  ${pairAddr}`);
        }
        record(c.symbol, { pair: pairAddr });

        // Both legs are gated, and they are gated DIFFERENTLY. KHRt exempts system
        // contracts from the levy and the tier caps; the synth has neither, only
        // the identity check. So the pair needs both treatments, and neither one
        // substitutes for the other.
        if (isAdmin && !(await khr.isSystemContract(pairAddr))) {
          await (await khr.setSystemContract(pairAddr, true)).wait();
          console.log(`    pair vetted as a KHRt system contract`);
        }
        await attest(pairAddr, "pair");

        const pair = new ethers.Contract(pairAddr, PAIR_ABI, signer);
        const [r0, r1] = await pair.getReserves();
        if (r0 > 0n && r1 > 0n) {
          console.log(`    already seeded — left alone`);
          continue;
        }

        // How much synth is `seedRiel` worth? Ask the vault, which asks the oracle,
        // rather than recomputing the conversion here — two implementations of the
        // same arithmetic is how the two drift apart.
        const oneWhole = 10n ** BigInt(c.decimals);
        const rielPerWhole = await vault.rielValueOf(c.id, oneWhole).catch(() => 0n);
        if (rielPerWhole === 0n) {
          console.log(`    NOT SEEDED — the oracle will not price ${c.symbol}. Publish a rate.`);
          continue;
        }
        const khrSide = seedRiel * 10n ** BigInt(khrDec);           // riel side, minor units
        const synthSide = (khrSide * oneWhole) / rielPerWhole;      // same value in synth
        if (synthSide === 0n) {
          console.log(`    NOT SEEDED — ${seedRiel} riel rounds to zero ${c.symbol}. Raise CSB_SEED_RIEL.`);
          continue;
        }

        // Mint the seed from a position rather than from anywhere else: there is
        // nowhere else. That is the property this whole mechanism exists to have,
        // and the operator is not exempt from it.
        const held = await new ethers.Contract(c.addr, ERC20_ABI, provider).balanceOf(signer.address);
        if (held < synthSide) {
          const needSynth = synthSide - held;
          const collateral = (await vault.rielValueOf(c.id, needSynth)) * seedRatioPct / 100n;
          const haveKhr = await khr.balanceOf(signer.address);
          if (haveKhr < collateral + khrSide) {
            console.log(`    NOT SEEDED — not enough KHRt.`);
            console.log(`      collateral for ${ethers.formatUnits(needSynth, c.decimals)} ${c.symbol}`
              + ` at ${seedRatioPct}%: ${ethers.formatUnits(collateral, khrDec)} riel`);
            console.log(`      pool side: ${ethers.formatUnits(khrSide, khrDec)} riel`);
            console.log(`      held: ${ethers.formatUnits(haveKhr, khrDec)} riel`);
            console.log(`      Lower CSB_SEED_RIEL, or fund the deployer. The pair exists and`);
            console.log(`      is recorded; re-run to seed it.`);
            continue;
          }
          await (await khr.approve(vaultAddr, collateral)).wait();
          await (await vault.deposit(c.id, collateral)).wait();
          await (await vault.mint(c.id, needSynth)).wait();
          console.log(`    opened a vault position: ${ethers.formatUnits(collateral, khrDec)} riel`
            + ` locked, ${ethers.formatUnits(needSynth, c.decimals)} ${c.symbol} issued`);
        }

        await (await new ethers.Contract(c.addr, ERC20_ABI, signer).transfer(pairAddr, synthSide)).wait();
        await (await khr.transfer(pairAddr, khrSide)).wait();
        await (await pair.mint(signer.address)).wait();
        console.log(`    seeded ${ethers.formatUnits(khrSide, khrDec)} KHRt against `
          + `${ethers.formatUnits(synthSide, c.decimals)} ${c.symbol}`);
        console.log(`    THE SEEDED RATIO IS THE PRICE until somebody trades against it —`);
        console.log(`    it reproduces the administered rate rather than discovering one.`);
      }

      // The site's pool selector reads this list; without it a pair exists on
      // chain and is invisible on /defi.html.
      d.currency.pools = list
        .map((c) => d.currency.synths[c.symbol]?.pair)
        .filter(Boolean);
      save();
    }
  }

  // ============================================================ 2. the market
  if (!skipped("aave")) {
    bar("Aave reserves");
    const a = d.aave;
    if (!a?.poolConfigurator || !(await live(a.poolConfigurator))) {
      console.log(`SKIPPED — no live aave.poolConfigurator. Run scripts/aave-live.js first.`);
    } else {
      const pool = at("Pool", a.pool, signer);
      const configurator = at("PoolConfigurator", a.poolConfigurator, signer);
      const oracleAddr = await new ethers.Contract(a.addressesProvider, PROVIDER_ABI, provider)
        .getPriceOracle();
      const aaveOracle = new ethers.Contract(oracleAddr, AAVE_ORACLE_ABI, signer);
      console.log(`Price oracle ${oracleAddr}`);

      for (const c of list) {
        console.log(`\n  ${c.symbol}`);
        if (a.reserves?.[c.symbol] && await live(a.reserves[c.symbol].aToken)) {
          console.log(`    already listed: aToken ${a.reserves[c.symbol].aToken}`);
          continue;
        }

        // A reserve the market cannot price makes every read revert, including
        // reads about OTHER reserves through getUserAccountData. Refusing to list
        // it is the cheap failure; listing it is the expensive one.
        let priced = (await aaveOracle.getAssetPrice(c.addr).catch(() => 0n)) > 0n;
        if (!priced) {
          const rielPerWhole = await vault.rielValueOf(c.id, 10n ** BigInt(c.decimals)).catch(() => 0n);
          const price = (rielPerWhole * 10n ** 18n) / (10n ** BigInt(khrDec));
          try {
            await (await aaveOracle.setAssetPrice(c.addr, price)).wait();
            priced = true;
            console.log(`    priced in Aave's test oracle at ${ethers.formatUnits(price, 18)} riel`);
          } catch {
            console.log(`    the live oracle is the administered one and has no rate for`);
            console.log(`    ${c.symbol}. deploy-currency-vault.js publishes one; run it, or`);
            console.log(`    publish by hand. SKIPPING rather than listing an unpriceable asset.`);
            continue;
          }
        }

        // initReserves takes IMPLEMENTATIONS and clones them per reserve. Reusing
        // another reserve's proxy here lists a reserve backed by that reserve's
        // storage — it deploys cleanly and then misbehaves.
        const aTokenImpl = await deploy("AToken", [a.pool], signer);
        const sdtImpl = await deploy("StableDebtToken", [a.pool], signer);
        const vdtImpl = await deploy("VariableDebtToken", [a.pool], signer);
        const irs = await deploy("IRS", [
          a.addressesProvider,
          (RAY * 80n) / 100n, 0n, (RAY * 4n) / 100n, (RAY * 75n) / 100n,
          (RAY * 5n) / 100n, (RAY * 75n) / 100n, (RAY * 2n) / 100n,
          (RAY * 8n) / 100n, (RAY * 20n) / 100n,
        ], signer);

        await (await configurator.initReserves([{
          aTokenImpl: await aTokenImpl.getAddress(),
          stableDebtTokenImpl: await sdtImpl.getAddress(),
          variableDebtTokenImpl: await vdtImpl.getAddress(),
          underlyingAssetDecimals: c.decimals,
          interestRateStrategyAddress: await irs.getAddress(),
          underlyingAsset: c.addr,
          treasury: signer.address,
          incentivesController: ethers.ZeroAddress,
          aTokenName: `Aave CSB ${c.symbol}`,
          aTokenSymbol: `a${c.symbol}`,
          variableDebtTokenName: `Aave CSB Variable Debt ${c.symbol}`,
          variableDebtTokenSymbol: `variableDebt${c.symbol}`,
          stableDebtTokenName: `Aave CSB Stable Debt ${c.symbol}`,
          stableDebtTokenSymbol: `stableDebt${c.symbol}`,
          params: "0x",
        }])).wait();

        if (synthLtv > 0) {
          await (await configurator.configureReserveAsCollateral(
            c.addr, pctBps(synthLtv), pctBps(Math.min(synthLtv + 5, 95)), pctBps(105))).wait();
          console.log(`    COLLATERAL at ${synthLtv}% LTV — you asked for it with CSB_SYNTH_LTV.`);
          console.log(`    This closes the loop the header warns about: riel to synth to`);
          console.log(`    borrowed riel and round again. The vault's ceiling still bounds it.`);
        } else {
          console.log(`    borrowable, NOT collateral. Borrow ${c.symbol} against your riel;`);
          console.log(`    the reverse would be leverage assembled from two mechanisms that`);
          console.log(`    cannot see each other. CSB_SYNTH_LTV=50 to change it.`);
        }
        await (await configurator.setReserveBorrowing(c.addr, true)).wait();
        await (await configurator.setReserveActive(c.addr, true)).wait();

        const rd = await pool.getReserveData(c.addr);

        // The aToken CUSTODIES the underlying, so it is the address the gate cares
        // about. Without this every supply reverts with NotKycActive naming a
        // contract nobody has heard of — the failure would look like an Aave bug.
        await attest(rd.aTokenAddress, "aToken");

        d.aave.reserves = {
          ...(d.aave.reserves ?? {}),
          [c.symbol]: {
            underlying: c.addr,
            decimals: c.decimals,
            aToken: rd.aTokenAddress,
            variableDebtToken: rd.variableDebtTokenAddress,
            stableDebtToken: rd.stableDebtTokenAddress,
            ltv: synthLtv,
            liquidationThreshold: synthLtv > 0 ? Math.min(synthLtv + 5, 95) : 0,
            liquidationBonus: synthLtv > 0 ? 105 : 0,
            issuedByCsb: true,
          },
        };
        save();
        console.log(`    aToken       ${rd.aTokenAddress}`);
        console.log(`    variableDebt ${rd.variableDebtTokenAddress}`);
      }
    }
  }

  const spent = before - (await provider.getBalance(signer.address));
  bar("Result");
  for (const c of list) {
    const s = d.currency.synths[c.symbol] ?? {};
    console.log(`  ${c.symbol.padEnd(6)} pool ${s.pair ?? "—"}`);
    console.log(`  ${"".padEnd(6)} aave ${d.aave?.reserves?.[c.symbol]?.aToken ?? "—"}`);
  }
  console.log(`\nCost: ${ethers.formatEther(spent)} tRIEL. Recorded in ${path.basename(file)}.`);

  bar("Next");
  console.log(`Restart the app server. /defi.html gains the new pools, /lend.html the new`);
  console.log(`reserves, /currency.html is unchanged.`);
  console.log(``);
  console.log(`WHAT THE POOL PRICE IS NOT. Each pool was seeded at the administered rate,`);
  console.log(`so its ratio REPRODUCES that rate rather than testing it. It becomes a`);
  console.log(`measurement only once somebody trades against it — and with the depth here,`);
  console.log(`not much of one even then.`);
  console.log(``);
  console.log(`WHAT IS STILL LEAKING. The pair is attested; its LP token is not, and cannot`);
  console.log(`be — it is Uniswap's contract. Same for the aToken's balance: the aToken`);
  console.log(`itself is attested so it can custody the currency, but the RECEIPT it hands`);
  console.log(`out carries none of the currency's rules. docs/defi.md, one layer up.`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
