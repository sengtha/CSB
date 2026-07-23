// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IBridgeAdapter
 * @notice Abstraction over the actual cross-chain transport. The production
 *         adapter wraps Avalanche ICTT (TokenHome on CSB, TokenRemote on the
 *         C-Chain); the prototype ships a mock. The EgressGateway is the only
 *         authorized caller — policy (allowlist, caps, tiers) lives in the
 *         gateway, transport lives here.
 */
interface IBridgeAdapter {
    /**
     * @param token          ERC20 being bridged (already transferred to the adapter)
     * @param amount         amount in token units
     * @param destinationChain identifier of the destination chain (e.g. Avalanche blockchainID)
     * @param recipient      ABI-encoded recipient on the destination chain
     * @param initiator      the KYC'd account that requested the egress
     */
    function bridge(
        address token,
        uint256 amount,
        bytes32 destinationChain,
        bytes calldata recipient,
        address initiator
    ) external;
}
