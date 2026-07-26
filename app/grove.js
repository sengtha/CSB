/**
 * Public, read-only status of an anchored grove — the endpoint CamboVerse reads
 * to render a verified digital twin.
 *
 * WHY THIS IS PUBLIC AND UNAUTHENTICATED. The whole claim of this design is that
 * anybody can check it. A virtual grove whose "verified" badge came from a
 * server nobody outside the project can query would be worth exactly as much as
 * the project's word, which is what the badge exists to replace. CamboVerse
 * verifies the Grove signature itself, off the phone's record; this endpoint
 * adds the chain's half — the block timestamp and the licensed confirmation —
 * and both halves are checkable by a stranger with curl.
 *
 * It is a convenience, not an authority. Everything here is an `eth_call` a
 * reader could make directly against a CSB RPC node; nothing is computed by this
 * server, and nothing is signed by it.
 *
 * PRIVATE KEYS: the demo casts live in deployments.json alongside their keys.
 * Every response is built field by field from an explicit list, never by copying
 * an object and deleting — so a key cannot reach this endpoint by someone later
 * adding a field to that file.
 *
 * The decoding here is by hand, and every length and offset comes from the node
 * rather than from us: a contract that is not the one we think is at an address
 * returns words that decode as astronomical lengths. Every offset is
 * range-checked against the data actually returned, and every count is capped,
 * for the same reason use-cases.js does it — this is reachable by anyone.
 */
const SEL = {
  // Hashed from the signature, never written from memory. A wrong selector
  // returns a plausible zero rather than an error, which is the worst kind of
  // wrong on a page whose entire job is to say whether something is verified.
  anchorOf: "0xcf4ff901", // anchorOf(bytes32)
  isVerified: "0xc181b273", // isVerified(bytes32)
  plotHead: "0xfb058dcd", // plotHead(bytes32)
  plotLength: "0x8317947b", // plotLength(bytes32)
  plotSteward: "0x7cc86d08", // plotSteward(bytes32)
  verifiedCountOf: "0x8e57d00f", // verifiedCountOf(bytes32)
  requiredConfirmations: "0x82e717f7", // requiredConfirmations()
  observationCount: "0x614f5471", // observationCount()
  groveOf: "0x097cb797", // groveOf(bytes32)
  supplyStatus: "0x08dafee8", // supplyStatus(bytes32)
  groveCount: "0xfdd9496b", // groveCount()
  plotIdAt: "0x191f43f0", // plotIdAt(uint256)
  pledgesOfPlot: "0x4cc8aa95", // pledgesOfPlot(bytes32)
  pledgeOf: "0x9042a1d2", // pledgeOf(uint256)
  milestoneCount: "0x72ebb42a", // milestoneCount(uint256)
  milestoneOf: "0xfc4064a6", // milestoneOf(uint256,uint32)
  attesterOf: "0x7d26aaa6", // attesterOf(address)
  totalSupply: "0x18160ddd", // totalSupply()
  name: "0x06fdde03", // name()
  symbol: "0x95d89b41", // symbol()
};

const MAX_ITEMS = 32;
const CACHE_MS = 6000;
const MILESTONE_STATUS = ["pending", "paid", "reclaimed"];
const PLEDGE_STATUS = ["none", "created", "funded", "closed"];
// AttesterRegistry class bitmask, mirrored from the contract's constants.
const CLASSES = [
  [1 << 0, "agronomist"], [1 << 1, "commune"], [1 << 2, "school"],
  [1 << 3, "cooperative"], [1 << 4, "ngo"], [1 << 5, "auditor"],
];

const hexToBig = (h) => (typeof h === "string" && h !== "0x" ? BigInt(h) : 0n);
const byteLen = (hex) => Math.floor(String(hex ?? "").replace(/^0x/, "").length / 2);
const word = (hex, i) => "0x" + String(hex ?? "").replace(/^0x/, "").slice(i * 64, (i + 1) * 64);
const addrFromWord = (w) => (typeof w === "string" && w.length >= 66 ? "0x" + w.slice(-40) : null);
const pad32 = (a) => "000000000000000000000000" + String(a).toLowerCase().replace(/^0x/, "");
const padNum = (n) => BigInt(n).toString(16).padStart(64, "0");
const bytes32 = (h) => String(h).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const ZERO32 = "0x" + "0".repeat(64);
const ZERO_ADDR = "0x" + "0".repeat(40);

