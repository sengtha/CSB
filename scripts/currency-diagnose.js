const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Why won't it mint / swap / supply? Ask the chain, not the log.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/currency-diagnose.js --network csbRemote
 *   CSB_ADDRESS=0x… npx hardhat run scripts/currency-diagnose.js --network csbRemote
 *
 * Read-only. Sends nothing, changes nothing.
 *
 * WHY THIS EXISTS. A refusal here can come from six places that all present the
 * same way in a browser — the oracle has no rate, the rate went stale, the debt
 * ceiling is full, the position has no collateral OF THAT CURRENCY, the address
 * has no attestation, or the venue holding the token has none. Guessing between
 * them from a UI message wastes a round trip every time, and two of the six are
 * invisible from the front end at all.
 *
 * So every check below ends in a SIMULATION: the actual call, run as the actual
 * address, through eth_call. Whatever the chain says is what gets printed. A
 * check that reasons about preconditions can be wrong about which one binds; a
 * simulation cannot.
 *
 * Environment:
 *   CSB_ADDRESS   whose position to examine (default: the deployer)
 *   CSB_AMOUNT    whole units to simulate minting/supplying (default 1)
 */

const VAULT_ABI = [
  "function currencyCount() view returns (uint256)",
  "function currencyAt(uint256) view returns (tuple(address synth, uint8 synthDecimals, uint16 minRatioBps, uint16 liqThresholdBps, uint16 liqPenaltyBps, uint256 debtCeiling, uint256 totalDebt, bool mintingPaused))",
  "function positionOf(uint256,address) view returns (tuple(uint256 collateral, uint256 debt))",
  "function ratioBps(uint256,address) view returns (uint256)",
  "function maxDebt(uint256,address) view returns (uint256)",
  "function rielValueOf(uint256,uint256) view returns (uint256)",
  "function collateralToken() view returns (address)",
  "function deposit(uint256,uint256)",
  "function mint(uint256,uint256)",
  "error NoSuchCurrency()",
  "error MintingPaused()",
  "error DebtCeilingReached(uint256 ceiling, uint256 wouldBe)",
  "error Undercollateralised(uint256 ratioBps, uint256 requiredBps)",
  "error NothingToDo()",
  "error TransferFailed()",
];
const SYNTH_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function vault() view returns (address)",
  "error NotKycActive(address account)",
  "error OnlyVault()",
];
const KHR_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "error NotKycActive(address account)",
  "error AccountFrozen(address account)",
  "error TierCapExceeded(address account, uint8 tier, uint256 cap, uint256 amount)",
];
const IDENTITY_ABI = [
  "function isActive(address) view returns (bool)",
  "function attestationOf(address) view returns (tuple(bytes32 identity, uint8 tier, uint8 status, uint64 issuedAt))",
];
const ORACLE_ABI = [
  "function describe(address) view returns (uint256 price, uint64 publishedAt, bytes32 sourceRef, bool stale)",
  "function BASE_CURRENCY_UNIT() view returns (uint256)",
  "function maxAge() view returns (uint256)",
];
const PAIR_ABI = [
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
];
const POOL_ABI = [
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function getConfiguration(address) view returns (tuple(uint256 data))",
  "function getReserveData(address asset) view returns (tuple(tuple(uint256 data) configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
];

const OK = "  ok  ";
const NO = "  NO  ";
const bar = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

/**
 * Aave packs a reserve's whole configuration into one uint256. The bit offsets
 * are from ReserveConfiguration.sol; reading them here beats calling a data
 * provider that may not be deployed on this chain.
 */
function decodeAaveConfig(data) {
  const bit = (n) => ((data >> BigInt(n)) & 1n) === 1n;
  return {
    ltv: Number(data & 0xffffn),
    liqThreshold: Number((data >> 16n) & 0xffffn),
    decimals: Number((data >> 48n) & 0xffn),
    active: bit(56),
    frozen: bit(57),
    borrowing: bit(58),
    paused: bit(60),
    supplyCap: Number((data >> 116n) & 0xfffffffffn),
  };
}

