const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, setBalance } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const fs = require("fs");
const path = require("path");

/**
 * A threshold answers "did enough owners agree". It cannot answer "agree to
 * what", and it is exactly as strong as the owners' ability to read what they
 * are signing — which, for a 32-byte hash, is not very. SafeScopeGuard bounds
 * what a wallet can do at all, so a quorum tricked into signing a transfer to an
 * attacker cannot execute it.
 *
 * The property under test is not the allow list. It is the ASYMMETRY:
 *
 *   tightening is immediate      — an emergency must never wait on a timer
 *   loosening is announced       — a compromised quorum cannot widen its own
 *                                  permissions and use them in one sitting
 *
 * A guard removable in one transaction bounds nothing, because the signatures
 * that authorise the theft can remove the guard first. A guard that cannot be
 * removed bricks the wallet permanently the first time the policy is wrong.
 * Everything below is about that seam.
 *
 * Safe contracts come from vendor/safe (see scripts/deploy-safe.js for why they
 * are not a root dependency). The tests skip rather than fail when it has not
 * been installed, so a fresh clone running `npx hardhat test` does not report a
 * missing optional install as a broken contract.
 */
const VENDORED = path.join(__dirname, "..", "vendor", "safe", "node_modules",
  "@safe-global", "safe-contracts", "build", "artifacts", "contracts");
const ART = {
  SafeL2: "SafeL2.sol/SafeL2.json",
  Factory: "proxies/SafeProxyFactory.sol/SafeProxyFactory.json",
  Handler: "handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json",
};
const have = fs.existsSync(path.join(VENDORED, ART.SafeL2));
const load = (rel) => JSON.parse(fs.readFileSync(path.join(VENDORED, rel), "utf8"));

const COOLDOWN = 3600;   // one hour, long enough that "immediately" is unambiguous

