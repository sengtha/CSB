// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ISpendPolicy
 * @notice Decides whether earmarked ("assigned spend target") money may move to
 *         a given recipient.
 *
 * Kept as an interface so the token depends on the *question*, not on one
 * ministry's answer to it. A food-aid programme, a school-fee programme and a
 * fuel-subsidy programme are different policies with different registries and
 * different authorities behind them; the token should not have to change to
 * support the next one.
 */
interface ISpendPolicy {
    /**
     * @notice May `from` spend programme-`programId` funds with `to`?
     * @dev MUST be view and MUST NOT revert — the token calls this inside a
     *      transfer, and a policy that reverts would brick every payment by an
     *      affected account rather than just declining the one.
     */
    function isSpendAllowed(uint32 programId, address from, address to) external view returns (bool);

    /// @notice Human-readable reason a spend was declined, for wallet UIs.
    function declineReason(uint32 programId, address from, address to) external view returns (string memory);
}