/** A count decoded from the chain, clamped to something a loop may use. */
function countIn(hex, max = MAX_ITEMS) {
  const v = hexToBig(hex);
  return v > BigInt(max) ? max : Number(v);
}
/** A byte offset decoded from `hex`, or null when it points outside it. */
function offsetIn(hex, w) {
  const v = hexToBig(w);
  if (v > BigInt(byteLen(hex))) return null;
  const n = Number(v);
  return n % 32 === 0 ? n : null; // ABI offsets are word-aligned
}
/** Decode a solidity `string` at a byte offset inside `hex`. */
function strAt(hex, byteOffset) {
  try {
    if (byteOffset == null || byteOffset < 0 || byteOffset >= byteLen(hex)) return "";
    const b = String(hex).replace(/^0x/, "");
    const off = byteOffset * 2;
    const declared = Number(BigInt("0x" + b.slice(off, off + 64)));
    // Trust the smaller of what it claims and what is actually there.
    const len = Math.max(0, Math.min(declared, (b.length - off - 64) / 2));
    return Buffer.from(b.slice(off + 64, off + 64 + len * 2), "hex").toString("utf8");
  } catch (_) {
    return "";
  }
}
function decodeString(hex) {
  if (!hex) return "";
  return strAt(hex, offsetIn(hex, word(hex, 0)));
}
/** A bytes32 species tag, back to the text it was encoded from. */
function fromTag(hex) {
  try {
    const b = String(hex ?? "").replace(/^0x/, "");
    return Buffer.from(b, "hex").toString("utf8").replace(/\0+$/, "").replace(/[^\x20-\x7e]/g, "");
  } catch (_) {
    return "";
  }
}
const classesOf = (mask) => CLASSES.filter(([bit]) => (Number(mask) & bit) !== 0).map(([, n]) => n);

function makeRpc(url) {
  let id = 0;
  return async (method, params = []) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
}
const caller = (rpc) => (to, data) => rpc("eth_call", [{ to, data }, "latest"]).catch(() => null);

/**
 * One anchored observation, decoded.
 *
 * The Anchor struct is entirely fixed-size, so it comes back as nine inline
 * words with no offsets to trust.
 */
function decodeAnchor(raw) {
  if (!raw || byteLen(raw) < 9 * 32) return null;
  const anchoredAt = Number(hexToBig(word(raw, 4)));
  if (anchoredAt === 0) return null;
  return {
    plotId: word(raw, 0),
    prevId: word(raw, 1),
    species: fromTag(word(raw, 2)),
    anchoredBy: addrFromWord(word(raw, 3)),
    anchoredAt,
    liveCount: Number(hexToBig(word(raw, 5))),
    confirms: Number(hexToBig(word(raw, 6))),
    disputes: Number(hexToBig(word(raw, 7))),
    firstConfirmer: addrFromWord(word(raw, 8)),
  };
}

/** The licensed verifier behind a confirmation — licence, not name. */
async function verifierOf(c, attesterRegistry, address) {
  if (!attesterRegistry || !address || address === ZERO_ADDR) return null;
  const raw = await c(attesterRegistry, SEL.attesterOf + pad32(address));
  if (!raw) return null;
  // Attester { uint32 classes; bool suspended; string label; bytes32 licenceRef;
  //            uint64 registeredAt; uint64 confirmations; uint64 disputesRaised }
  const base = offsetIn(raw, word(raw, 0)); // dynamic struct (holds a string)
  if (base === null) return null;
  const head = (i) => word(raw, base / 32 + i);
  const labelOff = offsetIn(raw, head(2));
  return {
    address,
    classes: classesOf(hexToBig(head(0))),
    suspended: hexToBig(head(1)) !== 0n,
    label: labelOff === null ? "" : strAt(raw, base + labelOff),
    licenceRef: head(3),
    licensedSince: Number(hexToBig(head(4))),
    confirmations: Number(hexToBig(head(5))),
    disputesRaised: Number(hexToBig(head(6))),
  };
}

async function pledgesFor(c, pledgeAddr, plotIdHex) {
  if (!pledgeAddr) return [];
  const rawIds = await c(pledgeAddr, SEL.pledgesOfPlot + bytes32(plotIdHex));
  if (!rawIds) return [];
  const base = offsetIn(rawIds, word(rawIds, 0));
  if (base === null) return [];
  const n = countIn(word(rawIds, base / 32));
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = hexToBig(word(rawIds, base / 32 + 1 + i));
    const p = await decodePledge(c, pledgeAddr, id);
    if (p) out.push(p);
  }
  return out;
}

