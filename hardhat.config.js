require("@nomicfoundation/hardhat-toolbox");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Use the npm-installed solc-js when it matches, so builds work in offline /
// egress-restricted environments where binaries.soliditylang.org is blocked.
// Locally installed compilers, by version. The second one is an npm alias
// (`solc-0_5_16@npm:solc@0.5.16`) and exists because the Synthetix staking contract
// evaluated in test/defi-staking.test.js is pragma ^0.5.16 — see contracts/experiments.
const LOCAL_SOLC = { "solc": null, "solc-0_5_16": null };

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, _hre, runSuper) => {
  for (const pkg of Object.keys(LOCAL_SOLC)) {
    try {
      const solc = require(`${pkg}/package.json`);
      if (solc.version === args.solcVersion) {
        return {
          compilerPath: require.resolve(`${pkg}/soljson.js`),
          isSolcJs: true,
          version: args.solcVersion,
          longVersion: `solc-js ${solc.version}`,
        };
      }
    } catch (_) {
      // not installed under this name — try the next, then the downloader
    }
  }
  return runSuper(args);
});

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          // Subnet-EVM supports Shanghai from the Durango upgrade; "paris" keeps the
          // bytecode deployable on older Subnet-EVM versions as well.
          evmVersion: "paris",
        },
      },
      {
        // For the Synthetix StakingRewards evaluation only. Compiling the genuine
        // upstream source is what preserves the "unmodified protocol" property that
        // the Uniswap and Aave experiments rest on; reimplementing it would not.
        // istanbul is the newest target 0.5.16 supports.
        version: "0.5.16",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "istanbul",
        },
      },
    ],
  },
  networks: {
    // Avalanche L1 node (local VM or remote): set CSB_RPC_URL to the chain's
    // RPC, e.g. http://127.0.0.1:9650/ext/bc/<blockchainID>/rpc
    csbRemote: {
      url: process.env.CSB_RPC_URL ?? "http://127.0.0.1:9650/ext/bc/CSB/rpc",
      chainId: Number(process.env.CSB_CHAIN_ID ?? 8555),
      accounts: process.env.CSB_DEPLOYER_KEY ? [process.env.CSB_DEPLOYER_KEY] : [],
      // Force legacy txs at a fixed, safely-high price so admin/deploy scripts
      // never get stuck under-priced in the mempool (this chain's effective base
      // fee can jump above ethers' automatic estimate). The deployer holds ~1M
      // tRIEL, so overpaying gas is immaterial; override with CSB_GAS_PRICE_WEI.
      // Fixed price so scripts can't submit an under-priced tx that never mines.
      // This MUST stay above the chain's minBaseFee. Under the "1 tRIEL per
      // transfer" policy the floor is 1e18/21000 ≈ 47,619 gwei, so the default
      // is ~15% above that. If you change the fee policy with
      // scripts/set-gas-price.js, change this too — the script prints the value.
      gasPrice: Number(process.env.CSB_GAS_PRICE_WEI ?? 55_000_000_000_000), // 55,000 gwei
    },
  },
};
