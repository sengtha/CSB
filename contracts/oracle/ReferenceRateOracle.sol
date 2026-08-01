// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title ReferenceRateOracle
 * @notice An OFFICIAL published rate, not a market price.
 *
 * Public-chain oracles aggregate market data because no participant is
 * authoritative. On a sovereign chain the authoritative number for the domestic
 * currency is an administered one: the central bank publishes a daily reference
 * rate, and for a highly dollarized economy that rate is the nominal anchor rather
 * than an observation of trading. So the honest oracle for this chain is one that
 * faithfully reports a published figure and is auditable about where it came from —
 * which is close to the opposite of the manipulation-resistance property a public
 * DeFi oracle optimises for.
 *
 * This is therefore deliberately NOT trustworthy in the DeFi sense. It trusts a
 * publisher completely. What it adds over "an address can set a number" is the
 * discipline that makes an administered rate auditable:
 *
 *   - every publication carries a `sourceRef`, the same on-chain citation pattern
 *     the enforcement contracts use for court orders;
 *   - a rate goes STALE and then stops answering, so a market cannot silently trade
 *     on last week's number;
 *   - a single publication cannot move the rate more than a bounded amount, so one
 *     compromised or mistaken post cannot reprice the system;
 *   - publishing and governing the bounds are separate roles, so the publisher
 *     cannot widen its own limits.
 *
 * DROP-IN FOR AAVE. Implements `getAssetPrice`, `BASE_CURRENCY` and
 * `BASE_CURRENCY_UNIT`, so it replaces Aave's test `PriceOracle` by pointing
 * `PoolAddressesProvider.setPriceOracle` at it. Nothing in Aave changes.
 *
 * IT FAILS CLOSED, AND THAT IS A CHOICE WITH A COST. When a rate is unset or stale,
 * `getAssetPrice` REVERTS rather than returning a last-known value. A lending market
 * reading a stale price is worse than one that halts, so halting is right — but it
 * means the chain's credit machinery stops if the publisher stops, which converts an
 * administrative duty into a liveness dependency. `isStale` and `lastUpdate` are
 * exposed so that duty can be monitored rather than discovered during an outage.
 */
