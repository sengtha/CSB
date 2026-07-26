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
  canAnchor: "0xa924fda6", // canAnchor(address)
  canAttest: "0x37c716f1", // canAttest(address,bytes32)
  canClaim: "0xe1cb1cab", // canClaim(uint256,uint32,bytes32)
  totalSupply: "0x18160ddd", // totalSupply()
  balanceOf: "0x70a08231", // balanceOf(address)
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

/** Decode `(bool, string)` — the shape every canX() view returns. */
function decodeBoolString(hex) {
  if (!hex) return { ok: false, reason: "could not read the chain" };
  return { ok: hexToBig(word(hex, 0)) !== 0n, reason: strAt(hex, offsetIn(hex, word(hex, 1))) };
}

/**
 * The demo grove, for the public use-cases page — live, not a screenshot.
 *
 * Reads the ids `scripts/demo-grove.js` recorded and resolves them against the
 * chain right now. Assembled field by field from an explicit list: the demo
 * casts' private keys sit in the same file, and a response built by copying an
 * object and deleting from it is one careless edit away from serving them.
 */
async function groveDemo(rpcUrl, deployments) {
  const d = deployments ?? {};
  const demo = d.pilot?.grove?.demo;
  if (!demo?.plotId || !d.contracts?.GroveAnchor) return null;

  const plot = await grovePlot(rpcUrl, d, demo.plotId);
  if (!plot?.available || !plot.anchored) return null;

  const c = caller(makeRpc(rpcUrl));
  // Which candidate proofs exist on chain, so the page never offers one that
  // was never anchored — a "no such record" refusal teaches nothing.
  const observations = [];
  for (const o of (demo.observations ?? []).slice(0, MAX_ITEMS)) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(o?.id ?? ""))) continue;
    const a = decodeAnchor(await c(d.contracts.GroveAnchor, SEL.anchorOf + bytes32(o.id)));
    if (!a) continue;
    observations.push({
      id: o.id,
      label: String(o.label ?? ""),
      liveCount: a.liveCount,
      anchoredAt: a.anchoredAt,
      samePlot: a.plotId.toLowerCase() === String(demo.plotId).toLowerCase(),
      verified: a.disputes === 0 && a.confirms >= (plot.requiredConfirmations ?? 1),
    });
  }

  const attesters = [];
  for (const p of (demo.attesters ?? []).slice(0, MAX_ITEMS)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(p?.address ?? ""))) continue;
    attesters.push({ address: p.address, label: String(p.label ?? "") });
  }

  // A record nobody has confirmed yet, kept deliberately unattested so "who may
  // verify this?" stays a live question. Asking it about the main grove's head
  // would only ever answer "somebody already did", which demonstrates nothing.
  let showcase = null;
  if (/^0x[0-9a-fA-F]{64}$/.test(String(demo.showcase?.observationId ?? ""))) {
    const a = decodeAnchor(await c(d.contracts.GroveAnchor, SEL.anchorOf + bytes32(demo.showcase.observationId)));
    if (a) {
      showcase = {
        observationId: demo.showcase.observationId,
        liveCount: a.liveCount,
        anchoredAt: a.anchoredAt,
        confirms: a.confirms,
        disputes: a.disputes,
      };
    }
  }

  return {
    showcase,
    plotRef: String(demo.plotRef ?? ""),
    plotId: demo.plotId,
    pledgeId: Number(demo.pledgeId ?? 0) || null,
    milestone: Number(demo.milestone ?? 0),
    observations,
    attesters,
    plot,
  };
}

/**
 * A single canX() question, for the page's "Try it" panel.
 *
 * Read-only and public, like `/use-cases/check`: these are the same views a
 * wallet calls to explain a refusal before anyone signs. Nothing moves.
 */
