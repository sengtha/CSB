/**
 * Subnet-EVM allow-list helpers, and a revert decoder.
 *
 * CSB is permissioned at the chain level, below the contract layer, and scripts
 * that work fine against a local Hardhat node hit two walls on the real chain:
 *
 *   txAllowList              — an address that is not enabled cannot send ANY
 *                              transaction, however well-KYC'd it is in
 *                              IdentityRegistry. KYC governs who may hold KHRt;
 *                              this governs who may transact at all. Both are
 *                              required, and forgetting the second produces a
 *                              generated demo account that looks correct and
 *                              silently cannot move.
 *   contractDeployerAllowList — only vetted addresses may create contracts. This
 *                              also applies to a CONTRACT creating a contract,
 *                              which is what a factory does: LandTitleRegistry
 *                              deploying a LandTitleToken is a create by the
 *                              registry's own address, so the registry itself
 *                              has to be enabled or the call reverts with no
 *                              reason string at all.
 *
 * All helpers no-op cleanly when the precompiles are absent (a local Hardhat
 * node), so the same script runs in both places.
 */
const TX_ALLOWLIST = "0x0200000000000000000000000000000000000002";
const DEPLOYER_ALLOWLIST = "0x0200000000000000000000000000000000000000";
const ABI = [
  "function setEnabled(address addr)",
  "function readAllowList(address addr) view returns (uint256)",
];

async function _enable(ethers, signer, precompile, addr, label) {
  const c = new ethers.Contract(precompile, ABI, signer);
  let role;
  try {
    role = await c.readAllowList(addr);
  } catch (_) {
    return false; // precompile not on this chain (local dev) — nothing to do
  }
  if (role > 0n) return false; // already enabled or admin
  await (await c.setEnabled(addr)).wait();
  if (label) console.log(`  ${label} enabled on the ${precompile === TX_ALLOWLIST ? "transaction" : "contract-deployer"} allow list`);
  return true;
}

/** Let `addr` submit transactions on the permissioned chain. */
async function enableTransactor(ethers, signer, addr, label) {
  return _enable(ethers, signer, TX_ALLOWLIST, addr, label);
}

/** Let `addr` (an account OR a factory contract) create contracts. */
async function enableDeployer(ethers, signer, addr, label) {
  return _enable(ethers, signer, DEPLOYER_ALLOWLIST, addr, label);
}

/**
 * Pull something readable out of a failed call. A bare "execution reverted" is
 * usually a custom error the provider did not decode; try the contract's ABI
 * before giving up.
 */
function explain(e, ...contracts) {
  const data = e?.data ?? e?.error?.data ?? e?.info?.error?.data;
  if (typeof data === "string" && data.length >= 10) {
    for (const c of contracts.filter(Boolean)) {
      try {
        const parsed = c.interface.parseError(data);
        if (parsed) return `${parsed.name}(${parsed.args.map(String).join(", ")})`;
      } catch (_) { /* not this contract's error */ }
    }
  }
  const msg = String(e?.shortMessage ?? e?.message ?? e);
  if (/not allow ?listed|allow list/i.test(msg)) {
    return `${msg}\n  → the sending address is not on the chain's txAllowList. `
      + `Enable it, or run scripts/seed-accounts.js which does.`;
  }
  return msg;
}

module.exports = { enableTransactor, enableDeployer, explain, TX_ALLOWLIST, DEPLOYER_ALLOWLIST };