/** Run a call as `from` and return null on success, or the decoded revert. */
async function simulate(contract, fn, args, from, ifaces) {
  try {
    await contract[fn].staticCall(...args, { from });
    return null;
  } catch (e) {
    const data = e?.info?.error?.data ?? e?.data ?? e?.error?.data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
      for (const i of ifaces) {
        try {
          const p = i.parseError(data);
          if (p) return `${p.name}(${p.args.map(String).join(", ")})`;
        } catch (_) { /* next */ }
      }
    }
    return e?.shortMessage ?? e?.message ?? String(e);
  }
}

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const [signer] = await ethers.getSigners();
  const who = process.env.CSB_ADDRESS ?? signer.address;
  const wholeUnits = BigInt(process.env.CSB_AMOUNT ?? 1);

  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const live = async (a) => a && (await provider.getCode(a)).length > 2;

  bar(`Currency diagnosis — chain ${(await provider.getNetwork()).chainId}`);
  console.log(`Examining ${who}${who === signer.address ? "  (the deployer)" : ""}`);

  const vaultAddr = d.currency?.vault;
  if (!(await live(vaultAddr))) {
    console.log(`\nNo currency vault on this chain. Run scripts/deploy-currency-vault.js.`);
    return;
  }
  const vault = new ethers.Contract(vaultAddr, VAULT_ABI, provider);
  const khrAddr = d.contracts.KHRStablecoin;
  const khr = new ethers.Contract(khrAddr, KHR_ABI, provider);
  const khrDec = Number(await khr.decimals());
  const identity = new ethers.Contract(d.contracts.IdentityRegistry, IDENTITY_ABI, provider);
  const oracle = new ethers.Contract(d.currency.oracle ?? d.oracle?.referenceRate, ORACLE_ABI, provider);
  const UNIT = await oracle.BASE_CURRENCY_UNIT();
  const maxAge = await oracle.maxAge();

  const ifaces = [VAULT_ABI, SYNTH_ABI, KHR_ABI].map((a) => new ethers.Interface(a));

  // ---------------------------------------------------------------- the actor
  bar("The address");
  const active = await identity.isActive(who).catch(() => false);
  const att = await identity.attestationOf(who).catch(() => null);
  console.log(`${active ? OK : NO} KYC attestation${att ? ` — status ${att.status}, tier ${att.tier}` : ""}`);
  if (!active) {
    console.log(`      A CSB-issued currency cannot be minted TO an address without one.`);
    console.log(`      The registry checks issuance as well as transfer, so this alone`);
    console.log(`      stops every mint below. Fix: identity.register("${who}", <hash>, 2)`);
  }
  const khrBal = await khr.balanceOf(who);
  console.log(`${khrBal > 0n ? OK : NO} holds ${ethers.formatUnits(khrBal, khrDec)} KHRt`);
  console.log(`${OK} vault attested: ${await identity.isActive(vaultAddr).catch(() => false)}`);

  // ------------------------------------------------------------- per currency
  const n = await vault.currencyCount();
  if (n === 0n) console.log(`\nThe vault holds no currencies.`);

  for (let i = 0n; i < n; i++) {
    const c = await vault.currencyAt(i);
    const synth = new ethers.Contract(c.synth, SYNTH_ABI, provider);
    const sym = await synth.symbol().catch(() => "?");
    const dec = Number(c.synthDecimals);
    const one = 10n ** BigInt(dec);
    const amount = wholeUnits * one;

    bar(`#${i}  ${sym}   ${c.synth}`);

    // --- the rate ---------------------------------------------------------
    const r = await oracle.describe(c.synth).catch(() => null);
    if (!r || r.price === 0n) {
      console.log(`${NO} no rate published. Every mint reverts with RateNotSet, and so does`);
      console.log(`      every ratio the page tries to show. THIS IS THE MOST COMMON CAUSE.`);
      console.log(`      Fix: oracle.publish("${c.synth}", <riel per whole unit> * ${UNIT}, <ref>)`);
      console.log(`      or re-run scripts/deploy-currency-vault.js holding RATE_PUBLISHER_ROLE.`);
    } else {
      const age = Math.round(Date.now() / 1000 - Number(r.publishedAt));
      const rate = Number(r.price * 100n / UNIT) / 100;
      console.log(`${r.stale ? NO : OK} rate ${rate} riel per ${sym}, ${Math.round(age / 3600)}h old`
        + `${r.stale ? ` — STALE (max ${maxAge}s)` : ""}`);
      if (r.stale) {
        console.log(`      Minting and withdrawing against debt are halted until it is`);
        console.log(`      republished. Repaying still works, by design.`);
      }
    }

    // --- the currency's own limits ----------------------------------------
    const headroom = c.debtCeiling > c.totalDebt ? c.debtCeiling - c.totalDebt : 0n;
    console.log(`${c.mintingPaused ? NO : OK} minting ${c.mintingPaused ? "PAUSED" : "enabled"}`);
    console.log(`${headroom >= amount ? OK : NO} ceiling ${ethers.formatUnits(c.totalDebt, dec)}`
      + ` / ${ethers.formatUnits(c.debtCeiling, dec)} used — ${ethers.formatUnits(headroom, dec)} ${sym} left`);
    console.log(`${OK} ${dec} decimals, ${Number(c.minRatioBps) / 100}% to issue,`
      + ` liquidatable below ${Number(c.liqThresholdBps) / 100}%`);
    console.log(`${OK} supply ${ethers.formatUnits(await synth.totalSupply(), dec)} ${sym}`);

    // --- this address's position ------------------------------------------
    //
    // POSITIONS ARE PER CURRENCY. Collateral locked against khUSD does not back
    // khJPY, and this is the single most likely reason a second currency refuses
    // to mint when the first one worked.
    const p = await vault.positionOf(i, who);
    const room = await vault.maxDebt(i, who).catch(() => null);
    console.log(`${p.collateral > 0n ? OK : NO} locked for ${sym}: `
      + `${ethers.formatUnits(p.collateral, khrDec)} KHRt, debt ${ethers.formatUnits(p.debt, dec)} ${sym}`);
    if (p.collateral === 0n) {
      console.log(`      NOTHING IS LOCKED FOR THIS CURRENCY. Positions are per currency —`);
      console.log(`      riel behind another one does not back ${sym}. Lock KHRt while ${sym}`);
      console.log(`      is the selected currency on /currency.html.`);
    }
    if (room !== null) console.log(`${OK} room to issue ${ethers.formatUnits(room, dec)} ${sym}`);

    // --- what actually happens --------------------------------------------
    const why = await simulate(vault, "mint", [i, amount], who, ifaces);
    console.log(`${why === null ? OK : NO} simulated mint of ${wholeUnits} ${sym}: `
      + `${why === null ? "would succeed" : why}`);

    // --- the pool ---------------------------------------------------------
    const pairAddr = d.currency?.synths?.[sym]?.pair;
    if (!(await live(pairAddr))) {
      console.log(`${NO} no Uniswap pair recorded. Run scripts/currency-defi.js.`);
    } else {
      const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
      const [r0, r1] = await pair.getReserves();
      const pairOk = await identity.isActive(pairAddr).catch(() => false);
      console.log(`${pairOk ? OK : NO} pair ${pairAddr} attested: ${pairOk}`);
      if (!pairOk) console.log(`      Un-attested, it cannot receive ${sym} — every swap and`
        + ` every add-liquidity reverts.`);
      console.log(`${r0 > 0n && r1 > 0n ? OK : NO} reserves ${r0} / ${r1}`
        + `${r0 === 0n || r1 === 0n ? "  — EMPTY, nothing to trade against" : ""}`);
    }

    // --- the lending market ------------------------------------------------
    const res = d.aave?.reserves?.[sym];
    if (!d.aave?.pool || !(await live(d.aave.pool))) {
      console.log(`${NO} no Aave market on this chain.`);
    } else if (!res?.aToken || !(await live(res.aToken))) {
      console.log(`${NO} ${sym} is NOT listed as an Aave reserve. Run scripts/currency-defi.js.`);
    } else {
      const pool = new ethers.Contract(d.aave.pool, POOL_ABI, provider);
      const rd = await pool.getReserveData(c.synth);
      const cfg = decodeAaveConfig(rd.configuration.data);
      const aOk = await identity.isActive(rd.aTokenAddress).catch(() => false);

      console.log(`${cfg.active && !cfg.frozen && !cfg.paused ? OK : NO} reserve `
        + `active=${cfg.active} frozen=${cfg.frozen} paused=${cfg.paused} borrowing=${cfg.borrowing}`);
      console.log(`${cfg.decimals === dec ? OK : NO} reserve decimals ${cfg.decimals}`
        + `${cfg.decimals === dec ? "" : ` — MISMATCH, the token says ${dec}`}`);
      console.log(`${OK} LTV ${cfg.ltv / 100}% (0 means borrowable but not collateral, by design)`);
      console.log(`${aOk ? OK : NO} aToken ${rd.aTokenAddress} attested: ${aOk}`);
      if (!aOk) {
        console.log(`      THE aTOKEN CUSTODIES THE UNDERLYING. Un-attested it cannot receive`);
        console.log(`      ${sym}, so every supply reverts with NotKycActive naming a contract`);
        console.log(`      the user has never heard of. Fix:`);
        console.log(`        identity.register("${rd.aTokenAddress}", <hash>, 3)`);
      }

      const bal = await synth.balanceOf(who);
      const allw = await synth.allowance(who, d.aave.pool);
      console.log(`${bal >= amount ? OK : NO} holds ${ethers.formatUnits(bal, dec)} ${sym}`);
      console.log(`${allw >= amount ? OK : NO} pool allowance ${ethers.formatUnits(allw, dec)} ${sym}`
        + `${allw >= amount ? "" : " — the page approves this itself, so a shortfall here is normal"}`);

      const supplyWhy = await simulate(pool, "supply", [c.synth, amount, who, 0], who, ifaces);
      console.log(`${supplyWhy === null ? OK : NO} simulated supply of ${wholeUnits} ${sym}: `
        + `${supplyWhy === null ? "would succeed" : supplyWhy}`);
    }
  }

  bar("Reading this");
  console.log(`The SIMULATED lines are the authoritative ones — they are the real call,`);
  console.log(`run as ${who}, through eth_call. Everything above each of them is context`);
  console.log(`for why it says what it says.`);
  console.log(``);
  console.log(`A simulated supply that fails on allowance is not a fault: the lending page`);
  console.log(`approves as part of the same click. Re-run with CSB_AMOUNT=0 to check the`);
  console.log(`other preconditions without that one in the way.`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
