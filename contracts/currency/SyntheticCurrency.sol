// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IIdentityRegistry {
    function isActive(address account) external view returns (bool);
}

/**
 * A foreign currency issued by CSB against riel collateral.
 *
 * khUSD, khJPY, khEUR — the prefix is the point. This is not a dollar, not a
 * claim on a dollar, and not a bridged anything. It is a CSB-issued token whose
 * value is asserted by a rate the chain publishes and whose backing is KHRt
 * locked in a vault. Naming it USDx or USDC would invite exactly the confusion
 * that made the previous stand-in a problem.
 *
 * WHY THIS ONE CAN BE GATED, AND THE BRIDGED DOLLAR CANNOT.
 *
 * docs/architecture.md §7.1 accepts that a bridged token arrives with no
 * identity hook, no freeze and no confiscation, because it is somebody else's
 * contract minted by somebody else's bridge. That acceptance is forced, not
 * chosen. A currency CSB ISSUES ITSELF has no such constraint: it can check the
 * identity registry on every transfer exactly as KHRt does.
 *
 * So this is the only dollar-denominated asset on the chain that can be inside
 * the compliance perimeter rather than beside it. That is the strongest argument
 * for minting foreign currency here rather than importing it, and it is worth
 * more than the economics.
 *
 * ONLY THE VAULT MINTS. There is no issuer role and no administrative mint. Every
 * unit in existence was created by CurrencyVault against locked collateral and
 * can be destroyed only by repaying that debt, so total supply is an arithmetic
 * consequence of the vault's books rather than a decision anybody makes.
 */
contract SyntheticCurrency is ERC20 {
    /// The only address that may create or destroy units. Immutable: a vault
    /// that could be repointed would be an issuer role wearing a disguise.
    address public immutable vault;
    IIdentityRegistry public immutable identity;

    uint8 private immutable _decimals;

    error OnlyVault();
    error NotKycActive(address account);

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    /**
     * @param decimals_ Minor units per whole. The same argument as KHRt's:
     *        the yen has no circulating subunit and the dollar has two, so a
     *        faithful choice differs per currency. It is set here, per currency,
     *        rather than fixed globally — and like KHRt's it is effectively
     *        permanent, because changing it means a new token and a new vault
     *        record.
     */
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address identity_,
        address vault_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
        identity = IIdentityRegistry(identity_);
        vault = vault_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyVault {
        _mint(to, amount);
    }

    /// Burns from `from` directly. Only the vault calls this, and it does so
    /// when that party is repaying their own debt or liquidating someone's —
    /// so an allowance would be a formality between the vault and itself.
    function burn(address from, uint256 amount) external onlyVault {
        _burn(from, amount);
    }

    /**
     * The compliance perimeter, checked on every leg including issuance.
     *
     * Minting to an unattested address is refused as firmly as transferring to
     * one: a currency that could be created into a hand it may not then leave
     * would be a hole in the perimeter dressed as an issuance policy.
     */
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && !identity.isActive(from)) revert NotKycActive(from);
        if (to != address(0) && !identity.isActive(to)) revert NotKycActive(to);
        super._update(from, to, value);
    }
}
