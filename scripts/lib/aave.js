const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Deploy a minimal but REAL Aave V3 market from the published upstream
 * artifacts, with no source modification.
 *
 * Unmodified means unmodified: every byte here comes from @aave/core-v3's
 * shipped `artifacts/` directory. Nothing is recompiled and no contract is
 * forked to be compliance-aware — the point of the experiment is what a stock
 * lending protocol does when it meets a token that enforces its own rules.
 *
 * Two things make this longer than the Uniswap equivalent, and both are Aave's
 * design rather than accidental complexity:
 *
 *   LIBRARIES. Pool exceeds the contract size limit on its own, so its logic
 *   lives in seven external libraries that must be deployed first and linked
 *   into the bytecode. PoolConfigurator needs an eighth.
 *
 *   PROXIES. Pool and PoolConfigurator are deployed as implementations and then
 *   handed to PoolAddressesProvider, which puts them behind proxies. The address
 *   you actually call is the proxy's, not the implementation's — using the
 *   implementation address directly appears to work and then reverts on any
 *   state-touching call, because the implementation's storage is empty.
 *
 * The oracle is Aave's own `PriceOracle` test contract, whose prices are set by
 * hand. That is a legitimate substitute on a chain with no price feeds, but it
 * is a substitute: no conclusion here should be read as saying anything about
 * the safety of the resulting market.
 */
const B = path.join(__dirname, "..", "..", "node_modules", "@aave", "core-v3", "artifacts", "contracts");
// (scripts/lib -> repo root is two levels up, same as the old test/helpers path.)

const A = {
  SupplyLogic: "/protocol/libraries/logic/SupplyLogic.sol/SupplyLogic.json",
  BorrowLogic: "/protocol/libraries/logic/BorrowLogic.sol/BorrowLogic.json",
  LiquidationLogic: "/protocol/libraries/logic/LiquidationLogic.sol/LiquidationLogic.json",
  EModeLogic: "/protocol/libraries/logic/EModeLogic.sol/EModeLogic.json",
  BridgeLogic: "/protocol/libraries/logic/BridgeLogic.sol/BridgeLogic.json",
  FlashLoanLogic: "/protocol/libraries/logic/FlashLoanLogic.sol/FlashLoanLogic.json",
  PoolLogic: "/protocol/libraries/logic/PoolLogic.sol/PoolLogic.json",
  ConfiguratorLogic: "/protocol/libraries/logic/ConfiguratorLogic.sol/ConfiguratorLogic.json",
  PoolAddressesProvider: "/protocol/configuration/PoolAddressesProvider.sol/PoolAddressesProvider.json",
  ACLManager: "/protocol/configuration/ACLManager.sol/ACLManager.json",
  Pool: "/protocol/pool/Pool.sol/Pool.json",
  PoolConfigurator: "/protocol/pool/PoolConfigurator.sol/PoolConfigurator.json",
  AToken: "/protocol/tokenization/AToken.sol/AToken.json",
  StableDebtToken: "/protocol/tokenization/StableDebtToken.sol/StableDebtToken.json",
  VariableDebtToken: "/protocol/tokenization/VariableDebtToken.sol/VariableDebtToken.json",
  IRS: "/protocol/pool/DefaultReserveInterestRateStrategy.sol/DefaultReserveInterestRateStrategy.json",
  PriceOracle: "/mocks/oracle/PriceOracle.sol/PriceOracle.json",
};

const art = (k) => JSON.parse(fs.readFileSync(B + A[k], "utf8"));
const hex = (b) => (b.startsWith("0x") ? b : "0x" + b);

async function deploy(key, args = [], signer, libs = {}) {
  const a = art(key);
  let bytecode = hex(a.bytecode);
  // Link libraries by placeholder. The placeholder is keccak256 of the library's
  // fully-qualified name, truncated — resolvable from the artifact's linkReferences
  // rather than hardcoded, so a version bump does not silently produce unlinked
  // bytecode that deploys and then reverts on first use.
  for (const [file, entries] of Object.entries(a.linkReferences ?? {})) {
    for (const name of Object.keys(entries)) {
      const addr = libs[name];
      if (!addr) throw new Error(`${key} needs library ${name} (${file}) and none was supplied`);
      for (const { start, length } of entries[name]) {
        const s = 2 + start * 2;
        bytecode = bytecode.slice(0, s) + addr.slice(2).toLowerCase() + bytecode.slice(s + length * 2);
      }
    }
  }
  if (bytecode.includes("__$")) throw new Error(`${key} still has unlinked libraries`);
  const f = new ethers.ContractFactory(a.abi, bytecode, signer);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return c;
}

const at = (key, address, signer) => new ethers.Contract(address, art(key).abi, signer);

/** Ray/percentage constants Aave expects, spelled out rather than magic. */
const RAY = 10n ** 27n;
const pct = (n) => BigInt(Math.round(n * 100)); // 80 -> 8000 basis points

