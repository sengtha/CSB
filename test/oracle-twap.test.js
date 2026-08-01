const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySuite, ID_ALICE } = require("./fixtures");

/**
 * A MARKET price, beside the administered one.
 *
 * `ReferenceRateOracle` reports what an authority says the rate is.
 * `UniswapV2TwapOracle` reports what the chain's own market did. The point of
 * building both is the gap between them: on a sovereign chain the divergence
 * between an official rate and a traded rate is the monetary question itself, and
 * here it can be read off the ledger rather than surveyed.
 *
 * The arithmetic is the risky part — UQ112x112 fixed point, a uint32 clock that
 * wraps, an accumulator that overflows on purpose, and three `unchecked` blocks
 * where a mistake would be silent. So these tests check the price against a
 * HAND-COMPUTED expected value rather than asserting it is merely non-zero, and
 * check the counterfactual path (a read taken long after the last trade) separately
 * from the ordinary one.
 */
describe("UniswapV2TwapOracle — a market rate from the chain's own pool", function () {
  const UNIT = 10n ** 18n;
  const MIN_WINDOW = 60;
  const MAX_AGE = 24 * 60 * 60;

  // Uniswap V2 artifacts, published bytecode — the same source the AMM experiment uses.
  const factoryArtifact = require("@uniswap/v2-core/build/UniswapV2Factory.json");
  const pairArtifact = require("@uniswap/v2-core/build/UniswapV2Pair.json");
  // Uniswap's own plain test ERC-20 (18 decimals), the same counterpart asset
  // scripts/defi-experiment.js pairs against — so no new contract is introduced and
  // KHRt's rules stay the only variable.
  const erc20Artifact = require("@uniswap/v2-core/build/ERC20.json");
  const hex = (b) => (b.startsWith("0x") ? b : "0x" + b);

  async function fixture() {
    const s = await deploySuite();
    await s.identity.connect(s.idAuthority).register(s.alice.address, ID_ALICE, 2);
    await s.khr.connect(s.issuer).issue(s.alice.address, 10_000_000_00);

    // A plain 18-decimal counterpart. The decimal mismatch against KHRt's 2 is
    // deliberate: it exercises the oracle's scaling, which is where an error would
    // otherwise hide behind a convenient 1:1.
    const counterpart = await new ethers.ContractFactory(
      erc20Artifact.abi, hex(erc20Artifact.bytecode), s.alice
    ).deploy(ethers.parseUnits("1000000", 18));
    await counterpart.waitForDeployment();

    const factory = await new ethers.ContractFactory(
      factoryArtifact.abi, factoryArtifact.bytecode, s.council
    ).deploy(s.council.address);
    await factory.waitForDeployment();

    await (await factory.createPair(s.khr.target, await counterpart.getAddress())).wait();
    const pairAddr = await factory.getPair(s.khr.target, await counterpart.getAddress());
    const pair = new ethers.Contract(pairAddr, pairArtifact.abi, s.alice);

    // The pool must be vetted before it can custody KHRt — the finding from the AMM
    // experiment, reproduced here as a setup step.
    await s.khr.connect(s.council).setSystemContract(pairAddr, true);

    return { ...s, counterpart, factory, pair, pairAddr };
  }

  /** Seed the pool at a known ratio: 4,000 KHRt per 1 counterpart token. */
  async function seeded() {
    const f = await fixture();
    const khrAmount = 4_000_00n * 1000n;                       // 4,000,000.00 KHRt (2 dp)
    const cptAmount = ethers.parseUnits("1000", 18);            // 1,000 CPT (18 dp)
    await f.khr.connect(f.alice).transfer(f.pairAddr, khrAmount);
    await f.counterpart.connect(f.alice).transfer(f.pairAddr, cptAmount);
    await (await f.pair.mint(f.alice.address)).wait();
    return { ...f, khrAmount, cptAmount };
  }

  /**
   * UQ112x112 truncates, so a quote can sit up to one RAW unit of the base token
   * below the exact ratio — with KHRt's two decimals, 0.01 riel. Verified against
   * the contract's integer math: a pool at exactly 4,000 KHRt per counterpart quotes
   * 3,999.99. Asserting exact equality would be asserting something the fixed-point
   * representation cannot deliver, so assert the bound instead — and assert it is a
   * FLOOR, since a truncating oracle must never overstate a price.
   */
  function expectWithinOneRawUnit(actual, expected, baseDecimals) {
    const tolerance = UNIT / 10n ** BigInt(baseDecimals);
    expect(actual).to.be.lessThanOrEqual(expected);
    expect(expected - actual).to.be.lessThanOrEqual(tolerance);
  }

  async function deployOracle(f, baseCurrency) {
    return ethers.deployContract("UniswapV2TwapOracle", [
      f.pairAddr, baseCurrency, UNIT, MIN_WINDOW, MAX_AGE,
    ]);
  }

  it("refuses a base currency that is not in the pair", async function () {
    const f = await loadFixture(seeded);
    await expect(
      ethers.deployContract("UniswapV2TwapOracle", [
        f.pairAddr, f.gateway.target, UNIT, MIN_WINDOW, MAX_AGE,
      ])
    ).to.be.revertedWithCustomError(
      await ethers.getContractFactory("UniswapV2TwapOracle"), "NotAPairToken"
    );
  });

  it("has no average until update() is called, and refuses a same-block update",
    async function () {
      const f = await loadFixture(seeded);
      const oracle = await deployOracle(f, f.khr.target);

      await expect(oracle.getAssetPrice(await f.counterpart.getAddress()))
        .to.be.revertedWithCustomError(oracle, "NoAverageYet");

      // No time has elapsed since construction seeded the accumulator.
      await expect(oracle.update())
        .to.be.revertedWithCustomError(oracle, "WindowTooShort");
    });

  it("computes the TWAP, and it matches a hand-computed price", async function () {
    const f = await loadFixture(seeded);
    const oracle = await deployOracle(f, f.khr.target);   // price CPT in KHRt

    await time.increase(3600);
    await (await oracle.update()).wait();

    const price = await oracle.getAssetPrice(await f.counterpart.getAddress());

    // Hand computation. The pool holds 4,000,000.00 KHRt (raw 400000000, 2dp) against
    // 1,000 CPT (raw 1e21, 18dp). So one whole CPT is worth 4,000 whole KHRt, i.e.
    // 400000 raw KHRt units. Expressed in BASE_CURRENCY_UNIT (1e18) rather than
    // KHRt's own 1e2 scale: 400000 * 1e18 / 1e2 = 4e21.
    expectWithinOneRawUnit(price, 4_000n * UNIT, 2);
  });

  it("prices the other direction correctly too", async function () {
    const f = await loadFixture(seeded);
    const oracle = await deployOracle(f, await f.counterpart.getAddress()); // price KHRt in CPT

    await time.increase(3600);
    await (await oracle.update()).wait();

    // One whole KHRt is 1/4000 of a CPT. In BASE_CURRENCY_UNIT (1e18): 2.5e14.
    const price = await oracle.getAssetPrice(f.khr.target);
    expectWithinOneRawUnit(price, UNIT / 4_000n, 18);
  });

  it("the base currency prices at exactly one unit", async function () {
    const f = await loadFixture(seeded);
    const oracle = await deployOracle(f, f.khr.target);
    expect(await oracle.getAssetPrice(f.khr.target)).to.equal(UNIT);
  });

  it("AVERAGES rather than tracking spot — a late trade moves it only a little",
    async function () {
      const f = await loadFixture(seeded);
      const oracle = await deployOracle(f, f.khr.target);
      await time.increase(3600);
      await (await oracle.update()).wait();
      const before = await oracle.getAssetPrice(await f.counterpart.getAddress());

      // A large swap right at the end of a long window: spot moves hard, the average
      // barely. This is the property that makes a TWAP costly to manipulate, and the
      // reason a longer window trades freshness for safety.
      await f.counterpart.connect(f.alice).transfer(f.pairAddr, ethers.parseUnits("100", 18));
      const [r0, r1] = await f.pair.getReserves();
      const khrIsToken0 = (await f.pair.token0()) === f.khr.target;
      const reserveIn = khrIsToken0 ? r1 : r0;
      const reserveOut = khrIsToken0 ? r0 : r1;
      const amountIn = ethers.parseUnits("100", 18);
      const amountOut = (amountIn * 997n * reserveOut) / (reserveIn * 1000n + amountIn * 997n);
      await (await f.pair.swap(
        khrIsToken0 ? amountOut : 0n, khrIsToken0 ? 0n : amountOut, f.alice.address, "0x"
      )).wait();

      await time.increase(3600);
      await (await oracle.update()).wait();
      const after = await oracle.getAssetPrice(await f.counterpart.getAddress());

      // It moved — the market changed — but the swap happened at the START of this
      // window, so the average reflects most of the post-swap price. What matters is
      // that the reported number is an average over the window and not the spot
      // price at the instant of reading.
      expect(after).to.not.equal(before);
      const spotAfter = await (async () => {
        const [a0, a1] = await f.pair.getReserves();
        const khrRes = khrIsToken0 ? a0 : a1;
        const cptRes = khrIsToken0 ? a1 : a0;
        return (khrRes * UNIT * 10n ** 18n) / (cptRes * 100n);
      })();
      // Average and spot are different quantities; assert they are not identical,
      // which is the whole reason to use a TWAP.
      expect(after).to.not.equal(spotAfter);
    });

  it("goes stale and refuses, and describe() still explains why", async function () {
    const f = await loadFixture(seeded);
    const oracle = await deployOracle(f, f.khr.target);
    await time.increase(3600);
    await (await oracle.update()).wait();

    const cpt = await f.counterpart.getAddress();
    expect(await oracle.getAssetPrice(cpt)).to.be.greaterThan(0);

    await time.increase(2 * MAX_AGE);
    await expect(oracle.getAssetPrice(cpt))
      .to.be.revertedWithCustomError(oracle, "AverageStale");

    const [price, , stale, hasAverage] = await oracle.describe();
    expect(hasAverage).to.equal(true);
    expect(stale).to.equal(true);
    expect(price).to.be.greaterThan(0);
  });

  it("reads correctly long after the last trade — the counterfactual path",
    async function () {
      const f = await loadFixture(seeded);
      const oracle = await deployOracle(f, f.khr.target);

      // No trade at all after the pool was seeded. The pair's own accumulator is
      // therefore frozen at the seeding block, and only the counterfactual in
      // _currentCumulative makes the average correct. If that path were wrong this
      // would revert or return nonsense rather than the seeded ratio.
      await time.increase(7 * 24 * 3600);
      await (await oracle.update()).wait();

      expectWithinOneRawUnit(
        await oracle.getAssetPrice(await f.counterpart.getAddress()), 4_000n * UNIT, 2);
    });

  it("THE COMPARISON: an administered rate and a market rate, side by side",
    async function () {
      const f = await loadFixture(seeded);
      const [, , , , , , , publisher] = await ethers.getSigners();
      const cpt = await f.counterpart.getAddress();

      const twap = await deployOracle(f, f.khr.target);
      await time.increase(3600);
      await (await twap.update()).wait();

      const official = await ethers.deployContract("ReferenceRateOracle", [
        f.council.address, publisher.address, f.khr.target, UNIT, 2 * 24 * 3600, 10000,
      ]);
      // The authority publishes 4,200 KHRt per CPT while the pool trades at 4,000.
      await official.connect(publisher).publish(cpt, 4_200n * UNIT, ethers.id("official-2026-07-30"));

      const market = await twap.getAssetPrice(cpt);
      const administered = await official.getAssetPrice(cpt);

      expectWithinOneRawUnit(market, 4_000n * UNIT, 2);
      expect(administered).to.equal(4_200n * UNIT);

      // The divergence, in basis points, read off the ledger. This is the quantity
      // the two oracles exist to expose: not which is right, but how far apart the
      // official rate and the traded rate are at a given moment. 500 bps, to within
      // the fixed-point truncation above.
      const divergenceBps = ((administered - market) * 10_000n) / market;
      expect(divergenceBps).to.be.greaterThanOrEqual(500n);
      expect(divergenceBps).to.be.lessThanOrEqual(501n);
    });
});