(have ? describe : describe.skip)("SafeScopeGuard", function () {
  let owner, outsider, safe, guard, asSafe;

  /**
   * Execute through the Safe as its single owner.
   *
   * Safe accepts a "pre-validated" signature when the caller IS the owner:
   * r = the owner's address, s = 0, v = 1. That keeps these tests about the
   * guard rather than about EIP-712 encoding, which safe-exec.js already covers.
   */
  async function exec(to, data, value = 0n, operation = 0) {
    const sig = ethers.concat([
      ethers.zeroPadValue(owner.address, 32),
      ethers.zeroPadValue("0x", 32),
      "0x01",
    ]);
    return safe.connect(owner).execTransaction(
      to, value, data, operation, 0, 0, 0,
      ethers.ZeroAddress, ethers.ZeroAddress, sig);
  }

  beforeEach(async function () {
    [owner, outsider] = await ethers.getSigners();

    const singleton = await new ethers.ContractFactory(
      load(ART.SafeL2).abi, load(ART.SafeL2).bytecode, owner).deploy();
    const factory = await new ethers.ContractFactory(
      load(ART.Factory).abi, load(ART.Factory).bytecode, owner).deploy();
    const handler = await new ethers.ContractFactory(
      load(ART.Handler).abi, load(ART.Handler).bytecode, owner).deploy();

    const setup = singleton.interface.encodeFunctionData("setup", [
      [owner.address], 1, ethers.ZeroAddress, "0x",
      await handler.getAddress(), ethers.ZeroAddress, 0, ethers.ZeroAddress,
    ]);
    const rc = await (await factory.createProxyWithNonce(
      await singleton.getAddress(), setup, 0)).wait();
    let addr = null;
    for (const log of rc.logs) {
      try {
        const p = factory.interface.parseLog(log);
        if (p?.name === "ProxyCreation") { addr = p.args.proxy; break; }
      } catch (_) { /* not ours */ }
    }
    safe = new ethers.Contract(addr, [
      ...load(ART.SafeL2).abi,
      "function setGuard(address guard)",
    ], ethers.provider);

    guard = await (await ethers.getContractFactory("SafeScopeGuard"))
      .deploy(addr, COOLDOWN);

    await exec(addr, safe.interface.encodeFunctionData("setGuard", [await guard.getAddress()]));

    // Policy administration is asserted DIRECTLY against the guard, as the Safe.
    // Routed through execTransaction, a reverting inner call comes back as Safe's
    // own "GS013" with the revert data discarded — so the specific reason, which
    // is the thing under test, would be invisible. Enforcement is still tested
    // through the Safe, because that is the path that matters there.
    asSafe = await ethers.getImpersonatedSigner(addr);
    await setBalance(addr, ethers.parseEther("10"));
  });

  it("attaches — Safe accepts it, so the ERC-165 interface id is right", async function () {
    // Safe's setGuard reverts with GS300 unless supportsInterface(Guard) is true.
    // If beforeEach got this far the guard is attached; confirm the slot directly.
    const SLOT = ethers.keccak256(ethers.toUtf8Bytes("guard_manager.guard.address"));
    const raw = await ethers.provider.getStorage(await safe.getAddress(), SLOT);
    expect(ethers.getAddress("0x" + raw.slice(-40)))
      .to.equal(await guard.getAddress());
  });

  it("refuses a call to a target that was never allowed", async function () {
    await expect(exec(outsider.address, "0x12345678"))
      .to.be.revertedWithCustomError(guard, "CallNotAllowed");
  });

  it("refuses a plain value transfer to an unallowed address", async function () {
    await owner.sendTransaction({ to: await safe.getAddress(), value: ethers.parseEther("1") });
    await expect(exec(outsider.address, "0x", ethers.parseEther("1")))
      .to.be.revertedWithCustomError(guard, "CallNotAllowed");
  });

  it("refuses delegatecall unconditionally, even to an allowed target", async function () {
    const key = ethers.keccak256(ethers.solidityPacked(["string", "address"], ["target", outsider.address]));
    await exec(await guard.getAddress(), guard.interface.encodeFunctionData("announce", [key]));
    await time.increase(COOLDOWN + 1);
    await exec(await guard.getAddress(), guard.interface.encodeFunctionData("allowTarget", [outsider.address]));

    await expect(exec(outsider.address, "0x", 0n, 1))
      .to.be.revertedWithCustomError(guard, "DelegateCallRefused");
  });

  describe("loosening is delayed", function () {
    it("refuses to allow anything without an announcement", async function () {
      await expect(guard.connect(asSafe).allow(outsider.address, "0x12345678"))
        .to.be.revertedWithCustomError(guard, "NotAnnounced");
    });

    it("refuses while the cooldown is still running", async function () {
      const key = await guard.allowKey(outsider.address, "0x12345678");
      await exec(await guard.getAddress(), guard.interface.encodeFunctionData("announce", [key]));
      await time.increase(COOLDOWN - 60);
      await expect(guard.connect(asSafe).allow(outsider.address, "0x12345678"))
        .to.be.revertedWithCustomError(guard, "StillCooling");
    });

    it("permits it once the cooldown has elapsed, and then the call works", async function () {
      const sel = "0x12345678";
      const key = await guard.allowKey(outsider.address, sel);
      await exec(await guard.getAddress(), guard.interface.encodeFunctionData("announce", [key]));
      await time.increase(COOLDOWN + 1);
      await exec(await guard.getAddress(), guard.interface.encodeFunctionData("allow", [outsider.address, sel]));

      expect(await guard.allowedCall(key)).to.equal(true);
      await expect(exec(outsider.address, sel)).to.not.be.reverted;
    });

    it("spends the announcement — the same widening cannot be replayed", async function () {
      const sel = "0x12345678";
      const key = await guard.allowKey(outsider.address, sel);
      await exec(await guard.getAddress(), guard.interface.encodeFunctionData("announce", [key]));
      await time.increase(COOLDOWN + 1);
      await exec(await guard.getAddress(), guard.interface.encodeFunctionData("allow", [outsider.address, sel]));
      await exec(await guard.getAddress(), guard.interface.encodeFunctionData("disallow", [outsider.address, sel]));

      await expect(guard.connect(asSafe).allow(outsider.address, sel))
        .to.be.revertedWithCustomError(guard, "NotAnnounced");
    });
  });

  describe("tightening is immediate", function () {
    it("disallow takes effect in the same transaction, with no waiting", async function () {
      const sel = "0x12345678";
      const key = await guard.allowKey(outsider.address, sel);
      await exec(await guard.getAddress(), guard.interface.encodeFunctionData("announce", [key]));
      await time.increase(COOLDOWN + 1);
      await exec(await guard.getAddress(), guard.interface.encodeFunctionData("allow", [outsider.address, sel]));
      await expect(exec(outsider.address, sel)).to.not.be.reverted;

      // No announce, no time travel — this is the emergency path.
      await exec(await guard.getAddress(), guard.interface.encodeFunctionData("disallow", [outsider.address, sel]));
      await expect(exec(outsider.address, sel))
        .to.be.revertedWithCustomError(guard, "CallNotAllowed");
    });

    it("cancels a pending announcement immediately", async function () {
      const key = await guard.allowKey(outsider.address, "0x12345678");
      await exec(await guard.getAddress(), guard.interface.encodeFunctionData("announce", [key]));
      await exec(await guard.getAddress(), guard.interface.encodeFunctionData("cancelAnnouncement", [key]));
      await time.increase(COOLDOWN + 1);
      await expect(guard.connect(asSafe).allow(outsider.address, "0x12345678"))
        .to.be.revertedWithCustomError(guard, "NotAnnounced");
    });
  });

  describe("removing the guard", function () {
    it("cannot be done on the spot — this is what bounds a stolen quorum", async function () {
      await expect(exec(await safe.getAddress(),
        safe.interface.encodeFunctionData("setGuard", [ethers.ZeroAddress])))
        .to.be.revertedWithCustomError(guard, "NotAnnounced");
    });

    it("still cannot be done while the cooldown runs", async function () {
      const UNGUARD = await guard.UNGUARD();
      await exec(await guard.getAddress(), guard.interface.encodeFunctionData("announce", [UNGUARD]));
      await time.increase(COOLDOWN - 60);
      await expect(exec(await safe.getAddress(),
        safe.interface.encodeFunctionData("setGuard", [ethers.ZeroAddress])))
        .to.be.revertedWithCustomError(guard, "StillCooling");
    });

    it("succeeds after the announcement matures — the wallet is never bricked", async function () {
      const UNGUARD = await guard.UNGUARD();
      await exec(await guard.getAddress(), guard.interface.encodeFunctionData("announce", [UNGUARD]));
      await time.increase(COOLDOWN + 1);
      await exec(await safe.getAddress(),
        safe.interface.encodeFunctionData("setGuard", [ethers.ZeroAddress]));

      // Guard gone: the call refused throughout every test above now goes through.
      await expect(exec(outsider.address, "0x12345678")).to.not.be.reverted;
    });
  });

  it("only the wallet may administer the policy", async function () {
    await expect(guard.connect(outsider).disallow(outsider.address, "0x12345678"))
      .to.be.revertedWithCustomError(guard, "OnlySafe");
    await expect(guard.connect(owner).announce(ethers.ZeroHash))
      .to.be.revertedWithCustomError(guard, "OnlySafe");
  });
});