/**
 * @param owner        signer that becomes market admin
 * @param underlying   the ERC-20 to list as a reserve (KHRt here)
 * @param decimals     that token's decimals
 */
async function deployAaveMarket(owner, underlying, decimals) {
  // 1. libraries
  const libNames = ["SupplyLogic", "BorrowLogic", "LiquidationLogic", "EModeLogic",
    "BridgeLogic", "FlashLoanLogic", "PoolLogic", "ConfiguratorLogic"];
  const libs = {};
  for (const n of libNames) libs[n] = await (await deploy(n, [], owner, libs)).getAddress();

  // 2. addresses provider + access control
  const provider = await deploy("PoolAddressesProvider", ["CSB", owner.address], owner);
  await (await provider.setACLAdmin(owner.address)).wait();
  const acl = await deploy("ACLManager", [await provider.getAddress()], owner);
  await (await provider.setACLManager(await acl.getAddress())).wait();
  await (await acl.addPoolAdmin(owner.address)).wait();
  await (await acl.addEmergencyAdmin(owner.address)).wait();

  // 3. Pool and PoolConfigurator, behind the provider's proxies
  const poolImpl = await deploy("Pool", [await provider.getAddress()], owner, libs);
  await (await poolImpl.initialize(await provider.getAddress())).wait();
  await (await provider.setPoolImpl(await poolImpl.getAddress())).wait();
  const pool = at("Pool", await provider.getPool(), owner);

  const confImpl = await deploy("PoolConfigurator", [], owner, libs);
  await (await confImpl.initialize(await provider.getAddress())).wait();
  await (await provider.setPoolConfiguratorImpl(await confImpl.getAddress())).wait();
  const configurator = at("PoolConfigurator", await provider.getPoolConfigurator(), owner);

  // 4. oracle — hand-set prices, see the note at the top of this file
  const oracle = await deploy("PriceOracle", [], owner);
  await (await oracle.setAssetPrice(underlying, ethers.parseUnits("1", 18))).wait();
  await (await provider.setPriceOracle(await oracle.getAddress())).wait();

  // 5. interest rate strategy — ordinary stablecoin-ish curve
  const irs = await deploy("IRS", [
    await provider.getAddress(),
    (RAY * 80n) / 100n,  // optimal usage 80%
    0n,                  // base variable borrow rate
    (RAY * 4n) / 100n,   // variable slope 1
    (RAY * 75n) / 100n,  // variable slope 2
    (RAY * 5n) / 100n,   // stable slope 1
    (RAY * 75n) / 100n,  // stable slope 2
    (RAY * 2n) / 100n,   // base stable rate offset
    (RAY * 8n) / 100n,   // stable rate excess offset
    (RAY * 20n) / 100n,  // optimal stable-to-total debt ratio
  ], owner);

  // 6. token implementations
  const poolAddr = await pool.getAddress();
  const aTokenImpl = await deploy("AToken", [poolAddr], owner);
  const sdtImpl = await deploy("StableDebtToken", [poolAddr], owner);
  const vdtImpl = await deploy("VariableDebtToken", [poolAddr], owner);

  // 7. list the reserve
  await (await configurator.initReserves([{
    aTokenImpl: await aTokenImpl.getAddress(),
    stableDebtTokenImpl: await sdtImpl.getAddress(),
    variableDebtTokenImpl: await vdtImpl.getAddress(),
    underlyingAssetDecimals: decimals,
    interestRateStrategyAddress: await irs.getAddress(),
    underlyingAsset: underlying,
    treasury: owner.address,
    incentivesController: ethers.ZeroAddress,
    aTokenName: "Aave CSB KHRt",
    aTokenSymbol: "aKHRt",
    variableDebtTokenName: "Aave CSB Variable Debt KHRt",
    variableDebtTokenSymbol: "variableDebtKHRt",
    stableDebtTokenName: "Aave CSB Stable Debt KHRt",
    stableDebtTokenSymbol: "stableDebtKHRt",
    params: "0x",
  }])).wait();

  // 8. make it usable: collateral parameters, borrowing on, not frozen
  await (await configurator.configureReserveAsCollateral(
    underlying, pct(75), pct(80), pct(105))).wait();   // LTV, liq threshold, liq bonus
  await (await configurator.setReserveBorrowing(underlying, true)).wait();
  await (await configurator.setReserveActive(underlying, true)).wait();

  const data = await pool.getReserveData(underlying);
  return {
    provider, acl, pool, configurator, oracle, irs, libs,
    aToken: at("AToken", data.aTokenAddress, owner),
    variableDebt: at("VariableDebtToken", data.variableDebtTokenAddress, owner),
    stableDebt: at("StableDebtToken", data.stableDebtTokenAddress, owner),
  };
}

module.exports = { deployAaveMarket, deploy, at, art, A, B };
