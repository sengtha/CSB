/**
 * Live data and rule checks for the three use-case demonstrations, so the page
 * can be TRIED rather than only read.
 *
 * Public and read-only, and deliberately so. Every check here is a `canX()` view
 * that the contracts already expose for wallets to call before anyone signs:
 * KHRStablecoin.canSpend, LandTitleToken.canTransfer, PaymentEscrow.canRelease.
 * They move nothing and cost nothing, and the REFUSALS are the demonstration —
 * "this assistance cannot be paid to a moneylender, and here is the reason the
 * chain gives" is the whole point, and it should not need a login to see.
 *
 * PRIVATE KEYS: the demo casts live in deployments.json alongside their keys.
 * Every response here is built field by field from an explicit list, never by
 * copying and deleting — so a key cannot reach this endpoint by someone later
 * adding a field to the file.
 */
const SEL = {
  // Hashed, not written from memory. A wrong selector returns a plausible zero
  // rather than an error, which is the worst kind of wrong.
  canSpend: "0x9f9417f8", // canSpend(address,address,uint256)
  unrestrictedBalanceOf: "0x5a06c016",
  restrictedBalance: "0xe4757c3f",
  restrictedProgram: "0xaa28402e",
  balanceOf: "0x70a08231",
  programOf: "0x95398365", // programOf(uint32)
  merchantOf: "0x6633f4e8",
  isRegistered: "0xc3c5a547",
  canTransfer: "0xe46638e6", // canTransfer(address,address,uint256)
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  totalSupply: "0x18160ddd",
  parcelOf: "0xb93b716c", // parcelOf(bytes32)
  parcelCount: "0xbaf65743",
  parcelIdAt: "0xe7299fa6",
  orderCount: "0x2453ffa8",
  orderOf: "0xc7e85f94",
  canRelease: "0xb2f70e96",
  isActive: "0x9f8a13d7",
  tierOf: "0xc8f74bb8",
};

// MerchantRegistry category bitmask, mirrored from the contract's constants.
const CATEGORIES = [
  [1 << 0, "food"], [1 << 1, "medicine"], [1 << 2, "education"],
  [1 << 3, "utilities"], [1 << 4, "transport"], [1 << 5, "agriculture"],
];
const ORDER_STATUS = ["none", "created", "funded", "released", "refunded", "disputed"];
const CACHE_MS = 6000;
let _cache = null;

const hexToBig = (h) => (typeof h === "string" && h !== "0x" ? BigInt(h) : 0n);
const pad32 = (a) => "000000000000000000000000" + String(a).toLowerCase().replace(/^0x/, "");
const padNum = (n) => BigInt(n).toString(16).padStart(64, "0");
const word = (hex, i) => "0x" + hex.replace(/^0x/, "").slice(i * 64, (i + 1) * 64);
const addrFromWord = (w) => (typeof w === "string" && w.length >= 66 ? "0x" + w.slice(-40) : null);
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a ?? ""));

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
const call = (rpc) => (to, data) =>
  rpc("eth_call", [{ to, data }, "latest"]).catch(() => null);

/** Decode a solidity `string` at a byte offset inside `hex`. */
function strAt(hex, byteOffset) {
  try {
    const b = hex.replace(/^0x/, "");
    const off = byteOffset * 2;
    const len = Number(BigInt("0x" + b.slice(off, off + 64)));
    return Buffer.from(b.slice(off + 64, off + 64 + len * 2), "hex").toString("utf8");
  } catch (_) { return ""; }
}
/** Decode a top-level `string` return value. */
function decodeString(hex) {
  if (!hex) return "";
  return strAt(hex, Number(hexToBig(word(hex, 0))));
}
/** Decode `(bool, string)` — the shape every canX() helper returns. */
function decodeBoolString(hex) {
  if (!hex) return { ok: false, reason: "could not read the chain" };
  return { ok: hexToBig(word(hex, 0)) !== 0n, reason: strAt(hex, Number(hexToBig(word(hex, 1)))) };
}

