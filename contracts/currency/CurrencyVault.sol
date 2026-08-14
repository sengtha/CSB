// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {SyntheticCurrency} from "./SyntheticCurrency.sol";

interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// The administered rate oracle: price of an asset expressed in riel.
interface IRateSource {
    function getAssetPrice(address asset) external view returns (uint256);
    function BASE_CURRENCY_UNIT() external view returns (uint256);
}

/**
 * Lock riel, mint a foreign currency against it. Many currencies, one vault.
 *
 * This is the origination CSB did not have. Until now the only dollar on the
 * chain was minted from nothing by a test token anybody could call, which made
 * its supply arbitrary and every price derived from it meaningless. Here every
 * unit of khUSD, khJPY or khEUR that exists is backed by KHRt locked in this
 * contract at a stated ratio, and the backing is arithmetic anyone can recheck
 * rather than a claim anyone has to believe.
 *
 * WHY RIEL IS THE COLLATERAL AND NOT THE OTHER WAY AROUND. Every design of this
 * shape elsewhere locks dollars to mint something local. Doing it in reverse is
 * the whole point of a sovereign chain: the riel is base money here, and foreign
 * currency is the derived, collateralised, capped thing. That inversion is a
 * claim CSB can make and a chain settling in USDC cannot.
 *
 * IT IS THE SAME SHAPE AS RielConverter, PLUS A PRICE. The converter locks KHRt
 * and mints tRIEL one-for-one; with no exchange rate there is no way to become
 * undercollateralised and nothing to liquidate. Add a rate between two different
 * currencies and you get price risk, which is why this needs ratios, a
 * liquidation path, and a ceiling. Everything below follows from that one
 * difference.
 *
 * WHAT MAKES IT SAFE IS THE CEILING, NOT THE RATIO.
 *
 * A collateral ratio protects against a price that MOVES. It does nothing about
 * a price that is WRONG, and CSB's rates are published by a role, against thin
 * markets — docs/architecture.md is explicit that they are instrumentation, not
 * valuation. So each currency carries a hard debt ceiling: whatever the oracle
 * says, the chain cannot issue more than a stated amount of any currency. That
 * bounds the damage from a bad rate in a way no ratio can, and it is the control
 * to reach for first if this is ever pointed at something that matters.
 *
 * FAILING CLOSED, AND WHAT IT COSTS. The rate source reverts when a price is
 * stale, so minting and withdrawing collateral stop when nobody is republishing.
 * That is right. But liquidation stops too — an underwater position cannot be
 * closed while the oracle is silent, so an outage freezes bad debt in place
 * instead of clearing it. Repaying is deliberately the one operation that never
 * consults the price: reducing your own risk must never be blocked by the thing
 * that made you risky.
 */
