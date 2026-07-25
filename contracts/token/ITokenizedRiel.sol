// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title ITokenizedRiel
 * @notice Standard for a riel-denominated stablecoin on CSB. There can be MANY
 *         tokenized-riel tokens (different issuers), all pegged 1:1 to the riel
 *         and convertible to/from the native base coin tRIEL through the
 *         RielConverter — the way USDT/USDC all redeem to the dollar.
 *         `KHRStablecoin` is the reference implementation.
 *
 *         Implementations are expected to KYC-gate transfers (both parties
 *         active, not frozen) and to expose a system-contract allow list so the
 *         converter can custody the token without a personal KYC attestation.
 */
interface ITokenizedRiel is IERC20Metadata {
    /// @notice Marker so registries/tools can recognise a compliant riel token.
    function isTokenizedRiel() external view returns (bool);
}
