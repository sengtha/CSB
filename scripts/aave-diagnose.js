const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Explain why an Aave action is being refused, for one address. Read-only.
 *
 *     source ops/csb-env.sh
 *     npx hardhat run scripts/aave-diagnose.js --network csbRemote
 *     CSB_ADDR=0xabc... npx hardhat run scripts/aave-diagnose.js --network csbRemote
 *
 * Written after a borrow failed with `execution reverted: "34"`. Aave reverts
 * with bare numeric strings, so the first job is translating them; the second is
 * that the interesting state is spread across the pool, the reserve
 * configuration, a per-user bitmask and the oracle, and reading only one of them
 * invites the wrong conclusion.
 *
 * The specific trap that produced error 34: the lending page shows the pool's
 * TOTAL supplied alongside your own position. A pool with 500,000 aKHRt
 * outstanding looks like a funded market — but Aave sizes a borrow against the
 * caller's OWN collateral, so supplying from one address and borrowing from
 * another fails with "the collateral balance is 0" while the page shows a
 * healthy pool.
 *
 * Nothing here needs a private key or sends a transaction.
 */

// Aave V3 reverts with these as plain strings. Only the ones reachable from the
// lending page are listed; the full set is in @aave/core-v3 Errors.sol.
const AAVE_ERRORS = {
  "26": "INVALID_AMOUNT — amount is 0",
  "27": "RESERVE_INACTIVE — the reserve is not active",
  "28": "RESERVE_FROZEN — the reserve is frozen (no new supply/borrow)",
  "29": "RESERVE_PAUSED",
  "30": "BORROWING_NOT_ENABLED — borrowing is off for this reserve",
  "31": "STABLE_BORROWING_NOT_ENABLED",
  "32": "NOT_ENOUGH_AVAILABLE_USER_BALANCE — withdrawing more than you hold",
  "33": "INVALID_INTEREST_RATE_MODE_SELECTED",
  "34": "COLLATERAL_BALANCE_IS_ZERO — YOU hold no collateral (not the pool: you)",
  "35": "HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD",
  "36": "COLLATERAL_CANNOT_COVER_NEW_BORROW — you have collateral, just not enough",
  "37": "COLLATERAL_SAME_AS_BORROWING_CURRENCY — stable-rate borrow of your own collateral asset",
  "39": "NO_DEBT_OF_SELECTED_TYPE — repaying a debt you do not have",
};

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const POOL = [
  "function getReserveData(address) view returns (uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
  "function getUserConfiguration(address) view returns (uint256)",
  "function getUserAccountData(address) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
];