async function groveCheck(rpcUrl, deployments, { kase, address, observationId, pledgeId, milestone } = {}) {
  const d = deployments ?? {};
  const c = caller(makeRpc(rpcUrl));

  if (kase === "anchor") {
    if (!d.contracts?.GroveAnchor) return { error: "GroveAnchor is not deployed on this chain" };
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(address ?? ""))) return { error: "that is not an address" };
    return decodeBoolString(await c(d.contracts.GroveAnchor, SEL.canAnchor + pad32(address)));
  }

  if (kase === "attest") {
    if (!d.contracts?.GroveAnchor) return { error: "GroveAnchor is not deployed on this chain" };
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(address ?? ""))) return { error: "that is not an address" };
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(observationId ?? ""))) return { error: "that is not an observation id" };
    return decodeBoolString(
      await c(d.contracts.GroveAnchor, SEL.canAttest + pad32(address) + bytes32(observationId)),
    );
  }

  if (kase === "claim") {
    if (!d.contracts?.GrovePledge) return { error: "GrovePledge is not deployed on this chain" };
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(observationId ?? ""))) return { error: "that is not an observation id" };
    const id = Number(pledgeId);
    const idx = Number(milestone ?? 0);
    if (!Number.isInteger(id) || id <= 0) return { error: "no pledge to check" };
    if (!Number.isInteger(idx) || idx < 0 || idx > 255) return { error: "no such milestone" };
    return decodeBoolString(
      await c(d.contracts.GrovePledge, SEL.canClaim + padNum(id) + padNum(idx) + bytes32(observationId)),
    );
  }

  return { error: "unknown check" };
}

/**
 * Every registered grove title, and what one address holds of each.
 *
 * Same line the asset viewer draws: this reports what EXISTS (public — a
 * registry of issued titles is meant to be checkable) plus the holdings of an
 * address the CALLER already knows. It cannot enumerate holders. A page that
 * let anyone browse who owns which grove would work around the read-privacy the
 * chain exists to provide, and a grove's holder is a farmer.
 */
async function groveTitles(rpcUrl, deployments, { address } = {}) {
  const d = deployments ?? {};
  const registryAddr = d.contracts?.GroveTitleRegistry;
  if (!registryAddr) return { available: false, reason: "GroveTitleRegistry is not deployed on this chain" };

  const c = caller(makeRpc(rpcUrl));
  const who = /^0x[0-9a-fA-F]{40}$/.test(String(address ?? "")) ? String(address) : null;
  const count = countIn(await c(registryAddr, SEL.groveCount));

  const groves = [];
  for (let i = 0; i < count; i++) {
    const plotId = await c(registryAddr, SEL.plotIdAt + padNum(i));
    if (!plotId || word(plotId, 0) === ZERO32) continue;
    const key = bytes32(word(plotId, 0));

    const raw = await c(registryAddr, SEL.groveOf + key);
    // Grove { bytes32 plotId; address token; address steward; string location;
    //         uint64 registeredAt; uint32 lastSyncedCount; uint64 lastSyncedAt; bool active }
    const base = raw ? offsetIn(raw, word(raw, 0)) : null;
    if (base === null) continue;
    const head = (j) => word(raw, base / 32 + j);
    const token = addrFromWord(head(1));
    if (!token || token === ZERO_ADDR) continue;

    const locOff = offsetIn(raw, head(3));
    const [name, symbol, supply, status] = await Promise.all([
      c(token, SEL.name),
      c(token, SEL.symbol),
      c(token, SEL.totalSupply),
      c(registryAddr, SEL.supplyStatus + key),
    ]);
    const reasonOff = status ? offsetIn(status, word(status, 3)) : null;

    const g = {
      plot: "0x" + key,
      token,
      name: decodeString(name),
      symbol: decodeString(symbol),
      location: locOff === null ? "" : strAt(raw, base + locOff),
      steward: addrFromWord(head(2)),
      registeredAt: Number(hexToBig(head(4))),
      lastSyncedCount: Number(hexToBig(head(5))),
      active: hexToBig(head(7)) !== 0n,
      // One share per verified living tree — the count a licensed verifier
      // confirmed, not the count anybody typed in.
      supply: Number(hexToBig(supply)),
      verifiedCount: status ? Number(hexToBig(word(status, 1))) : 0,
      inSync: status ? hexToBig(word(status, 2)) !== 0n : false,
      driftReason: reasonOff === null ? "" : strAt(status, reasonOff),
    };
    if (who) {
      const bal = await c(token, SEL.balanceOf + pad32(who));
      g.balance = Number(hexToBig(bal));
    }
    groves.push(g);
  }

  return {
    available: true,
    registry: registryAddr,
    address: who,
    groves,
    note:
      "One share is one living tree a licensed verifier confirmed. Supply is minted AND burned " +
      "to that count, so a grove token falls when the trees do. Not a carbon credit.",
  };
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

module.exports = { grovePlot, groveStats, groveDemo, groveCheck, groveTitles, cached };
