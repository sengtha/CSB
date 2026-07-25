require("@nomicfoundation/hardhat-toolbox");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Use the npm-installed solc-js when it matches, so builds work in offline /
// egress-restricted environments where binaries.soliditylang.org is blocked.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, _hre, runSuper) => {
  try {
    const solc = require("solc/package.json");
    if (solc.version === args.solcVersion) {
      return {
        compilerPath: require.resolve("solc/soljson.js"),
        isSolcJs: true,
        version: args.solcVersion,
        longVersion: `solc-js ${solc.version}`,
      };
    }
  } catch (_) {
    // solc not installed locally — fall through to the default downloader
  }
  return runSuper(args);
});

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Subnet-EVM supports Shanghai from the Durango upgrade; "paris" keeps the
      // bytecode deployable on older Subnet-EVM versions as well.
      evmVersion: "paris",
    },
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
      gasPrice: Number(process.env.CSB_GAS_PRICE_WEI ?? 500_000_000_000), // 500 gwei
    },
  },
};
