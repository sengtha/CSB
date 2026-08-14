const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Deploy CurrencyVault and its synthetic currencies.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/deploy-currency-vault.js --network csbRemote
 *
 * WHAT THIS REPLACES. Until now the only dollar on CSB was `USDx`, a test token
 * with an unguarded `mint`. Anybody could create any quantity of it, which made
 * its supply arbitrary, its Aave collateral value fictional, and the KHRt/USDx
 * pool price a number with nothing behind it. This deploys origination instead:
 * every unit of khUSD or khJPY that exists was minted against KHRt locked in the
 * vault, and the backing is arithmetic anyone can recheck.
 *
 * ORDER MATTERS AND IS NOT OBVIOUS. A SyntheticCurrency names its vault in the
 * constructor and can never be repointed, and `addCurrency` refuses a synth that
 * names a different one. So the vault must exist before any currency, which means
 * a redeploy of the vault orphans every currency and every position with it. That
 * is why this is idempotent about the vault and additive about currencies: a
 * second run adds what is missing and touches nothing that exists.
 *
 * IT MUST BE ATTESTED TO HOLD THE COLLATERAL. KHRt refuses to move to an address
 * the identity registry does not know — the same wall the Uniswap pool, the DAO
 * escrow and every Safe hit. Registered at tier 3 and deliberately NOT
 * setSystemContract: that would also exempt it from the transfer levy and the
 * tier caps, and a vault should be as constrained as the people using it. The
 * vault measures what actually arrives, so the levy costs collateral rather than
 * breaking accounting (contracts/currency/CurrencyVault.sol, `deposit`).
 *
 * THE RATES ARE THE WEAK POINT, AND THE CEILING IS THE ANSWER. CSB's oracle is an
 * administered rate published by a role — docs/oracle.md is explicit that it is
 * instrumentation, not valuation. A collateral ratio protects against a price that
 * MOVES and does nothing about one that is WRONG. Each currency below therefore
 * carries a hard debt ceiling, and that is the control to tighten first if this is
 * ever pointed at anything that matters.
 *
 * Environment, all optional:
 *   CSB_SKIP_ATTEST=1     deploy without registering the vault (nothing will work)
 *   CSB_CURRENCIES=khUSD,khJPY   subset of the table below
 */

const IDENTITY_ABI = [
  "function register(address account, bytes32 identity, uint8 tier)",
  "function isActive(address) view returns (bool)",
  "function ISSUER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
];

const ORACLE_ABI = [
  "function publish(address asset, uint256 price, bytes32 sourceRef)",
  "function getAssetPrice(address) view returns (uint256)",
  "function BASE_CURRENCY_UNIT() view returns (uint256)",
  "function RATE_PUBLISHER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function maxAge() view returns (uint256)",
];

/**
 * The starting set. `riel` is riel per WHOLE unit, which is what the oracle
 * quotes; `decimals` follows the currency rather than a convention, for the same
 * reason KHRt has two — the yen has no circulating subunit and quoting it with
 * two would invent one. `ceiling` is in minor units.
 */
const CURRENCIES = [
  {
    symbol: "khUSD", name: "CSB Synthetic US Dollar", decimals: 2, riel: 4000,
    ceiling: 100_000_00n,          // 100,000 dollars
    note: "The dollar CSB issues rather than imports.",
  },
  {
    symbol: "khJPY", name: "CSB Synthetic Japanese Yen", decimals: 0, riel: 27,
    ceiling: 10_000_000n,          // 10,000,000 yen
    note: "Zero decimals, on purpose — the yen has no circulating subunit.",
  },
  {
    symbol: "khEUR", name: "CSB Synthetic Euro", decimals: 2, riel: 4700,
    ceiling: 100_000_00n,          // 100,000 euro
    note: "Present to show the mechanism is not dollar-shaped.",
  },
];

// 150% to mint, liquidatable below 125%, 10% to the liquidator. Conservative
// because the rate is administered and thinly sourced, not because the riel is
// volatile against the dollar — it is not.
const MIN_RATIO_BPS = 15_000;
const LIQ_THRESHOLD_BPS = 12_500;
const LIQ_PENALTY_BPS = 1_000;

