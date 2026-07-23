// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IdentityRegistry} from "../identity/IdentityRegistry.sol";
import {EnforcementRegistry} from "../enforcement/EnforcementRegistry.sol";
import {IBridgeAdapter} from "./IBridgeAdapter.sol";

/**
 * @title EgressGateway
 * @notice The single authorized exit from the sovereign chain to public
 *         blockchains. All egress policy is enforced here:
 *
 *  - Only tokens explicitly permitted by the governing council can leave.
 *  - Each token carries a minimum KYC tier and a daily volume cap.
 *  - The whole gateway is pausable by the council (circuit breaker).
 *  - Transport is delegated to a per-token IBridgeAdapter (production: an
 *    Avalanche ICTT wrapper), so policy and bridge security are separated.
 *
 * Everything that crosses this contract becomes visible on public chains —
 * the gateway is the boundary where sovereign-private data turns world-public.
 */
contract EgressGateway is AccessControl, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    struct TokenPolicy {
        bool allowed;
        uint8 minTier;
        uint256 dailyCap; // in token units; 0 = no cap
        IBridgeAdapter adapter;
    }

    IdentityRegistry public immutable identity;
    EnforcementRegistry public immutable enforcement;

    mapping(address => TokenPolicy) public policies;

    /// @notice token => day index (timestamp / 1 days) => volume egressed.
    mapping(address => mapping(uint256 => uint256)) public dailyVolume;

    event TokenPolicySet(address indexed token, bool allowed, uint8 minTier, uint256 dailyCap, address adapter);
    event EgressInitiated(
        address indexed initiator,
        address indexed token,
        uint256 amount,
        bytes32 indexed destinationChain,
        bytes recipient
    );

    error TokenNotPermitted(address token);
    error NotKycActive(address account);
    error AccountFrozen(address account);
    error TierTooLow(address account, uint8 tier, uint8 required);
    error DailyCapExceeded(address token, uint256 cap, uint256 attempted);

    constructor(IdentityRegistry identity_, EnforcementRegistry enforcement_, address councilAdmin) {
        identity = identity_;
        enforcement = enforcement_;
        _grantRole(DEFAULT_ADMIN_ROLE, councilAdmin);
        _grantRole(GOVERNOR_ROLE, councilAdmin);
    }

    // -------------------------------------------------------------- governance

    function setTokenPolicy(address token, bool allowed, uint8 minTier, uint256 dailyCap, IBridgeAdapter adapter)
        external
        onlyRole(GOVERNOR_ROLE)
    {
        require(!allowed || address(adapter) != address(0), "adapter required for allowed token");
        policies[token] = TokenPolicy({allowed: allowed, minTier: minTier, dailyCap: dailyCap, adapter: adapter});
        emit TokenPolicySet(token, allowed, minTier, dailyCap, address(adapter));
    }

    function pause() external onlyRole(GOVERNOR_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(GOVERNOR_ROLE) {
        _unpause();
    }

    // ------------------------------------------------------------------ egress

    /**
     * @notice Bridge `amount` of `token` out to `recipient` on `destinationChain`.
     *         Caller must have approved the gateway for `amount`.
     */
    function requestEgress(address token, uint256 amount, bytes32 destinationChain, bytes calldata recipient)
        external
        whenNotPaused
    {
        TokenPolicy memory p = policies[token];
        if (!p.allowed) revert TokenNotPermitted(token);

        address sender = _msgSender();
        if (!identity.isActive(sender)) revert NotKycActive(sender);
        if (enforcement.isFrozen(sender)) revert AccountFrozen(sender);
        uint8 tier = identity.tierOf(sender);
        if (tier < p.minTier) revert TierTooLow(sender, tier, p.minTier);

        if (p.dailyCap != 0) {
            uint256 day = block.timestamp / 1 days;
            uint256 used = dailyVolume[token][day] + amount;
            if (used > p.dailyCap) revert DailyCapExceeded(token, p.dailyCap, used);
            dailyVolume[token][day] = used;
        }

        IERC20(token).safeTransferFrom(sender, address(p.adapter), amount);
        p.adapter.bridge(token, amount, destinationChain, recipient, sender);

        emit EgressInitiated(sender, token, amount, destinationChain, recipient);
    }
}
