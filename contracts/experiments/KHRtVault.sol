// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts-v4/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts-v4/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts-v4/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC4626} from "@openzeppelin/contracts-v4/token/ERC20/extensions/ERC4626.sol";

/**
 * @title KHRtVault
 * @notice A tokenized vault (ERC-4626) over a compliance-gated asset.
 *
 * EVALUATION ARTIFACT, NOT A PRODUCTION CONTRACT. It exists to answer one
 * question and is deliberately as close to nothing as a deployable ERC-4626 can
 * be.
 *
 * WHY IT EXISTS. The Uniswap and Aave experiments each showed one protocol
 * turning a gated asset into an ungated claim on it. Two protocols are two data
 * points. ERC-4626 is a *standard*, so a result here is a result about every
 * vault built on the standard rather than about two named products.
 *
 * WHY IT IS THIS SMALL. `ERC4626` is abstract, so a concrete vault must exist
 * before anything can be deployed — unlike Uniswap and Aave this cannot be pure
 * upstream bytecode. The honest substitute is to add *nothing whatsoever*: no
 * state, no functions, no overrides, no hooks. Every line of behaviour comes from
 * OpenZeppelin unmodified, including `totalAssets()`, which the base class already
 * implements as the vault's own balance of the underlying. If shares escape the
 * perimeter, nothing in this file caused it. Read the constructor as the whole
 * contract, because it is.
 *
 * WHY OPENZEPPELIN 4.9 RATHER THAN 5.x. OZ 5.6's `ERC4626` imports `utils/Memory.sol`,
 * which uses the `mcopy` opcode and therefore requires a Cancun-capable EVM. This
 * project pins `evmVersion: "paris"` deliberately, to keep bytecode deployable on
 * Subnet-EVM versions that predate Cancun (see `hardhat.config.js`). Rather than
 * relax a project-wide setting — which would change the bytecode of every already
 * deployed contract — or bet the live deployment on a chain capability that could
 * not be verified from the genesis config, this uses the 4.9 line, which is pure
 * Solidity and compiles under `paris`. The vault semantics are identical; only the
 * memory-copy implementation differs.
 *
 * WHAT TO EXPECT. Depositing requires the vault to hold KHRt, so the council must
 * mark it a system contract first — the same discretionary grant Uniswap's pair
 * and Aave's pool and aToken each needed, for the same reason: the address does
 * not exist until it is deployed. The shares it mints are a plain ERC-20 with no
 * compliance hooks, because `ERC4626` extends `ERC20`, and `ERC20` knows nothing
 * about identity.
 */
contract KHRtVault is ERC4626 {
    constructor(IERC20 asset_, string memory name_, string memory symbol_)
        ERC4626(asset_)
        ERC20(name_, symbol_)
    {}
}