const bar = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const [signer] = await ethers.getSigners();
  const net = await provider.getNetwork();

  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const save = () => fs.writeFileSync(file, JSON.stringify(d, null, 2));

  bar(`CurrencyVault on chain ${net.chainId}`);
  console.log(`Deployer ${signer.address}`);

  const khr = d.contracts?.KHRStablecoin;
  const idAddr = d.contracts?.IdentityRegistry;
  const oracleAddr = d.oracle?.referenceRate;
  if (!khr) throw new Error("No contracts.KHRStablecoin in deployments.json.");
  // Without the registry every SyntheticCurrency would call isActive() on the
  // zero address and revert on its own mint — a currency nobody could ever hold.
  // Refusing here beats deploying three of them and finding out at the first use.
  if (!idAddr) throw new Error("No contracts.IdentityRegistry in deployments.json.");
  if (!oracleAddr) {
    throw new Error(
      "No oracle.referenceRate in deployments.json. The vault prices every currency "
      + "in riel through it — run scripts/oracle-deploy.js first.");
  }

  const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, signer);
  const UNIT = await oracle.BASE_CURRENCY_UNIT();
  console.log(`KHRt     ${khr}`);
  console.log(`Oracle   ${oracleAddr}  (unit ${UNIT}, maxAge ${await oracle.maxAge()}s)`);

  const before = await provider.getBalance(signer.address);
  d.currency = d.currency ?? {};

  // --- the vault ------------------------------------------------------------
  let vaultAddr = d.currency.vault;
  if (vaultAddr && (await provider.getCode(vaultAddr)) !== "0x") {
    console.log(`\nVault already deployed at ${vaultAddr} — reusing it.`);
  } else {
    const v = await (await ethers.getContractFactory("CurrencyVault"))
      .deploy(khr, oracleAddr, signer.address);
    await v.waitForDeployment();
    vaultAddr = await v.getAddress();
    // Recorded before anything else can fail, so a later error does not lose the
    // address and leak a contract per attempt.
    d.currency.vault = vaultAddr;
    d.currency.collateral = khr;
    d.currency.oracle = oracleAddr;
    d.currency.note = "Lock KHRt, mint foreign currency. Every synthetic unit is "
      + "backed by riel in this contract — see contracts/currency/CurrencyVault.sol.";
    save();
    console.log(`\nVault deployed  ${vaultAddr}`);
  }
  const vault = await ethers.getContractAt("CurrencyVault", vaultAddr, signer);

  // --- let it hold the collateral -------------------------------------------
  bar("Identity");
  if (process.env.CSB_SKIP_ATTEST === "1") {
    console.log(`  skipped. Every deposit will revert until the vault is attested.`);
  } else {
    const id = new ethers.Contract(idAddr, IDENTITY_ABI, signer);
    if (await id.isActive(vaultAddr).catch(() => false)) {
      console.log(`  already attested.`);
    } else {
      const role = await id.ISSUER_ROLE().catch(() => null);
      const may = role ? await id.hasRole(role, signer.address).catch(() => false) : false;
      if (!may) {
        console.log(`  ${signer.address} does not hold ISSUER_ROLE. The Identity Authority`);
        console.log(`  must register the vault before any deposit can be made:`);
        console.log(`    identity.register("${vaultAddr}", <identity hash>, 3)`);
      } else {
        // Salted with the address: a fixed commitment can only ever attach one
        // address, so a redeploy would fail with QuotaExceeded.
        await (await id.register(vaultAddr, ethers.id(`csb:currencyvault:${vaultAddr}`), 3)).wait();
        console.log(`  registered at tier 3 — it can now custody KHRt.`);
        console.log(`  NOT a system contract: the levy and the tier caps apply to it.`);
      }
    }
  }

  // --- rates ----------------------------------------------------------------
  bar("Rates");
  const pubRole = await oracle.RATE_PUBLISHER_ROLE().catch(() => null);
  const mayPublish = pubRole
    ? await oracle.hasRole(pubRole, signer.address).catch(() => false) : false;
  if (!mayPublish) {
    console.log(`  ${signer.address} does not hold RATE_PUBLISHER_ROLE.`);
    console.log(`  Currencies will be registered, but minting reverts until the publisher`);
    console.log(`  posts a rate for each synth address printed below.`);
  }

  // --- the currencies -------------------------------------------------------
  bar("Currencies");
  const wanted = process.env.CSB_CURRENCIES
    ? process.env.CSB_CURRENCIES.split(",").map((s) => s.trim())
    : CURRENCIES.map((c) => c.symbol);

  d.currency.synths = d.currency.synths ?? {};
  const today = new Date().toISOString().slice(0, 10);

  for (const c of CURRENCIES.filter((c) => wanted.includes(c.symbol))) {
    const have = d.currency.synths[c.symbol];
    if (have?.address && (await provider.getCode(have.address)) !== "0x") {
      console.log(`\n  ${c.symbol}  already at ${have.address} — left alone.`);
      continue;
    }

    const s = await (await ethers.getContractFactory("SyntheticCurrency"))
      .deploy(c.name, c.symbol, c.decimals, idAddr, vaultAddr);
    await s.waitForDeployment();
    const addr = await s.getAddress();

    // Recorded before registration, for the same reason as the vault.
    d.currency.synths[c.symbol] = {
      address: addr, name: c.name, decimals: c.decimals,
      rielPerUnit: c.riel, ceiling: c.ceiling.toString(), note: c.note,
    };
    save();
    console.log(`\n  ${c.symbol}  ${addr}  (${c.decimals} dp, ~${c.riel} riel each)`);

    // The rate must exist before addCurrency, because registering a currency the
    // oracle cannot price leaves a slot users can deposit into and never mint
    // from — a dead end that looks like a bug in the vault.
    if (mayPublish) {
      const priced = await oracle.getAssetPrice(addr).then(() => true).catch(() => false);
      if (!priced) {
        const price = BigInt(c.riel) * UNIT;
        await (await oracle.publish(addr, price, ethers.id(`csb:initial-rate:${c.symbol}:${today}`))).wait();
        console.log(`         rate published: ${c.riel} riel per ${c.symbol}`);
      }
    }

    await (await vault.addCurrency(
      addr, MIN_RATIO_BPS, LIQ_THRESHOLD_BPS, LIQ_PENALTY_BPS, c.ceiling,
    )).wait();
    const id = (await vault.currencyCount()) - 1n;
    d.currency.synths[c.symbol].id = Number(id);
    save();
    console.log(`         registered as currency #${id}, ceiling ${c.ceiling} minor units`);
  }

  // --- summary --------------------------------------------------------------
  bar("Result");
  const n = await vault.currencyCount();
  for (let i = 0n; i < n; i++) {
    const c = await vault.currencyAt(i);
    const sym = Object.entries(d.currency.synths)
      .find(([, v]) => v.address?.toLowerCase() === c.synth.toLowerCase())?.[0] ?? "?";
    console.log(`  #${i}  ${sym.padEnd(6)} ${c.synth}  min ${Number(c.minRatioBps) / 100}%`
      + `  liq ${Number(c.liqThresholdBps) / 100}%  debt ${c.totalDebt}/${c.debtCeiling}`);
  }

  const spent = before - (await provider.getBalance(signer.address));
  console.log(`\nRecorded under \`currency\` in ${path.basename(file)}. Cost ${ethers.formatEther(spent)} tRIEL.`);

  bar("Next");
  console.log(`Restart the app server and open /currency.html.`);
  console.log(``);
  console.log(`The rates now have a liveness duty attached. If nobody republishes within`);
  console.log(`maxAge, minting and liquidation both halt — repaying and withdrawing free`);
  console.log(`collateral keep working, which is the deliberate asymmetry.`);
  console.log(``);
  console.log(`The ceilings above are the real safety control. Raise them only as far as`);
  console.log(`you would trust the published rate to be right.`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