contract CurrencyVault is AccessControl {
    bytes32 public constant CURRENCY_ADMIN_ROLE = keccak256("CURRENCY_ADMIN_ROLE");

    uint256 private constant BPS = 10_000;

    struct Currency {
        SyntheticCurrency synth;
        uint8 synthDecimals;
        uint16 minRatioBps;        // required after minting or withdrawing
        uint16 liqThresholdBps;    // below this, anyone may liquidate
        uint16 liqPenaltyBps;      // extra collateral the liquidator receives
        uint256 debtCeiling;       // hard cap on totalDebt, in synth minor units
        uint256 totalDebt;
        bool mintingPaused;
    }

    struct Position {
        uint256 collateral;        // KHRt minor units
        uint256 debt;              // synth minor units
    }

    IERC20Minimal public immutable collateralToken;   // KHRt
    uint8 public immutable collateralDecimals;
    IRateSource public rates;

    Currency[] private _currencies;
    /// currencyId => owner => position
    mapping(uint256 => mapping(address => Position)) private _positions;

    uint256 private _entered;

    event CurrencyAdded(uint256 indexed id, address indexed synth, string symbol);
    event CurrencyConfigured(uint256 indexed id, uint16 minRatioBps, uint16 liqThresholdBps,
        uint16 liqPenaltyBps, uint256 debtCeiling, bool mintingPaused);
    event RatesChanged(address indexed rates);
    event Deposited(uint256 indexed id, address indexed who, uint256 amount);
    event Withdrawn(uint256 indexed id, address indexed who, uint256 amount);
    event Minted(uint256 indexed id, address indexed who, uint256 amount);
    event Repaid(uint256 indexed id, address indexed who, uint256 amount);
    event Liquidated(uint256 indexed id, address indexed who, address indexed by,
        uint256 debtRepaid, uint256 collateralSeized);

    error Reentrant();
    error NoSuchCurrency();
    error BadParameters();
    error MintingPaused();
    error DebtCeilingReached(uint256 ceiling, uint256 wouldBe);
    error Undercollateralised(uint256 ratioBps, uint256 requiredBps);
    error NotLiquidatable(uint256 ratioBps, uint256 thresholdBps);
    error NothingToDo();
    error RepayExceedsDebt(uint256 debt, uint256 offered);
    error InsufficientCollateral(uint256 held, uint256 requested);
    error TransferFailed();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrant();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address collateral_, address rates_, address admin) {
        collateralToken = IERC20Minimal(collateral_);
        collateralDecimals = IERC20Minimal(collateral_).decimals();
        rates = IRateSource(rates_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CURRENCY_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------- administration

    /**
     * Register a currency. The synth must already name this vault as its issuer,
     * which is checked here rather than assumed — a synth pointing at a different
     * vault would accept no mint from this one, and the failure would surface at
     * a user's first attempt rather than at registration.
     */
    function addCurrency(
        SyntheticCurrency synth,
        uint16 minRatioBps,
        uint16 liqThresholdBps,
        uint16 liqPenaltyBps,
        uint256 debtCeiling
    ) external onlyRole(CURRENCY_ADMIN_ROLE) returns (uint256 id) {
        if (synth.vault() != address(this)) revert BadParameters();
        _checkParams(minRatioBps, liqThresholdBps, liqPenaltyBps);

        _currencies.push(Currency({
            synth: synth,
            synthDecimals: synth.decimals(),
            minRatioBps: minRatioBps,
            liqThresholdBps: liqThresholdBps,
            liqPenaltyBps: liqPenaltyBps,
            debtCeiling: debtCeiling,
            totalDebt: 0,
            mintingPaused: false
        }));
        id = _currencies.length - 1;
        emit CurrencyAdded(id, address(synth), synth.symbol());
        emit CurrencyConfigured(id, minRatioBps, liqThresholdBps, liqPenaltyBps, debtCeiling, false);
    }

    function configureCurrency(
        uint256 id,
        uint16 minRatioBps,
        uint16 liqThresholdBps,
        uint16 liqPenaltyBps,
        uint256 debtCeiling,
        bool mintingPaused
    ) external onlyRole(CURRENCY_ADMIN_ROLE) {
        Currency storage c = _at(id);
        _checkParams(minRatioBps, liqThresholdBps, liqPenaltyBps);
        c.minRatioBps = minRatioBps;
        c.liqThresholdBps = liqThresholdBps;
        c.liqPenaltyBps = liqPenaltyBps;
        c.debtCeiling = debtCeiling;
        c.mintingPaused = mintingPaused;
        emit CurrencyConfigured(id, minRatioBps, liqThresholdBps, liqPenaltyBps, debtCeiling, mintingPaused);
    }

    function setRates(address rates_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        rates = IRateSource(rates_);
        emit RatesChanged(rates_);
    }

    function _checkParams(uint16 minRatioBps, uint16 liqThresholdBps, uint16 liqPenaltyBps) private pure {
        // The liquidation threshold must sit BELOW the minting ratio, or a
        // position would be liquidatable at the instant it was opened — legal
        // arithmetic that makes the product unusable, so it is refused here.
        if (liqThresholdBps < BPS || liqThresholdBps >= minRatioBps) revert BadParameters();
        if (liqPenaltyBps > 5_000) revert BadParameters();
    }

    // ------------------------------------------------------------------ positions

    function deposit(uint256 id, uint256 amount) public nonReentrant {
        _at(id);
        if (amount == 0) revert NothingToDo();
        // Measured, not assumed: KHRt's levy means less can arrive than was sent,
        // and crediting the requested amount would book collateral this contract
        // does not hold.
        uint256 before = collateralToken.balanceOf(address(this));
        if (!collateralToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        uint256 received = collateralToken.balanceOf(address(this)) - before;
        if (received == 0) revert NothingToDo();

        _positions[id][msg.sender].collateral += received;
        emit Deposited(id, msg.sender, received);
    }

    function mint(uint256 id, uint256 amount) public nonReentrant {
        Currency storage c = _at(id);
        if (c.mintingPaused) revert MintingPaused();
        if (amount == 0) revert NothingToDo();

        uint256 wouldBe = c.totalDebt + amount;
        if (wouldBe > c.debtCeiling) revert DebtCeilingReached(c.debtCeiling, wouldBe);

        Position storage p = _positions[id][msg.sender];
        p.debt += amount;
        c.totalDebt = wouldBe;

        uint256 ratio = _ratioBps(id, p.collateral, p.debt);
        if (ratio < c.minRatioBps) revert Undercollateralised(ratio, c.minRatioBps);

        c.synth.mint(msg.sender, amount);
        emit Minted(id, msg.sender, amount);
    }

    /// Deposit and mint together — the ordinary case, in one confirmation.
    function open(uint256 id, uint256 collateral, uint256 debt) external {
        deposit(id, collateral);
        mint(id, debt);
    }

    /**
     * Burn synth to reduce debt.
     *
     * Never consults the price. Reducing your own risk must not be blocked by a
     * stale oracle — that would be the one moment the mechanism refuses the one
     * action that helps.
     */
    function repay(uint256 id, uint256 amount) public nonReentrant {
        Currency storage c = _at(id);
        Position storage p = _positions[id][msg.sender];
        if (amount == 0) revert NothingToDo();
        if (amount > p.debt) revert RepayExceedsDebt(p.debt, amount);

        p.debt -= amount;
        c.totalDebt -= amount;
        c.synth.burn(msg.sender, amount);
        emit Repaid(id, msg.sender, amount);
    }

    function withdraw(uint256 id, uint256 amount) public nonReentrant {
        Currency storage c = _at(id);
        Position storage p = _positions[id][msg.sender];
        if (amount == 0) revert NothingToDo();
        if (amount > p.collateral) revert InsufficientCollateral(p.collateral, amount);

        p.collateral -= amount;
        // A position with no debt left has no ratio to satisfy, and asking the
        // oracle would mean a stale price could trap collateral that secures
        // nothing.
        if (p.debt > 0) {
            uint256 ratio = _ratioBps(id, p.collateral, p.debt);
            if (ratio < c.minRatioBps) revert Undercollateralised(ratio, c.minRatioBps);
        }
        if (!collateralToken.transfer(msg.sender, amount)) revert TransferFailed();
        emit Withdrawn(id, msg.sender, amount);
    }

    /**
     * Repay somebody else's debt and take their collateral, plus a penalty.
     *
     * NO CLOSE FACTOR. Aave caps a single liquidation at half the debt so a
     * position that dips barely under cannot be wiped out. That cap is omitted
     * here: with a handful of known participants and an administered rate, a
     * position nobody can fully clear is the likelier failure than an over-eager
     * liquidator. The trade would be the wrong way round on a chain with
     * anonymous searchers on it.
     *
     * Permissionless by design, and gated in practice by the synth itself: a
     * liquidator must HOLD the currency to burn it, and the currency checks the
     * identity registry. So liquidation is open to anyone the chain already
     * knows — which is the same accidental protection docs/defi.md observed for
     * Aave, except here it is deliberate.
     */
    function liquidate(uint256 id, address who, uint256 repayAmount)
        external nonReentrant returns (uint256 seized)
    {
        Currency storage c = _at(id);
        Position storage p = _positions[id][who];
        if (repayAmount == 0 || p.debt == 0) revert NothingToDo();
        if (repayAmount > p.debt) revert RepayExceedsDebt(p.debt, repayAmount);

        uint256 ratio = _ratioBps(id, p.collateral, p.debt);
        if (ratio >= c.liqThresholdBps) revert NotLiquidatable(ratio, c.liqThresholdBps);

        seized = (_rielValue(id, repayAmount) * (BPS + c.liqPenaltyBps)) / BPS;
        // A position whose collateral no longer covers the penalty is already
        // past saving; taking everything is better than reverting and leaving
        // the debt outstanding with nobody able to clear it.
        if (seized > p.collateral) seized = p.collateral;

        p.debt -= repayAmount;
        c.totalDebt -= repayAmount;
        p.collateral -= seized;

        c.synth.burn(msg.sender, repayAmount);
        if (!collateralToken.transfer(msg.sender, seized)) revert TransferFailed();
        emit Liquidated(id, who, msg.sender, repayAmount, seized);
    }

    // --------------------------------------------------------------------- views

    function currencyCount() external view returns (uint256) { return _currencies.length; }

    function currencyAt(uint256 id) external view returns (Currency memory) { return _at(id); }

    function positionOf(uint256 id, address who) external view returns (Position memory) {
        return _positions[id][who];
    }

    /// Riel value of `debt` synth minor units, in KHRt minor units.
    function rielValueOf(uint256 id, uint256 debt) external view returns (uint256) {
        return _rielValue(id, debt);
    }

    /**
     * Collateralisation in basis points. A position with no debt is reported as
     * type(uint256).max rather than as a division by zero — "infinitely safe" is
     * the true answer and any sentinel a caller has to special-case is worse.
     */
    function ratioBps(uint256 id, address who) external view returns (uint256) {
        Position storage p = _positions[id][who];
        return _ratioBps(id, p.collateral, p.debt);
    }

    /// The largest debt this position could carry and still satisfy minRatioBps.
    function maxDebt(uint256 id, address who) external view returns (uint256) {
        Currency storage c = _at(id);
        Position storage p = _positions[id][who];
        uint256 unitValue = _rielValue(id, 10 ** uint256(c.synthDecimals));
        if (unitValue == 0) return 0;
        uint256 capacity = (p.collateral * BPS) / c.minRatioBps;
        uint256 whole = (capacity * (10 ** uint256(c.synthDecimals))) / unitValue;
        return whole > p.debt ? whole - p.debt : 0;
    }

    // ----------------------------------------------------------------- internals

    function _at(uint256 id) private view returns (Currency storage) {
        if (id >= _currencies.length) revert NoSuchCurrency();
        return _currencies[id];
    }

    /**
     * Convert a debt in synth minor units to riel minor units.
     *
     * The rate is riel per WHOLE synth unit, scaled by BASE_CURRENCY_UNIT, so
     * both decimal scales and the oracle's own scale have to come out. Doing
     * this in one expression keeps the rounding in one place: the multiplication
     * happens before any division, so a 2-decimal currency against a 2-decimal
     * collateral does not lose its fractional riel on the way through.
     */
    function _rielValue(uint256 id, uint256 debt) private view returns (uint256) {
        Currency storage c = _currencies[id];
        uint256 price = rates.getAssetPrice(address(c.synth));   // reverts if stale
        uint256 unit = rates.BASE_CURRENCY_UNIT();
        return (debt * price * (10 ** uint256(collateralDecimals)))
            / ((10 ** uint256(c.synthDecimals)) * unit);
    }

    function _ratioBps(uint256 id, uint256 collateral, uint256 debt) private view returns (uint256) {
        if (debt == 0) return type(uint256).max;
        uint256 value = _rielValue(id, debt);
        if (value == 0) return type(uint256).max;
        return (collateral * BPS) / value;
    }
}