contract ReferenceRateOracle is AccessControl {
    /// @notice May publish rates. Held by the rate-publishing authority, not the council.
    bytes32 public constant RATE_PUBLISHER_ROLE = keccak256("RATE_PUBLISHER_ROLE");

    struct Rate {
        uint256 price;       // denominated in BASE_CURRENCY_UNIT
        uint64 publishedAt;  // block timestamp of the publication
        bytes32 sourceRef;   // citation for the official figure this reports
    }

    mapping(address => Rate) private _rates;

    /// @notice The unit prices are quoted in. Mirrors Aave's oracle interface.
    address public immutable BASE_CURRENCY;
    uint256 public immutable BASE_CURRENCY_UNIT;

    /// @notice A rate older than this stops answering. Seconds.
    uint256 public maxAge;

    /// @notice Largest single-publication move, in basis points. 0 disables the bound.
    uint256 public maxDeviationBps;

    error RateNotSet(address asset);
    error RateStale(address asset, uint64 publishedAt, uint256 maxAge);
    error DeviationTooLarge(address asset, uint256 previous, uint256 proposed, uint256 maxBps);
    error InvalidPrice();
    error SourceRefRequired();

    event RatePublished(
        address indexed asset, uint256 price, uint256 previous, bytes32 indexed sourceRef, address indexed publisher
    );
    event RateCleared(address indexed asset, bytes32 indexed reason);
    event BoundsChanged(uint256 maxAge, uint256 maxDeviationBps);

    constructor(
        address council,
        address publisher,
        address baseCurrency,
        uint256 baseCurrencyUnit,
        uint256 maxAge_,
        uint256 maxDeviationBps_
    ) {
        BASE_CURRENCY = baseCurrency;
        BASE_CURRENCY_UNIT = baseCurrencyUnit;
        maxAge = maxAge_;
        maxDeviationBps = maxDeviationBps_;
        _grantRole(DEFAULT_ADMIN_ROLE, council);
        _grantRole(RATE_PUBLISHER_ROLE, publisher);
    }

    // ------------------------------------------------------------- publishing

    /**
     * @notice Publish the official rate for an asset.
     * @param sourceRef Citation for the figure being reported — a hash of the
     *        publication it comes from. Required, for the same reason an
     *        enforcement action requires an order reference: an administered number
     *        with no stated source is indistinguishable from an invented one.
     */
    function publish(address asset, uint256 price, bytes32 sourceRef)
        external
        onlyRole(RATE_PUBLISHER_ROLE)
    {
        if (price == 0) revert InvalidPrice();
        if (sourceRef == bytes32(0)) revert SourceRefRequired();

        Rate storage r = _rates[asset];
        uint256 previous = r.price;

        // The bound applies only once a rate exists — the first publication has
        // nothing to deviate from, and bounding it would make the oracle
        // uninitialisable.
        if (previous != 0 && maxDeviationBps != 0) {
            uint256 diff = price > previous ? price - previous : previous - price;
            if (diff * 10_000 > previous * maxDeviationBps) {
                revert DeviationTooLarge(asset, previous, price, maxDeviationBps);
            }
        }

        r.price = price;
        r.publishedAt = uint64(block.timestamp);
        r.sourceRef = sourceRef;
        emit RatePublished(asset, price, previous, sourceRef, msg.sender);
    }

    /**
     * @notice Withdraw a rate, so the oracle stops answering for that asset.
     * @dev The council's circuit breaker. Note what it does downstream: any market
     *      reading this asset halts. That is the intended severity — a rate the
     *      council no longer stands behind should stop being used, not degrade
     *      quietly — but it is a power to halt a market, held by the council, and
     *      should be read alongside the egress circuit breaker rather than as a
     *      routine maintenance function.
     */
    function clear(address asset, bytes32 reason) external onlyRole(DEFAULT_ADMIN_ROLE) {
        delete _rates[asset];
        emit RateCleared(asset, reason);
    }

    /// @notice Council-only. The publisher deliberately cannot widen its own bounds.
    function setBounds(uint256 maxAge_, uint256 maxDeviationBps_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        maxAge = maxAge_;
        maxDeviationBps = maxDeviationBps_;
        emit BoundsChanged(maxAge_, maxDeviationBps_);
    }

    // ---------------------------------------------------------------- reading

    /**
     * @notice Aave's oracle entry point. Reverts when unset or stale.
     * @dev Fails closed on purpose. See the contract-level note: a market that
     *      halts is preferable to one trading on a number nobody is standing behind,
     *      and the cost is a liveness dependency on the publisher.
     */
    function getAssetPrice(address asset) external view returns (uint256) {
        Rate storage r = _rates[asset];
        if (r.price == 0) revert RateNotSet(asset);
        if (maxAge != 0 && block.timestamp > uint256(r.publishedAt) + maxAge) {
            revert RateStale(asset, r.publishedAt, maxAge);
        }
        return r.price;
    }

    /// @notice Everything about a rate, without reverting — for operators and monitoring.
    function describe(address asset)
        external
        view
        returns (uint256 price, uint64 publishedAt, bytes32 sourceRef, bool stale)
    {
        Rate storage r = _rates[asset];
        return (r.price, r.publishedAt, r.sourceRef, _isStale(r));
    }

    /// @notice True when `getAssetPrice` would refuse. Monitor this, not the price.
    function isStale(address asset) external view returns (bool) {
        return _isStale(_rates[asset]);
    }

    function lastUpdate(address asset) external view returns (uint64) {
        return _rates[asset].publishedAt;
    }

    function _isStale(Rate storage r) private view returns (bool) {
        if (r.price == 0) return true;
        if (maxAge == 0) return false;
        return block.timestamp > uint256(r.publishedAt) + maxAge;
    }
}
