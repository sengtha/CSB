// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IUniswapV2PairMinimal {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/**
 * @title UniswapV2TwapOracle
 * @notice A MARKET price, derived on chain, to sit beside the administered one.
 *
 * `ReferenceRateOracle` reports what an authority says the rate is. This reports
 * what the chain's own market did. Neither is a substitute for the other, and the
 * point of having both is the gap between them: on a sovereign chain the divergence
 * between an official rate and a traded rate is the monetary question itself, and it
 * can be read directly off the ledger rather than surveyed.
 *
 * It needs no publisher, no off-chain infrastructure and no new trust. Uniswap V2
 * pairs already accumulate a time-weighted price — `price0CumulativeLast` — and the
 * pool this reads was deployed by `scripts/defi-experiment.js` for a different
 * experiment entirely.
 *
 * WHAT IT IS NOT SAFE FOR, stated first because the failure is quiet. A TWAP is
 * only as costly to manipulate as the liquidity behind it. The CSB pool is small, so
 * moving this price is cheap, and a longer window raises the cost of an attack while
 * making the price staler. Do not wire this into a lending market on this chain.
 * It is a measurement instrument here, not a valuation source; §"Where this belongs"
 * in docs/oracle.md says which is which.
 *
 * PRECISION. UQ112x112 truncates, so a quoted price can be up to ONE RAW UNIT of
 * the base token below the exact ratio. With KHRt's two decimals that is 0.01 riel:
 * a pool holding exactly 4,000 KHRt per counterpart token quotes 3,999.99. This is
 * inherent to the fixed-point representation and Uniswap's own oracle has it too. It
 * is a floor, never an overstatement, and it is bounded rather than accumulating.
 *
 * WHY THIS IS NOT UNISWAP'S LIBRARY. The `UniswapV2OracleLibrary` shipped in
 * v2-periphery is written for Solidity <0.8, and its correctness DEPENDS
 * on arithmetic wrapping — its own comments read "subtraction overflow is desired"
 * and "addition overflow is desired". Under 0.8 those operations revert instead of
 * wrapping, so compiling it here would produce a contract that reverts exactly when
 * the accumulator or the uint32 clock wraps: rarely, and long after deployment. The
 * arithmetic below is therefore reimplemented with explicit `unchecked` blocks at the
 * three places where wrapping is intended and nowhere else.
 */