async function decodePledge(c, pledgeAddr, id) {
  const raw = await c(pledgeAddr, SEL.pledgeOf + padNum(id));
  if (!raw) return null;
  // Pledge { bytes32 plotId; address sponsor; address grower; address token;
  //          uint256 total; uint256 remaining; uint8 status; uint32 settledCount;
  //          string purpose }
  const base = offsetIn(raw, word(raw, 0));
  if (base === null) return null;
  const head = (i) => word(raw, base / 32 + i);
  const status = Number(hexToBig(head(6)));
  if (status === 0) return null;
  const purposeOff = offsetIn(raw, head(8));

  const count = countIn(await c(pledgeAddr, SEL.milestoneCount + padNum(id)));
  const milestones = [];
  for (let i = 0; i < count; i++) {
    const m = await c(pledgeAddr, SEL.milestoneOf + padNum(id) + padNum(i));
    // Milestone is entirely fixed-size: eight inline words.
    if (!m || byteLen(m) < 8 * 32) continue;
    milestones.push({
      index: i,
      notBefore: Number(hexToBig(word(m, 0))),
      deadline: Number(hexToBig(word(m, 1))),
      requiredCount: Number(hexToBig(word(m, 2))),
      // KHRt has 2 decimals; every amount here is riel.
      growerAmount: riel(hexToBig(word(m, 3))),
      verifierAmount: riel(hexToBig(word(m, 4))),
      status: MILESTONE_STATUS[Number(hexToBig(word(m, 5)))] ?? "unknown",
      provedBy: word(m, 6) === ZERO32 ? null : word(m, 6),
      paidVerifier: addrFromWord(word(m, 7)) === ZERO_ADDR ? null : addrFromWord(word(m, 7)),
    });
  }

  return {
    id: Number(id),
    sponsor: addrFromWord(head(1)),
    grower: addrFromWord(head(2)),
    token: addrFromWord(head(3)),
    total: riel(hexToBig(head(4))),
    remaining: riel(hexToBig(head(5))),
    status: PLEDGE_STATUS[status] ?? "unknown",
    purpose: purposeOff === null ? "" : strAt(raw, base + purposeOff),
    milestones,
  };
}

const riel = (units) => (Number(units) / 100).toFixed(2);

/**
 * Everything public about one plot: its anchored head record, whether a licensed
 * verifier stands behind it, the title token if one was issued, and any pledges
 * riding on it.
 *
 * @param plotIdHex keccak256 of the Grove plot id — the same 32 bytes CamboVerse
 *                  computes from the plot string it already has. The plot STRING
 *                  is deliberately not on chain: a garden's name is often the
 *                  owner's name.
 */
