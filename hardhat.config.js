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
    // Local Avalanche L1 devnet (avalanche-cli blockchain deploy --local)
    csbLocal: {
      url: "http://127.0.0.1:9650/ext/bc/CSB/rpc",
      chainId: 8555,
      accounts: process.env.CSB_DEPLOYER_KEY ? [process.env.CSB_DEPLOYER_KEY] : [],
    },
  },
};