function decodeReserveConfig(cfg) {
  // Bit layout from @aave/core-v3 ReserveConfiguration.sol.
  const bit = (shift, mask) => (cfg >> BigInt(shift)) & mask;
  return {
    ltv: Number(bit(0, 0xffffn)) / 100,
    liquidationThreshold: Number(bit(16, 0xffffn)) / 100,
    liquidationBonus: Number(bit(32, 0xffffn)) / 100,
    decimals: Number(bit(48, 0xffn)),
    active: bit(56, 1n) === 1n,
    frozen: bit(57, 1n) === 1n,
    borrowingEnabled: bit(58, 1n) === 1n,
    stableBorrowingEnabled: bit(59, 1n) === 1n,
    paused: bit(60, 1n) === 1n,
  };
}

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  if (!d.aave?.pool) {
    console.log("No `aave` block in deployments.json — no market on this chain.");
    console.log("Deploy one: npx hardhat run scripts/aave-live.js --network csbRemote");
    return;
  }
  const a = d.aave;

  let who = process.env.CSB_ADDR;
  if (!who) {
    const [signer] = await ethers.getSigners();
    who = signer?.address;
  }
  if (!who) throw new Error("Set CSB_ADDR=0x... to choose an address to diagnose.");

  // Check every address BEFORE handing it to ethers. Anything that is not a
  // valid address gets treated as an ENS name, and the failure surfaces as
  // "Method 'HardhatEthersProvider.resolveName' is not implemented" — which says
  // nothing about the actual mistake. The usual mistakes are pasting a truncated
  // address (0x70e7...ba10) and a deployments.json `aave` block missing a key.
  if (!ethers.isAddress(who)) {
    throw new Error(`CSB_ADDR is not a valid address: "${who}"\n`
      + `  It must be the full 42-character address (0x + 40 hex characters).\n`
      + `  An abbreviated one copied from a UI — 0x70e7...ba10 — will not work.`);
  }
  for (const k of ["pool", "aToken", "variableDebtToken", "underlying"]) {
    if (!ethers.isAddress(a[k] ?? "")) {
      throw new Error(`deployments.json aave.${k} is missing or not an address: `
        + `${JSON.stringify(a[k])}\n  Present keys: ${Object.keys(a).join(", ")}\n`
        + `  Re-run scripts/aave-live.js, or add the key by hand.`);
    }
  }

  const pool = new ethers.Contract(a.pool, POOL, provider);
  const aToken = new ethers.Contract(a.aToken, ERC20, provider);
  const vDebt = new ethers.Contract(a.variableDebtToken, ERC20, provider);
  const under = new ethers.Contract(a.underlying, ERC20, provider);

  const dec = Number(a.decimals ?? (await under.decimals()));
  const f = (v) => Number(ethers.formatUnits(v, dec))
    .toLocaleString("en-US", { minimumFractionDigits: 2 });

  const rd = await pool.getReserveData(a.underlying);
  const cfg = decodeReserveConfig(rd.configuration);
  const [myUnder, myA, myDebt, totalA, userCfg, acct] = await Promise.all([
    under.balanceOf(who), aToken.balanceOf(who), vDebt.balanceOf(who),
    aToken.totalSupply(), pool.getUserConfiguration(who), pool.getUserAccountData(who),
  ]);

  // The per-user bitmask: two bits per reserve, collateral flag is the high one.
  const rid = Number(rd.id);
  const usingAsCollateral = ((userCfg >> BigInt(rid * 2 + 1)) & 1n) === 1n;
  const isBorrowing = ((userCfg >> BigInt(rid * 2)) & 1n) === 1n;

  console.log(`\nChain    ${(await provider.getNetwork()).chainId}`);
  console.log(`Address  ${who}\n`);

  console.log(`RESERVE (${a.underlying})`);
  console.log(`  active ${cfg.active}   frozen ${cfg.frozen}   paused ${cfg.paused}`);
  console.log(`  borrowing enabled ${cfg.borrowingEnabled}`);
  console.log(`  LTV ${cfg.ltv}%   liquidation threshold ${cfg.liquidationThreshold}%`);
  console.log(`  reserve id ${rid}   decimals ${cfg.decimals}`);

  console.log(`\nPOOL TOTALS`);
  console.log(`  aKHRt outstanding, ALL addresses   ${f(totalA)}`);

  console.log(`\nTHIS ADDRESS`);
  console.log(`  wallet (underlying)                ${f(myUnder)}`);
  console.log(`  supplied (aToken balance)          ${f(myA)}`);
  console.log(`  variable debt                      ${f(myDebt)}`);
  console.log(`  flagged as using collateral        ${usingAsCollateral}`);
  console.log(`  flagged as borrowing               ${isBorrowing}`);
  console.log(`  totalCollateralBase                ${acct.totalCollateralBase}`);
  console.log(`  availableBorrowsBase               ${acct.availableBorrowsBase}`);
  const comp = await complianceOf(ethers, provider, who, d.contracts?.IdentityRegistry);
  if (comp) console.log(`  compliance status                  ${comp}`);

  console.log(`\nVERDICT`);
  if (myA === 0n && totalA > 0n) {
    console.log(`  This address holds NO aKHRt, but the pool holds ${f(totalA)}.`);
    console.log(`  A borrow from here reverts with "34" (${AAVE_ERRORS["34"]}).`);
    console.log(`  Aave sizes a borrow against the CALLER's collateral, so the`);
    console.log(`  pool's total is irrelevant — someone else supplied it.`);
    console.log(`  Fix: supply from this address, or borrow from the one that did.`);
    console.log(`\n  Looking for who holds it...`);
    await findHolders(ethers, provider, a.aToken, f, d.contracts?.IdentityRegistry);
  } else if (myA === 0n) {
    console.log(`  Nobody has supplied anything. Supply first, then borrow.`);
  } else if (!usingAsCollateral) {
    console.log(`  This address holds ${f(myA)} aKHRt but its collateral flag is OFF,`);
    console.log(`  so Aave counts zero collateral and a borrow reverts with "34".`);
    console.log(`  Aave sets that flag automatically on a FIRST supply only when the`);
    console.log(`  reserve's LTV is non-zero. LTV here is ${cfg.ltv}%.`);
    console.log(`  Fix: pool.setUserUseReserveAsCollateral(underlying, true)`);
  } else if (acct.availableBorrowsBase === 0n) {
    console.log(`  Collateral is recognised but availableBorrowsBase is 0 — a borrow`);
    console.log(`  will revert with "36", not "34". Check the oracle price and LTV.`);
  } else {
    console.log(`  Nothing wrong with this address's collateral. It can borrow up to`);
    console.log(`  availableBorrowsBase above. If a borrow still reverts, read the`);
    console.log(`  numeric code against the table in this script.`);
  }

  console.log(`\nAave numeric revert codes seen from the lending page:`);
  for (const [k, v] of Object.entries(AAVE_ERRORS)) console.log(`  "${k}"  ${v}`);
}