async function grovePlot(rpcUrl, deployments, plotIdHex) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(plotIdHex ?? ""))) {
    return { error: "plot must be a 0x-prefixed 32-byte hash" };
  }
  const d = deployments ?? {};
  const anchorAddr = d.contracts?.GroveAnchor;
  if (!anchorAddr) return { available: false, reason: "GroveAnchor is not deployed on this chain" };

  const c = caller(makeRpc(rpcUrl));
  const key = bytes32(plotIdHex);

  const [headId, length, steward, verifiedCount, required] = await Promise.all([
    c(anchorAddr, SEL.plotHead + key),
    c(anchorAddr, SEL.plotLength + key),
    c(anchorAddr, SEL.plotSteward + key),
    c(anchorAddr, SEL.verifiedCountOf + key),
    c(anchorAddr, SEL.requiredConfirmations),
  ]);

  if (!headId || word(headId, 0) === ZERO32) {
    return { available: true, plot: plotIdHex, anchored: false };
  }

  const observationId = word(headId, 0);
  const [rawAnchor, verified] = await Promise.all([
    c(anchorAddr, SEL.anchorOf + bytes32(observationId)),
    c(anchorAddr, SEL.isVerified + bytes32(observationId)),
  ]);
  const head = decodeAnchor(rawAnchor);

  const out = {
    available: true,
    plot: plotIdHex,
    anchored: true,
    chain: { contract: anchorAddr, chainId: d.chainId ?? null },
    steward: addrFromWord(steward),
    records: Number(hexToBig(length)),
    requiredConfirmations: Number(hexToBig(required)),
    // The verified living-tree count is the only number anything downstream is
    // allowed to trust — 0 means "nobody has confirmed the latest record",
    // never "there are no trees".
    verifiedCount: Number(hexToBig(verifiedCount)),
    head: head && {
      observationId,
      prevId: head.prevId === ZERO32 ? null : head.prevId,
      species: head.species,
      liveCount: head.liveCount,
      anchoredBy: head.anchoredBy,
      // Block time. The record's own `observedAt` is the phone's clock and is
      // not on chain; this is when a validator set first saw the hash.
      anchoredAt: head.anchoredAt,
      confirms: head.confirms,
      disputes: head.disputes,
      verified: hexToBig(verified) !== 0n,
    },
    verifier: head ? await verifierOf(c, d.contracts?.AttesterRegistry, head.firstConfirmer) : null,
    title: null,
    pledges: await pledgesFor(c, d.contracts?.GrovePledge, plotIdHex),
    disclaimer:
      "Estimates and counts, not certified credits. A signature proves who said something, " +
      "never that it is true; a licence makes someone accountable for having looked.",
  };

  const registryAddr = d.contracts?.GroveTitleRegistry;
  if (registryAddr) {
    const rawGrove = await c(registryAddr, SEL.groveOf + key);
    // Grove { bytes32 plotId; address token; address steward; string location;
    //         uint64 registeredAt; uint32 lastSyncedCount; uint64 lastSyncedAt; bool active }
    const base = rawGrove ? offsetIn(rawGrove, word(rawGrove, 0)) : null;
    if (base !== null) {
      const head2 = (i) => word(rawGrove, base / 32 + i);
      const token = addrFromWord(head2(1));
      if (token && token !== ZERO_ADDR) {
        const locOff = offsetIn(rawGrove, head2(3));
        const [name, symbol, supply, status] = await Promise.all([
          c(token, SEL.name),
          c(token, SEL.symbol),
          c(token, SEL.totalSupply),
          c(registryAddr, SEL.supplyStatus + key),
        ]);
        // supplyStatus returns (uint256, uint32, bool, string)
        const reasonOff = status ? offsetIn(status, word(status, 3)) : null;
        out.title = {
          token,
          name: decodeString(name),
          symbol: decodeString(symbol),
          location: locOff === null ? "" : strAt(rawGrove, base + locOff),
          registeredAt: Number(hexToBig(head2(4))),
          lastSyncedCount: Number(hexToBig(head2(5))),
          lastSyncedAt: Number(hexToBig(head2(6))),
          active: hexToBig(head2(7)) !== 0n,
          supply: Number(hexToBig(supply)),
          inSync: status ? hexToBig(word(status, 2)) !== 0n : false,
          driftReason: reasonOff === null ? "" : strAt(status, reasonOff),
        };
      }
    }
  }

  return out;
}

/** Chain-wide headline numbers, for a "what is out there" panel. */
async function groveStats(rpcUrl, deployments) {
  const d = deployments ?? {};
  const anchorAddr = d.contracts?.GroveAnchor;
  if (!anchorAddr) return { available: false, reason: "GroveAnchor is not deployed on this chain" };
  const c = caller(makeRpc(rpcUrl));
  const [observations, groves] = await Promise.all([
    c(anchorAddr, SEL.observationCount),
    d.contracts?.GroveTitleRegistry ? c(d.contracts.GroveTitleRegistry, SEL.groveCount) : null,
  ]);
  return {
    available: true,
    anchor: anchorAddr,
    attesterRegistry: d.contracts?.AttesterRegistry ?? null,
    titleRegistry: d.contracts?.GroveTitleRegistry ?? null,
    pledge: d.contracts?.GrovePledge ?? null,
    observations: Number(hexToBig(observations)),
    groves: Number(hexToBig(groves)),
  };
}

// A short cache so a page that polls, or a room full of phones opening the same
// virtual grove, does not turn into a load test on the RPC node.
const _cache = new Map();
async function cached(key, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await fn();
  _cache.set(key, { at: Date.now(), value });
  if (_cache.size > 256) _cache.delete(_cache.keys().next().value);
  return value;
}

module.exports = { grovePlot, groveStats, cached };
