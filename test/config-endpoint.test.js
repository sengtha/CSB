const { expect } = require("chai");
const path = require("path");

/**
 * /config must never hand a private key to an unauthenticated caller.
 *
 * It used to return deployments.json verbatim, with no cookie check. That file
 * carries the pilot cast's private keys, so any visitor could read working keys
 * for accounts that are KYC-verified and on the transaction allow list. On a
 * chain whose whole claim is that every participant is known, that is not a lost
 * test balance — it is an anonymous stranger acquiring a verified identity.
 *
 * These tests exercise the stripping function directly rather than booting the
 * server, so they stay fast and cannot be defeated by a route-matching change
 * elsewhere. The route's own auth branch is one line above the call.
 */
const { stripSecrets } = require(path.join(__dirname, "..", "app", "server-secrets.js"));

describe("/config secret stripping", function () {
  const sample = {
    network: "csb",
    chainId: 8555,
    contracts: {
      KHRStablecoin: "0xEAE160F6f9a4D626A5A94402E87F0EB7f89A88C1",
      IdentityRegistry: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    },
    roles: { council: "0x8f6aE9fB0993C8691D7FCDFBFC79fbcF5A7BFa8b" },
    deployerKey: "d5820ca18782b7961f04ca8dde4605e49249dc39561a67316b4f23cd029e81ed",
    pilot: {
      destinationChain: { label: "Avalanche C-Chain", id: "0x7fc93d85c6d62c5b" },
      accounts: {
        sokha: {
          address: "0x64bfCEA22F59A48425Eb9E533232DdF0Fc542Ae0",
          key: "0x6f377c698349f4cfc0907370087f2e2a1234567890abcdef1234567890abcdef",
          tier: 2,
          note: "full KYC, funded",
        },
      },
    },
  };

  it("removes every private key", function () {
    const out = stripSecrets(sample);
    const json = JSON.stringify(out);
    expect(json).to.not.include("d5820ca18782b7961f04ca8dde4605e4");
    expect(json).to.not.include("6f377c698349f4cfc0907370087f2e2a");
    expect(out.deployerKey).to.equal(undefined);
    expect(out.pilot.accounts.sokha.key).to.equal(undefined);
  });

  it("keeps everything the wallet legitimately needs", function () {
    const out = stripSecrets(sample);
    expect(out.chainId).to.equal(8555);
    expect(out.contracts.KHRStablecoin).to.equal(sample.contracts.KHRStablecoin);
    expect(out.roles.council).to.equal(sample.roles.council);
    expect(out.pilot.accounts.sokha.address).to.equal(sample.pilot.accounts.sokha.address);
    expect(out.pilot.accounts.sokha.tier).to.equal(2);
    expect(out.pilot.destinationChain.label).to.equal("Avalanche C-Chain");
  });

  it("catches a secret hidden under a field name nobody anticipated", function () {
    // The name-based rule cannot cover a field that does not exist yet. The
    // shape-based rule is what makes this safe against a future edit to
    // deploy.js that adds a key under some other name.
    const out = stripSecrets({
      backupSigner: "0xaaaabbbbccccddddeeeeffff00001111aaaabbbbccccddddeeeeffff00001111",
      nested: { deep: [{ whatever: "aaaabbbbccccddddeeeeffff00001111aaaabbbbccccddddeeeeffff00001111" }] },
    });
    expect(out.backupSigner).to.equal(undefined);
    expect(out.nested.deep[0].whatever).to.equal(undefined);
  });

  it("does not strip addresses, hashes-as-identifiers are the caller's problem", function () {
    // 20-byte addresses must survive — they are the entire point of the file.
    const out = stripSecrets({ a: "0x8f6aE9fB0993C8691D7FCDFBFC79fbcF5A7BFa8b" });
    expect(out.a).to.equal("0x8f6aE9fB0993C8691D7FCDFBFC79fbcF5A7BFa8b");
  });
});
