// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * A minimally checkpointed ERC-20, for exercising TokenVote's snapshot weighing.
 *
 * Test-only. It exists so the tests can prove that a token which CAN answer
 * "what did this address hold at block N" is weighed without locking anything,
 * and that a token which cannot is refused at DAO creation rather than at the
 * first vote.
 *
 * WHY NOT OpenZeppelin's ERC20Votes. It reaches OZ's EIP-712 machinery, which
 * reaches Bytes.sol, which uses `mcopy` — a Cancun opcode. This project compiles
 * at `paris` so its bytecode stays deployable on older Subnet-EVM, and a per-file
 * compiler override does not help because the offending file is a transitive
 * dependency rather than the overridden one. Anyone wanting a real ERC20Votes
 * token ON CSB will have to move the whole build to `cancun` first — which is
 * safe today, since the chain runs Subnet-EVM from avalanchego v1.15, and would
 * not have been before the July 2026 upgrade.
 *
 * The checkpoint search is linear and the arrays are unbounded. That is fine for
 * a test fixture and would not be fine on a chain.
 */
contract MockVotesToken is ERC20 {
    struct Checkpoint {
        uint256 fromBlock;
        uint256 value;
    }

    mapping(address => Checkpoint[]) private _history;
    Checkpoint[] private _supplyHistory;

    constructor() ERC20("Mock Votes", "MVT") {}

    function mint(address to, uint256 amount) external { _mint(to, amount); }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0)) _write(_history[from], balanceOf(from));
        if (to != address(0)) _write(_history[to], balanceOf(to));
        _write(_supplyHistory, totalSupply());
    }

    function _write(Checkpoint[] storage h, uint256 value) private {
        if (h.length > 0 && h[h.length - 1].fromBlock == block.number) {
            h[h.length - 1].value = value;
        } else {
            h.push(Checkpoint({ fromBlock: block.number, value: value }));
        }
    }

    function _at(Checkpoint[] storage h, uint256 blockNumber) private view returns (uint256) {
        require(blockNumber < block.number, "not yet determined");
        uint256 found = 0;
        for (uint256 i = 0; i < h.length; i++) {
            if (h[i].fromBlock > blockNumber) break;
            found = h[i].value;
        }
        return found;
    }

    /// Same shape as IVotes, which is what TokenVote probes for.
    function getPastVotes(address account, uint256 blockNumber) external view returns (uint256) {
        return _at(_history[account], blockNumber);
    }

    function getPastTotalSupply(uint256 blockNumber) external view returns (uint256) {
        return _at(_supplyHistory, blockNumber);
    }
}