const IDENTITY = [
  "function isActive(address) view returns (bool)",
  "function tierOf(address) view returns (uint8)",
];
// txAllowList precompile: role 0 = none, 1 = enabled, 2 = admin, 3 = manager.
const TX_ALLOW_LIST = "0x0200000000000000000000000000000000000002";
const ROLE_NAMES = { 0: "none", 1: "enabled", 2: "admin", 3: "manager" };

/**
 * For an aToken holder, report whether the chain would let it hold the
 * UNDERLYING or even send a transaction. This is the experiment's actual
 * question, not a side quest: an aToken is an unrestricted ERC-20 claim on
 * pooled KHRt, so a holder whose identity status is `none` is a live instance of
 * economic exposure escaping the compliance perimeter. Returns a label, or null
 * if the registries could not be read.
 */
async function complianceOf(ethers, provider, addr, identityAddr) {
  const bits = [];
  if (identityAddr && ethers.isAddress(identityAddr)) {
    try {
      const reg = new ethers.Contract(identityAddr, IDENTITY, provider);
      const [active, tier] = await Promise.all([reg.isActive(addr), reg.tierOf(addr)]);
      bits.push(active ? `KYC active (tier ${tier})` : "NO KYC ATTESTATION");
    } catch { /* registry unreadable — say nothing rather than guess */ }
  }
  try {
    const al = new ethers.Contract(TX_ALLOW_LIST,
      ["function readAllowList(address) view returns (uint256)"], provider);
    const n = Number(await al.readAllowList(addr));
    bits.push(`txAllowList: ${ROLE_NAMES[n] ?? n}`);
  } catch { /* not a subnet-evm chain, or precompile disabled */ }
  return bits.length ? bits.join(", ") : null;
}

/** Find aToken holders from Transfer events, so "who supplied" is answerable. */
async function findHolders(ethers, provider, aTokenAddr, f, identityAddr) {
  const c = new ethers.Contract(aTokenAddr,
    ["event Transfer(address indexed from, address indexed to, uint256 value)"], provider);
  const latest = await provider.getBlockNumber();
  // A test chain's history is short; cap the scan so this stays quick on a long one.
  const from = Math.max(0, latest - 200_000);
  let logs;
  try {
    logs = await c.queryFilter(c.filters.Transfer(), from, latest);
  } catch (e) {
    console.log(`  (could not scan Transfer logs: ${e.shortMessage ?? e.message})`);
    return;
  }
  const seen = new Set();
  for (const l of logs) {
    for (const addr of [l.args.from, l.args.to]) {
      if (addr && addr !== ethers.ZeroAddress) seen.add(addr);
    }
  }
  const bal = new ethers.Contract(aTokenAddr, ERC20, provider);
  for (const addr of seen) {
    const b = await bal.balanceOf(addr);
    if (b === 0n) continue;
    // The compliance status is the point, not decoration: an aToken holder whose
    // status is "NO KYC ATTESTATION" is the perimeter leak, observed live.
    const c = await complianceOf(ethers, provider, addr, identityAddr);
    console.log(`    ${addr}  holds ${f(b)} aKHRt${c ? `  [${c}]` : ""}`);
    if (c && c.includes("NO KYC")) {
      console.log(`      ^ an unattested address holding a claim on pooled KHRt`);
    }
  }
  if (!seen.size) console.log(`    (no Transfer events in the last ${latest - from} blocks)`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
