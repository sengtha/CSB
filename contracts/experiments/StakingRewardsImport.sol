// SPDX-License-Identifier: MIT
pragma solidity ^0.5.16;

// Pulls Synthetix's StakingRewards into the build so hardhat produces an artifact
// for it. The source itself stays untouched in node_modules — nothing here is a
// copy, a fork, or a reimplementation, which is the same standard the Uniswap and
// Aave experiments hold themselves to.
//
// StakingRewards is the most-forked staking contract in DeFi: stake token A, earn
// token B from a funded reward pool, and nearly every "farm" descends from it.
// test/defi-staking.test.js runs it against the compliance-gated asset.
import "synthetix/contracts/StakingRewards.sol";