function categoriesOf(mask) {
  return CATEGORIES.filter(([bit]) => (Number(mask) & bit) !== 0).map(([, n]) => n);
}
/** KHRt has 2 decimals; every amount on this page is riel. */
const riel = (units) => (Number(units) / 100).toFixed(2);
const toUnits = (amount) => {
  const n = Number(String(amount ?? "").replaceAll(",", ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return BigInt(Math.round(n * 100));
};

/** Public facts about one participant. Never includes the key. */
async function party(c, identity, entry, label) {
  if (!entry?.address) return null;
  const [active, tier] = await Promise.all([
    c(identity, SEL.isActive + pad32(entry.address)),
    c(identity, SEL.tierOf + pad32(entry.address)),
  ]);
  return {
    label: label ?? entry.label ?? "",
    address: entry.address,
    kyc: hexToBig(active) !== 0n,
    tier: Number(hexToBig(tier)),
  };
}

async function idpoorData(c, d, cast) {
  const khr = d.contracts.KHRStablecoin;
  const identity = d.contracts.IdentityRegistry;
  const [household, grocer, lender] = await Promise.all([
    party(c, identity, cast.household, "Household (assistance recipient)"),
    party(c, identity, cast.grocer, "Licensed food merchant"),
    party(c, identity, cast.lender, "Moneylender (not a licensed merchant)"),
  ]);
  if (!household) return null;

  const [total, restricted, free, prog] = await Promise.all([
    c(khr, SEL.balanceOf + pad32(household.address)),
    c(khr, SEL.restrictedBalance + pad32(household.address)),
    c(khr, SEL.unrestrictedBalanceOf + pad32(household.address)),
    c(khr, SEL.restrictedProgram + pad32(household.address)),
  ]);

  let program = null;
  const programId = Number(hexToBig(prog)) || Number(cast.programId ?? 0);
  if (d.contracts.SocialProgramRegistry && programId) {
    const raw = await c(d.contracts.SocialProgramRegistry, SEL.programOf + padNum(programId));
    if (raw) {
      // Program { string label; uint32 allowedCategories; uint64 expiresAt; bool active; bool allowMerchantToMerchant }
      const base = Number(hexToBig(word(raw, 0))); // struct is dynamic (has a string)
      const head = (i) => word(raw, base / 32 + i);
      program = {
        id: programId,
        label: strAt(raw, base + Number(hexToBig(head(0)))),
        categories: categoriesOf(hexToBig(head(1))),
        expiresAt: Number(hexToBig(head(2))),
        active: hexToBig(head(3)) !== 0n,
      };
    }
  }

  // What each merchant is licensed for — the fact the policy is matched against.
  const licence = async (p) => {
    if (!p || !d.contracts.MerchantRegistry) return null;
    const raw = await c(d.contracts.MerchantRegistry, SEL.merchantOf + pad32(p.address));
    if (!raw) return null;
    const base = Number(hexToBig(word(raw, 0)));
    const head = (i) => word(raw, base / 32 + i);
    return {
      registered: hexToBig(head(0)) !== 0n,
      categories: categoriesOf(hexToBig(head(0))),
      suspended: hexToBig(head(1)) !== 0n,
      label: strAt(raw, base + Number(hexToBig(head(2)))),
    };
  };
  const [grocerLic, lenderLic] = await Promise.all([licence(grocer), licence(lender)]);

  return {
    token: khr,
    household: {
      ...household,
      balance: riel(hexToBig(total)),
      restricted: riel(hexToBig(restricted)),
      spendable: riel(hexToBig(free)),
    },
    program,
    payees: [
      grocer && { ...grocer, licence: grocerLic },
      lender && { ...lender, licence: lenderLic },
    ].filter(Boolean),
  };
}

async function landData(c, d, cast) {
  const registry = d.contracts.LandTitleRegistry;
  if (!registry) return null;
  const count = Number(hexToBig(await c(registry, SEL.parcelCount)));
  if (!count) return null;
  const parcelId = await c(registry, SEL.parcelIdAt + padNum(count - 1));
  if (!parcelId) return null;

  const raw = await c(registry, SEL.parcelOf + parcelId.replace(/^0x/, ""));
  if (!raw) return null;
  // Parcel { bytes32 parcelId; address token; string location; uint256 areaSqm;
  //          uint256 totalShares; uint64 registeredAt; bool active }
  const base = Number(hexToBig(word(raw, 0)));
  const head = (i) => word(raw, base / 32 + i);
  const token = addrFromWord(head(1));
  const [name, symbol, supply] = await Promise.all([
    c(token, SEL.name), c(token, SEL.symbol), c(token, SEL.totalSupply),
  ]);
  const identity = d.contracts.IdentityRegistry;
  const [owner, buyer] = await Promise.all([
    party(c, identity, cast.owner, "Landowner"),
    party(c, identity, cast.buyer, "Co-investor (KYC tier 3)"),
  ]);
  const holdings = async (p) => (p
    ? { ...p, shares: Number(hexToBig(await c(token, SEL.balanceOf + pad32(p.address)))) }
    : null);

  return {
    token,
    name: name ? decodeString(name) : "",
    symbol: symbol ? decodeString(symbol) : "",
    location: strAt(raw, base + Number(hexToBig(head(2)))),
    areaSqm: Number(hexToBig(head(3))),
    totalShares: Number(hexToBig(supply ?? head(4))),
    active: hexToBig(head(6)) !== 0n,
    holders: [await holdings(owner), await holdings(buyer)].filter(Boolean),
  };
}

async function escrowData(c, d, cast) {
  const escrow = d.contracts.PaymentEscrow;
  if (!escrow) return null;
  const count = Number(hexToBig(await c(escrow, SEL.orderCount)));
  if (!count) return null;

  // Several orders, newest last. The demo deliberately creates one that settles
  // and one that compliance refuses; showing only the newest would hide whichever
  // half ran last, and the pair together is the point.
  const ids = [];
  for (let i = Math.max(1, count - 2); i <= count; i++) ids.push(i);
  const orders = (await Promise.all(ids.map((i) => order(c, escrow, i, cast)))).filter(Boolean);
  return { escrow, orders, latest: orders[orders.length - 1]?.orderId ?? count };
}

async function order(c, escrow, id, cast) {
  const raw = await c(escrow, SEL.orderOf + padNum(id));
  if (!raw) return null;
  // Order { bytes32 ref; address payer; address token; uint256 total;
  //         uint64 deadline; Status status; address[] payees; uint256[] amounts }
  const base = Number(hexToBig(word(raw, 0)));
  const head = (i) => word(raw, base / 32 + i);
  const arr = (offsetWord) => {
    const at = base + Number(hexToBig(offsetWord));
    const n = Number(hexToBig(word(raw, at / 32)));
    return Array.from({ length: n }, (_, i) => word(raw, at / 32 + 1 + i));
  };
  const payees = arr(head(6)).map(addrFromWord);
  const amounts = arr(head(7)).map(hexToBig);

  // Name the payees from the cast where we can — an address alone tells the
  // reader nothing about who is being paid.
  const named = {};
  for (const [k, v] of Object.entries(cast ?? {})) {
    if (v?.address) named[v.address.toLowerCase()] = v.label ?? k;
  }

  const release = decodeBoolString(await c(escrow, SEL.canRelease + padNum(id)));
  return {
    orderId: id,
    status: ORDER_STATUS[Number(hexToBig(head(5)))] ?? "unknown",
    total: riel(hexToBig(head(3))),
    deadline: Number(hexToBig(head(4))),
    payer: addrFromWord(head(1)),
    payerLabel: named[String(addrFromWord(head(1))).toLowerCase()] ?? "Customer",
    split: payees.map((p, i) => ({
      address: p,
      label: named[String(p).toLowerCase()] ?? "Payee",
      amount: riel(amounts[i] ?? 0n),
    })),
    canRelease: release,
  };
}

/** Everything the use-cases page shows. Never any private key. */
async function useCases(rpcUrl, deployments) {
  const now = Date.now();
  if (_cache && now - _cache.at < CACHE_MS) return _cache.data;
  if (!deployments?.contracts?.KHRStablecoin) {
    const e = new Error("No deployment on this chain yet.");
    e.code = "NO_DEPLOYMENT";
    throw e;
  }
  const c = call(makeRpc(rpcUrl));
  const pilot = deployments.pilot ?? {};
  const [idpoor, land, escrow] = await Promise.all([
    pilot.idpoor ? idpoorData(c, deployments, pilot.idpoor).catch(() => null) : null,
    pilot.land ? landData(c, deployments, pilot.land).catch(() => null) : null,
    pilot.escrow ? escrowData(c, deployments, pilot.escrow).catch(() => null) : null,
  ]);
  const data = { idpoor, land, escrow, updatedAt: new Date().toISOString() };
  _cache = { at: now, data };
  return data;
}

/**
 * Ask the chain whether a specific action would be permitted, WITHOUT doing it.
 * `to` is caller-supplied on purpose: the interesting answer is the one for an
 * address the visitor chose, including their own.
 */
async function useCaseCheck(rpcUrl, deployments, { kase, to, amount }) {
  const c = call(makeRpc(rpcUrl));
  const d = deployments ?? {};
  const bad = (reason) => ({ ok: false, reason });

  if (kase === "idpoor") {
    const from = d.pilot?.idpoor?.household?.address;
    if (!from) return bad("the ID-Poor demo has not been set up on this chain");
    if (!isAddr(to)) return bad("enter a valid 0x address to pay");
    const units = toUnits(amount);
    if (units === null || units === 0n) return bad("enter an amount greater than zero");
    const raw = await c(d.contracts.KHRStablecoin,
      SEL.canSpend + pad32(from) + pad32(to) + padNum(units));
    const r = decodeBoolString(raw);
    return { ...r, from, to, amount: riel(units) };
  }

  if (kase === "land") {
    const from = d.pilot?.land?.owner?.address;
    const land = await landData(c, d, d.pilot?.land ?? {}).catch(() => null);
    if (!from || !land?.token) return bad("the land demo has not been set up on this chain");
    if (!isAddr(to)) return bad("enter a valid 0x address to transfer to");
    const shares = Number(String(amount ?? "").replaceAll(",", ""));
    if (!Number.isFinite(shares) || shares <= 0) return bad("enter a number of shares greater than zero");
    const raw = await c(land.token, SEL.canTransfer + pad32(from) + pad32(to) + padNum(Math.round(shares)));
    const r = decodeBoolString(raw);
    return { ...r, from, to, amount: String(Math.round(shares)), token: land.token };
  }

  if (kase === "escrow") {
    const escrow = d.contracts?.PaymentEscrow;
    if (!escrow) return bad("the escrow demo has not been set up on this chain");
    const id = Number(amount);
    if (!Number.isInteger(id) || id <= 0) return bad("enter an order number");
    const r = decodeBoolString(await c(escrow, SEL.canRelease + padNum(id)));
    return { ...r, orderId: id };
  }

  return bad("unknown check");
}

module.exports = { useCases, useCaseCheck, _internal: { decodeBoolString, categoriesOf, riel, toUnits } };
