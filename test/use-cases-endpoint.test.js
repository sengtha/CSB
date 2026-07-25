const { expect } = require("chai");
const { useCases, useCaseCheck, _internal } = require("../app/use-cases");

/**
 * The use-case endpoint is PUBLIC and reads from deployments.json — the same
 * file that holds the demo casts' private keys, right beside the addresses the
 * page needs. Nothing stops a later change from returning the cast object
 * wholesale, and the mistake would be invisible in the browser: the page would
 * look identical while serving keys to anyone who opened devtools.
 *
 * So this asserts the property directly, against a fixture whose every account
 * carries a key.
 */
const KEYS = {
  household: "0x1111111111111111111111111111111111111111111111111111111111111111",
  grocer: "0x2222222222222222222222222222222222222222222222222222222222222222",
  lender: "0x3333333333333333333333333333333333333333333333333333333333333333",
  owner: "0x4444444444444444444444444444444444444444444444444444444444444444",
  buyer: "0x5555555555555555555555555555555555555555555555555555555555555555",
  payer: "0x6666666666666666666666666666666666666666666666666666666666666666",
};
const acct = (name, key) => ({
  address: "0x" + name.padEnd(40, "0").slice(0, 40).replace(/[^0-9a-f]/gi, "a"),
  key,
  label: `${name} label`,
});

const DEPLOYMENTS = {
  contracts: {
    KHRStablecoin: "0x" + "11".repeat(20),
    IdentityRegistry: "0x" + "22".repeat(20),
    MerchantRegistry: "0x" + "33".repeat(20),
    SocialProgramRegistry: "0x" + "44".repeat(20),
    LandTitleRegistry: "0x" + "55".repeat(20),
    PaymentEscrow: "0x" + "66".repeat(20),
  },
  pilot: {
    idpoor: {
      household: acct("household", KEYS.household),
      grocer: acct("grocer", KEYS.grocer),
      lender: acct("lender", KEYS.lender),
      programId: 1,
    },
    land: { owner: acct("owner", KEYS.owner), buyer: acct("buyer", KEYS.buyer) },
    escrow: { buyer: acct("payer", KEYS.payer) },
    accounts: { sokha: acct("sokha", KEYS.household) },
  },
};

/**
 * Stub the node. Returning a long non-zero word for every eth_call keeps the
 * decoders on their normal path (offsets, lengths, addresses) rather than
 * short-circuiting on a null, so the response is built the way it is in
 * production. The values are nonsense; only the SHAPE matters here.
 */
function stubFetch(result) {
  const original = global.fetch;
  global.fetch = async () => ({ json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
  return () => { global.fetch = original; };
}

const RPC = "http://127.0.0.1:0";

describe("use-cases endpoint", function () {
  let restore;
  // The response cache is global and lasts 6s, so without clearing it every
  // test after the first would assert against the first one's answer.
  beforeEach(() => _internal.resetCache());
  afterEach(() => { if (restore) restore(); restore = null; });

  it("never returns a private key, whatever the chain replies", async function () {
    // A word of 0x20 reads as a plausible offset/length/number, so decoding
    // proceeds instead of bailing out early.
    restore = stubFetch("0x" + "20".padStart(64, "0").repeat(12));
    const out = JSON.stringify(await useCases(RPC, DEPLOYMENTS));
    for (const [who, key] of Object.entries(KEYS)) {
      expect(out, `private key for ${who} leaked`).to.not.include(key);
    }
    expect(out).to.not.include('"key"');
  });

  it("also keeps keys out of the check endpoint", async function () {
    restore = stubFetch("0x" + "00".repeat(64));
    for (const kase of ["idpoor", "land", "escrow"]) {
      const out = JSON.stringify(await useCaseCheck(RPC, DEPLOYMENTS, {
        kase, to: "0x" + "ab".repeat(20), amount: "1",
      }));
      for (const key of Object.values(KEYS)) expect(out).to.not.include(key);
    }
  });

  it("refuses a malformed recipient instead of asking the chain", async function () {
    let called = false;
    const original = global.fetch;
    global.fetch = async () => { called = true; return { json: async () => ({ result: "0x" }) }; };
    restore = () => { global.fetch = original; };

    const r = await useCaseCheck(RPC, DEPLOYMENTS, { kase: "idpoor", to: "not-an-address", amount: "10" });
    expect(r.ok).to.equal(false);
    expect(r.reason).to.match(/valid 0x address/);
    expect(called, "should not have called the node").to.equal(false);
  });

  it("reports a missing demo rather than throwing", async function () {
    restore = stubFetch("0x" + "00".repeat(32));
    const r = await useCaseCheck(RPC, { contracts: {} }, { kase: "land", to: "0x" + "ab".repeat(20), amount: "1" });
    expect(r.ok).to.equal(false);
    expect(r.reason).to.match(/has not been set up/);
  });

  /**
   * Found by the leak test above running for 19 seconds. Every length, count
   * and offset in a call result comes from the node, and this decoder is
   * hand-written: `orderCount` returning 0xff…ff became 1.15e77, and
   * `for (let i = n - 2; i <= n; i++)` cannot terminate at that magnitude
   * because `n - 2 === n` and `i++` is a no-op. It burned twenty seconds and
   * died out of memory. On a public endpoint that is a denial of service.
   */
  it("stays fast when the chain returns nonsense", async function () {
    const shapes = [
      "0x" + "ff".repeat(32 * 12), // every count and length astronomically large
      "0x" + "20".padStart(64, "0").repeat(12), // plausible-looking offsets
      "0x" + "01".repeat(32 * 12), // unaligned offsets
      "0xdeadbeef", // far shorter than any decoder expects
      "0x",
    ];
    for (const shape of shapes) {
      _internal.resetCache();
      restore = stubFetch(shape);
      const started = Date.now();
      await useCases(RPC, DEPLOYMENTS);
      const took = Date.now() - started;
      restore(); restore = null;
      expect(took, `decoding ${shape.slice(0, 12)}… took ${took}ms`).to.be.lessThan(1000);
    }
  });

  it("rejects an unknown case", async function () {
    const r = await useCaseCheck(RPC, DEPLOYMENTS, { kase: "nope", to: "0x" + "ab".repeat(20), amount: "1" });
    expect(r).to.deep.equal({ ok: false, reason: "unknown check" });
  });
});