contract UniswapV2TwapOracle {
    IUniswapV2PairMinimal public immutable pair;
    address public immutable token0;
    address public immutable token1;

    /// @notice The asset prices are quoted in. Must be one of the pair's tokens.
    address public immutable BASE_CURRENCY;
    uint256 public immutable BASE_CURRENCY_UNIT;

    /// @notice The other token — the one this oracle actually prices.
    address public immutable quotedAsset;

    uint256 private immutable _quotedUnit; // 10 ** decimals(quotedAsset)
    uint256 private immutable _baseUnit;   // 10 ** decimals(BASE_CURRENCY)

    /// @notice Shortest averaging window. Also prevents a divide-by-zero on same-block updates.
    uint256 public immutable minWindow;

    /// @notice An average older than this stops answering. 0 disables.
    uint256 public immutable maxAge;

    uint256 public priceCumulativeLast;
    uint32 public blockTimestampLast;
    /// @notice Last computed average, as a UQ112x112 fixed-point value.
    uint224 public priceAverage;
    uint64 public updatedAt;

    error NotAPairToken(address asset);
    error WindowTooShort(uint256 elapsed, uint256 required);
    error NoAverageYet();
    error AverageStale(uint64 updatedAt, uint256 maxAge);

    event Updated(uint224 priceAverage, uint256 window, uint256 quotedPrice);

    constructor(
        address pair_,
        address baseCurrency,
        uint256 baseCurrencyUnit,
        uint256 minWindow_,
        uint256 maxAge_
    ) {
        pair = IUniswapV2PairMinimal(pair_);
        token0 = pair.token0();
        token1 = pair.token1();
        if (baseCurrency != token0 && baseCurrency != token1) revert NotAPairToken(baseCurrency);

        BASE_CURRENCY = baseCurrency;
        BASE_CURRENCY_UNIT = baseCurrencyUnit;
        quotedAsset = baseCurrency == token0 ? token1 : token0;
        _quotedUnit = 10 ** IERC20Decimals(quotedAsset).decimals();
        _baseUnit = 10 ** IERC20Decimals(baseCurrency).decimals();
        minWindow = minWindow_;
        maxAge = maxAge_;

        // Seed the accumulator so the first update() has a baseline to average from.
        (uint256 cum, uint32 ts) = _currentCumulative();
        priceCumulativeLast = cum;
        blockTimestampLast = ts;
    }

    /**
     * @notice Fold elapsed time into the average. Permissionless by design — a
     *         trustless price should not depend on a privileged updater.
     * @dev Must be called at least once every `maxAge`, or reads start reverting.
     */
    function update() external {
        (uint256 cum, uint32 ts) = _currentCumulative();

        uint256 elapsed;
        unchecked {
            // INTENDED WRAP (1 of 3): the pair's clock is uint32 and wraps roughly
            // every 136 years. The difference stays correct across the wrap only if
            // it is computed in uint32 without a revert.
            elapsed = uint256(uint32(ts - blockTimestampLast));
        }
        if (elapsed < minWindow || elapsed == 0) revert WindowTooShort(elapsed, minWindow);

        uint224 avg;
        unchecked {
            // INTENDED WRAP (2 of 3): the cumulative accumulator is uint256 and is
            // expected to overflow. Only the difference is meaningful, and it is
            // correct across an overflow provided it is not range-checked.
            avg = uint224((cum - priceCumulativeLast) / elapsed);
        }

        priceCumulativeLast = cum;
        blockTimestampLast = ts;
        priceAverage = avg;
        updatedAt = uint64(block.timestamp);

        emit Updated(avg, elapsed, _quote(avg));
    }

    // ---------------------------------------------------------------- reading

    /**
     * @notice Aave-compatible entry point, so this is swappable with
     *         `ReferenceRateOracle` for comparison. See the safety note at the top
     *         before pointing a real market at it.
     */
    function getAssetPrice(address asset) external view returns (uint256) {
        if (asset == BASE_CURRENCY) return BASE_CURRENCY_UNIT;
        if (asset != quotedAsset) revert NotAPairToken(asset);
        if (priceAverage == 0) revert NoAverageYet();
        if (maxAge != 0 && block.timestamp > uint256(updatedAt) + maxAge) {
            revert AverageStale(updatedAt, maxAge);
        }
        return _quote(priceAverage);
    }

    /// @notice Price and freshness without reverting — for operators and monitoring.
    function describe()
        external
        view
        returns (uint256 price, uint64 lastUpdate, bool stale, bool hasAverage)
    {
        bool has = priceAverage != 0;
        bool isStale = !has || (maxAge != 0 && block.timestamp > uint256(updatedAt) + maxAge);
        return (has ? _quote(priceAverage) : 0, updatedAt, isStale, has);
    }

    /// @notice Seconds since the accumulator was last folded in.
    function timeSinceUpdate() external view returns (uint256) {
        (, uint32 ts) = _currentCumulative();
        unchecked {
            return uint256(uint32(ts - blockTimestampLast));
        }
    }

    // ------------------------------------------------------------------ internals

    /// @dev The average is UQ112x112. Convert to whole-token price in base units.
    function _quote(uint224 avg) private view returns (uint256) {
        // (avg / 2**112) is base-raw-units per quoted-raw-unit. Multiply by one whole
        // quoted token, then rescale from the base token's own decimals to
        // BASE_CURRENCY_UNIT so this matches ReferenceRateOracle's convention.
        uint256 rawPerWhole = (uint256(avg) * _quotedUnit) >> 112;
        return (rawPerWhole * BASE_CURRENCY_UNIT) / _baseUnit;
    }

    /**
     * @dev The pair only folds elapsed time into its accumulator when someone
     *      touches it, so a naive read is stale between trades. This adds the
     *      counterfactual — what the accumulator WOULD be right now — which is what
     *      lets `update()` work without forcing a `sync()`.
     */
    function _currentCumulative() private view returns (uint256 cumulative, uint32 ts) {
        ts = uint32(block.timestamp % 2 ** 32);
        cumulative = BASE_CURRENCY == token1
            ? pair.price0CumulativeLast()
            : pair.price1CumulativeLast();

        (uint112 r0, uint112 r1, uint32 pairTs) = pair.getReserves();
        if (pairTs != ts && r0 != 0 && r1 != 0) {
            unchecked {
                // INTENDED WRAP (3 of 3): same uint32 clock as above, and the
                // addition into the accumulator is expected to overflow.
                uint32 gap = ts - pairTs;
                uint224 instant = BASE_CURRENCY == token1
                    ? _fraction(r1, r0)   // token0 priced in token1
                    : _fraction(r0, r1);  // token1 priced in token0
                cumulative += uint256(instant) * gap;
            }
        }
    }

    /// @dev UQ112x112 fraction, as Uniswap's FixedPoint library computes it.
    function _fraction(uint112 numerator, uint112 denominator) private pure returns (uint224) {
        return uint224((uint224(numerator) << 112) / denominator);
    }
}
