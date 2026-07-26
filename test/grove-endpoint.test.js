const { expect } = require("chai");
const { grovePlot, groveStats } = require("../app/grove");

/**
 * The grove endpoint is PUBLIC, CORS-open, and reads from deployments.json — the
 * same file that holds the demo casts' private keys, right beside the addresses.
 * It is also reachable by anyone, so it has to survive a node that returns
 * nonsense without spending twenty seconds allocating an array.
 *
 * Both properties are asserted directly rather than assumed, because both fail
 * invisibly: the response would look correct in a browser while serving keys, and
 * the denial of service would only show up under load.
 */
const RPC = "http://stub.invalid";
// Deliberately made of bytes the stubbed chain never returns. Key material that
// happened to match the stub would make this test pass or fail for the wrong
// reason — it would be flagging the stub's own data, not a leak.
const FARMER_KEY = "0x" + "9e".repeat(32);
const OFFICER_KEY = "0x" + "7f".repeat(32);
const DEPLOYMENTS = {
  chainId: 8555,
  contracts: {
    GroveAnchor: "0x" + "11".repeat(20),
    AttesterRegistry: "0x" + "22".repeat(20),
    GroveTitleRegistry: "0x" + "33".repeat(20),
    GrovePledge: "0x" + "44".repeat(20),
  },
  pilot: {
    grove: {
      farmer: { address: "0x" + "aa".repeat(20), key: FARMER_KEY, label: "Farmer" },
      officer: { address: "0x" + "bb".repeat(20), key: OFFICER_KEY, label: "Officer" },
    },
  },
};
const PLOT = "0x" + "cd".repeat(32);

/** Stub the node with one canned `eth_call` result for every call. */
function stubFetch(result) {
  const original = global.fetch;
  global.fetch = async () => ({ json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
  return () => { global.fetch = original; };
}

const word = (hex) => String(hex).replace(/^0x/, "").padStart(64, "0");

describe("grove endpoint", function () {
  it("never returns a private key, whatever the chain replies", async function () {
    // A long non-zero result keeps every decoder on its normal path (offsets,
    // lengths, addresses) rather than short-circuiting on a null.
    const restore = stubFetch("0x" + "11".repeat(32 * 12));
    try {
      const body = await grovePlot(RPC, DEPLOYMENTS, PLOT);
      const json = JSON.stringify(body);
      expect(json).to.not.contain("9e".repeat(32));
      expect(json).to.not.contain("7f".repeat(32));
      expect(json.toLowerCase()).to.not.contain('"key"');
    } finally {
      restore();
    }
  });

  it("keeps keys out of the stats response too", async function () {
    const restore = stubFetch("0x" + word("2a"));
    try {
      const json = JSON.stringify(await groveStats(RPC, DEPLOYMENTS));
      expect(json).to.not.contain("9e".repeat(32));
      expect(json.toLowerCase()).to.not.contain('"key"');
    } finally {
      restore();
    }
  });

  it("refuses a malformed plot instead of asking the chain", async function () {
    let called = false;
    const original = global.fetch;
    global.fetch = async () => { called = true; return { json: async () => ({}) }; };
    try {
      expect((await grovePlot(RPC, DEPLOYMENTS, "not-a-hash")).error).to.contain("32-byte hash");
      expect((await grovePlot(RPC, DEPLOYMENTS, undefined)).error).to.be.a("string");
      expect(called).to.equal(false);
    } finally {
      global.fetch = original;
    }
  });

  it("reports a chain with no Grove contracts rather than throwing", async function () {
    const body = await grovePlot(RPC, { contracts: {} }, PLOT);
    expect(body.available).to.equal(false);
    expect(body.reason).to.contain("not deployed");
    expect((await groveStats(RPC, { contracts: {} })).available).to.equal(false);
  });

  it("reports an unanchored plot as unanchored, not as an error", async function () {
    const restore = stubFetch("0x" + word("0")); // plotHead == 0
    try {
      const body = await grovePlot(RPC, DEPLOYMENTS, PLOT);
      expect(body.available).to.equal(true);
      expect(body.anchored).to.equal(false);
    } finally {
      restore();
    }
  });

  it("stays fast when the chain returns nonsense lengths", async function () {
    // A word of 0xff… decodes as an astronomical count; unclamped, the loop
    // that follows never terminates. This is reachable by anyone.
    const restore = stubFetch("0x" + "ff".repeat(32 * 10));
    try {
      const started = Date.now();
      await grovePlot(RPC, DEPLOYMENTS, PLOT);
      expect(Date.now() - started).to.be.lessThan(3000);
    } finally {
      restore();
    }
  });

  it("survives a node that returns nothing at all", async function () {
    const original = global.fetch;
    global.fetch = async () => { throw new Error("connection refused"); };
    try {
      const body = await grovePlot(RPC, DEPLOYMENTS, PLOT);
      // Every eth_call is caught and becomes null, so the plot simply reads as
      // unanchored rather than taking the page down.
      expect(body.available).to.equal(true);
      expect(body.anchored).to.equal(false);
    } finally {
      global.fetch = original;
    }
  });
});
