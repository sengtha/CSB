/* Shared helpers for the CSB demo UIs. Requires vendor/ethers.umd.min.js. */
"use strict";

const ABI = {
  IdentityRegistry: [
    "function register(address account, bytes32 identity, uint8 tier)",
    "function revoke(address account)",
    "function suspend(address account)",
    "function reactivate(address account)",
    "function setTier(address account, uint8 newTier)",
    "function increaseAddressQuota(bytes32 identity, uint32 newQuota, bytes32 paymentRef)",
    "function addressQuota(bytes32 identity) view returns (uint32)",
    "function addressCount(bytes32 identity) view returns (uint32)",
    "function isActive(address account) view returns (bool)",
    "function tierOf(address account) view returns (uint8)",
    "function attestationOf(address account) view returns (tuple(bytes32 identity, uint8 tier, uint8 status, uint64 issuedAt))",
    "event AddressRegistered(address indexed account, bytes32 indexed identity, uint8 tier)",
    "event AddressRevoked(address indexed account, bytes32 indexed identity)",
    "event AddressSuspended(address indexed account, bytes32 indexed identity)",
    "event AddressReactivated(address indexed account, bytes32 indexed identity)",
    "event TierChanged(address indexed account, uint8 oldTier, uint8 newTier)",
    "event AddressQuotaIncreased(bytes32 indexed identity, uint32 newQuota, bytes32 paymentRef)",
    "error InvalidTier(uint8 tier)",
    "error AlreadyRegistered(address account)",
    "error NotRegistered(address account)",
    "error QuotaExceeded(bytes32 identity, uint32 quota)",
    "error WrongStatus(address account, uint8 actual)",
  ],
  EnforcementRegistry: [
    "function freeze(address account, bytes32 orderRef)",
    "function unfreeze(address account, bytes32 orderRef)",
    "function isFrozen(address account) view returns (bool)",
    "event Frozen(address indexed account, bytes32 indexed orderRef)",
    "event Unfrozen(address indexed account, bytes32 indexed orderRef)",
    "error OrderRefRequired()",
  ],
  KHRStablecoin: [
    "function balanceOf(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function transfer(address to, uint256 value) returns (bool)",
    "function approve(address spender, uint256 value) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function issue(address to, uint256 amount)",
    "function redeem(uint256 amount)",
    "function confiscate(address from, address to, uint256 amount, bytes32 orderRef)",
    "function setTierTransferCap(uint8 tier, uint256 cap)",
    "function setSystemContract(address account, bool allowed)",
    "function setTransferLevy(uint256 levy, address recipient)",
    "function setLevyExempt(address account, bool exempt)",
    "function tierTransferCap(uint8 tier) view returns (uint256)",
    "function isSystemContract(address) view returns (bool)",
    "function transferLevy() view returns (uint256)",
    "function levyRecipient() view returns (address)",
    "function totalLevied() view returns (uint256)",
    "event TransferLevySet(uint256 levy, address indexed recipient)",
    "event LevyCollected(address indexed from, address indexed recipient, uint256 amount)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "event Issued(address indexed to, uint256 amount)",
    "event Redeemed(address indexed from, uint256 amount)",
    "event Confiscated(address indexed from, address indexed to, uint256 amount, bytes32 indexed orderRef)",
    "event TierTransferCapSet(uint8 indexed tier, uint256 cap)",
    "event SystemContractSet(address indexed account, bool allowed)",
    "error NotKycActive(address account)",
    "error AccountFrozen(address account)",
    "error TierCapExceeded(address account, uint8 tier, uint256 cap, uint256 amount)",
    "error OrderRefRequired()",
    "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
    "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  ],
  GroveAnchor: [
    "function anchor(bytes32 observationId, bytes32 plotId, bytes32 prevId, uint32 liveCount, bytes32 species) returns (uint64)",
    "function attest(bytes32 observationId, bool confirm, bytes32 noteRef)",
    "function setPlotRecorder(bytes32 plotId, address recorder, bool allowed)",
    "function anchorOf(bytes32 observationId) view returns (tuple(bytes32 plotId, bytes32 prevId, bytes32 species, address anchoredBy, uint64 anchoredAt, uint32 liveCount, uint32 confirms, uint32 disputes, address firstConfirmer))",
    "function isAnchored(bytes32 observationId) view returns (bool)",
    "function isVerified(bytes32 observationId) view returns (bool)",
    "function verifiedCountOf(bytes32 plotId) view returns (uint32)",
    "function plotHead(bytes32 plotId) view returns (bytes32)",
    "function plotLength(bytes32 plotId) view returns (uint32)",
    "function plotSteward(bytes32 plotId) view returns (address)",
    "function requiredConfirmations() view returns (uint32)",
    "function canAnchor(address who) view returns (bool ok, string reason)",
    "function canAttest(address who, bytes32 observationId) view returns (bool ok, string reason)",
    "event Anchored(bytes32 indexed observationId, bytes32 indexed plotId, address indexed anchoredBy, bytes32 prevId, uint32 liveCount, uint64 anchoredAt)",
    "event Attested(bytes32 indexed observationId, address indexed attester, bool confirmed, uint32 confirms, uint32 disputes, bytes32 noteRef)",
    "error NotLicensedAttester(address account)",
    "error SelfAttestation(bytes32 observationId, address attester)",
    "error AlreadyAttested(bytes32 observationId, address attester)",
    "error UnknownObservation(bytes32 observationId)",
    "error NotVerifiedIdentity(address account)",
    "error AccountFrozen(address account)",
    "error NotPlotRecorder(bytes32 plotId, address caller)",
    "error PrevNotHead(bytes32 plotId, bytes32 head, bytes32 given)",
    "error AlreadyAnchored(bytes32 observationId)",
  ],
  GroveTitleRegistry: [
    "function registerGrove(tuple(bytes32 plotId, string name, string symbol, string location, string groveURI, uint8 minimumTier, address steward) p) returns (address)",
    "function syncSupply(bytes32 plotId) returns (uint32)",
    "function setGroveActive(bytes32 plotId, bool active, bytes32 reason)",
    "function groveOf(bytes32 plotId) view returns (tuple(bytes32 plotId, address token, address steward, string location, uint64 registeredAt, uint32 lastSyncedCount, uint64 lastSyncedAt, bool active))",
    "function groveCount() view returns (uint256)",
    "function supplyStatus(bytes32 plotId) view returns (uint256 supply, uint32 verifiedCount, bool inSync, string reason)",
    "error NoVerifiedRecord(bytes32 plotId)",
    "error NotThePlotSteward(bytes32 plotId, address given, address actual)",
    "error GroveAlreadyRegistered(bytes32 plotId, address token)",
    "error SupplyDriftUnresolved(bytes32 plotId, uint256 shortfall, uint256 stewardBalance)",
  ],
  AttesterRegistry: [
    "function licenseAttester(address attester, uint32 classes, bytes32 licenceRef, string label)",
    "function setSuspended(address attester, bool suspended)",
    "function removeAttester(address attester)",
    "function attesterOf(address attester) view returns (tuple(uint32 classes, bool suspended, string label, bytes32 licenceRef, uint64 registeredAt, uint64 confirmations, uint64 disputesRaised))",
    "function isLicensed(address attester) view returns (bool)",
    "function isRegistered(address attester) view returns (bool)",
    "function attesterCount() view returns (uint256)",
    "function attesterAt(uint256 i) view returns (address)",
    "function AGRONOMIST() view returns (uint32)",
    "event AttesterLicensed(address indexed attester, uint32 classes, bytes32 licenceRef, string label)",
    "event AttesterSuspended(address indexed attester, bool suspended)",
    "error NotLicensed(address attester)",
    "error NoClasses()",
  ],
  EgressGateway: [
    "function requestEgress(address token, uint256 amount, bytes32 destinationChain, bytes recipient)",
    "function setTokenPolicy(address token, bool allowed, uint8 minTier, uint256 dailyCap, address adapter)",
    "function pause()",
    "function unpause()",
    "function paused() view returns (bool)",
    "function policies(address token) view returns (bool allowed, uint8 minTier, uint256 dailyCap, address adapter)",
    "function dailyVolume(address token, uint256 day) view returns (uint256)",
    "event TokenPolicySet(address indexed token, bool allowed, uint8 minTier, uint256 dailyCap, address adapter)",
    "event EgressInitiated(address indexed initiator, address indexed token, uint256 amount, bytes32 indexed destinationChain, bytes recipient)",
    "error TokenNotPermitted(address token)",
    "error NotKycActive(address account)",
    "error AccountFrozen(address account)",
    "error TierTooLow(address account, uint8 tier, uint8 required)",
    "error DailyCapExceeded(address token, uint256 cap, uint256 attempted)",
    "error EnforcedPause()",
  ],
  RielConverter: [
    "function wrap(address token, uint256 amount)",
    "function unwrap(address token, uint256 amount) payable",
    "function approved(address token) view returns (bool)",
    "function scale(address token) view returns (uint256)",
    "event Wrapped(address indexed account, address indexed token, uint256 tokenAmount, uint256 trielAmount)",
    "event Unwrapped(address indexed account, address indexed token, uint256 tokenAmount, uint256 trielAmount)",
    "error TokenNotApproved(address token)",
    "error ZeroAmount()",
    "error WrongValue(uint256 expected, uint256 sent)",
    "error BurnFailed()",
    "error UnsupportedDecimals(uint8 tokenDecimals)",
  ],
  RielPay: [
    "function pay(address to, bytes32 memo) payable",
    "function quoteLevy(address from, address to, uint256 amount) view returns (uint256)",
    "function levyBps() view returns (uint16)",
    "function publicFund() view returns (address)",
    "function totalRaised() view returns (uint256)",
    "event Paid(address indexed from, address indexed to, uint256 net, uint256 levy, bytes32 memo)",
    "error ZeroAddress()",
    "error ZeroAmount()",
    "error EnforcedPause()",
  ],
  // Subnet-EVM allow-list precompiles. Same interface at both addresses; the
  // one difference is what being on the list permits.
  AllowList: [
    "function setEnabled(address addr)",
    "function setNone(address addr)",
    "function readAllowList(address addr) view returns (uint256)",
  ],
  Common: [
    "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
    "error OwnableUnauthorizedAccount(address account)",
  ],
};

const FRIENDLY = {
  NotKycActive: (a) => `Blocked: ${short(a[0])} has no active KYC attestation (Identity Authority).`,
  AccountFrozen: (a) => `Blocked: ${short(a[0])} is frozen by the enforcement authority.`,
  TierCapExceeded: (a) => `Blocked: tier-${a[1]} per-transfer cap is ${fmtKHR(a[2])} KHRt (attempted ${fmtKHR(a[3])}).`,
  TokenNotPermitted: () => "Blocked: this token is not on the council's egress allowlist.",
  TierTooLow: (a) => `Blocked: egress of this token requires KYC tier ${a[2]} (account is tier ${a[1]}).`,
  DailyCapExceeded: (a) => `Blocked: daily egress cap ${fmtKHR(a[1])} KHRt would be exceeded (${fmtKHR(a[2])}).`,
  EnforcedPause: () => "Blocked: the egress gateway is paused (council circuit breaker).",
  QuotaExceeded: (a) => `Blocked: identity already uses all ${a[1]} address slot(s). Additional slots require an Identity Authority fee.`,
  AlreadyRegistered: (a) => `Blocked: ${short(a[0])} already holds an attestation.`,
  AccessControlUnauthorizedAccount: (a) => `Blocked: ${short(a[0])} does not hold the required role (separation of powers).`,
  OwnableUnauthorizedAccount: (a) => `Blocked: ${short(a[0])} is not the owner of this contract.`,
  OrderRefRequired: () => "Blocked: enforcement actions require a court/AML order reference.",
  TokenNotApproved: () => "Blocked: the council has not approved this token for 1:1 conversion into tRIEL.",
  WrongValue: (a) => `Blocked: this unwrap needs exactly ${ethers.formatEther(a[0])} tRIEL (sent ${ethers.formatEther(a[1])}).`,
  UnsupportedDecimals: (a) => `Blocked: a token with ${a[0]} decimals cannot be converted.`,
  BurnFailed: () => "Blocked: the tRIEL burn did not go through — nothing was converted.",
  ZeroAmount: () => "Enter an amount greater than zero.",
  ERC20InsufficientBalance: (a) => `Blocked: insufficient balance (${fmtKHR(a[1])} KHRt available).`,
  ERC20InsufficientAllowance: () => "Blocked: gateway allowance too low — approve first.",
};

/**
 * CSB is permissioned BELOW the contract layer. Two Subnet-EVM precompiles decide
 * what an address may do at all, before any contract's rules apply:
 *
 *   txAllowList  — may this address submit ANY transaction? An address that is
 *                  not on it is refused by the node itself, with
 *                  "cannot issue transaction from non-allow listed address" —
 *                  no matter how well KYC'd it is in the IdentityRegistry.
 *   deployer     — may this address CREATE contracts?
 *
 * KYC and these lists answer different questions and are granted separately:
 * the list is "may you transact", KYC is "may you hold regulated money".
 */
const ALLOWLIST = {
  tx: "0x0200000000000000000000000000000000000002",
  deployer: "0x0200000000000000000000000000000000000000",
};
const ALLOWLIST_ROLE = { 0: "none", 1: "enabled", 2: "admin", 3: "manager" };

function allowList(which, runner) {
  return new ethers.Contract(ALLOWLIST[which], ABI.AllowList, runner ?? getProvider());
}

const STATUS_NAMES = ["none", "active", "suspended", "revoked"];
const TIER_NAMES = { 0: "—", 1: "1 · citizen basic", 2: "2 · full KYC", 3: "3 · business", 4: "4 · institutional" };

let _provider, _config, _contracts;

function getProvider() {
  if (!_provider) {
    // cacheTimeout: -1 disables ethers' 250ms de-duplication of identical calls.
    // It is a trap on an instant-finality chain: a pre-flight balance check and
    // the post-transaction refresh land inside the same 250ms window, so the
    // refresh serves the PRE-transaction balance and the page appears to say the
    // transaction did nothing. A handful of duplicate reads is a fair price for a
    // balance that is never a lie.
    _provider = new ethers.JsonRpcProvider(location.origin + "/rpc", undefined, {
      batchMaxCount: 1, cacheTimeout: -1,
    });
  }
  return _provider;
}

async function loadConfig() {
  if (!_config) {
    const r = await fetch("/config");
    if (!r.ok) throw new Error("deployments.json not found — run deploy + seed scripts");
    _config = await r.json();
  }
  return _config;
}

async function getContracts(runner) {
  const cfg = await loadConfig();
  const r = runner ?? getProvider();
  return {
    identity: new ethers.Contract(cfg.contracts.IdentityRegistry, ABI.IdentityRegistry, r),
    enforcement: new ethers.Contract(cfg.contracts.EnforcementRegistry, ABI.EnforcementRegistry, r),
    khr: new ethers.Contract(cfg.contracts.KHRStablecoin, ABI.KHRStablecoin, r),
    gateway: new ethers.Contract(cfg.contracts.EgressGateway, ABI.EgressGateway, r),
    // RielPay is optional — only present on chains deployed with it.
    rielPay: cfg.contracts.RielPay ? new ethers.Contract(cfg.contracts.RielPay, ABI.RielPay, r) : null,
    // Likewise the converter: a deployment without it simply has no swap.
    converter: cfg.contracts.RielConverter
      ? new ethers.Contract(cfg.contracts.RielConverter, ABI.RielConverter, r) : null,
    // Grove: present only on chains where scripts/deploy-grove.js has run.
    groveAnchor: cfg.contracts.GroveAnchor
      ? new ethers.Contract(cfg.contracts.GroveAnchor, ABI.GroveAnchor, r) : null,
    groveTitles: cfg.contracts.GroveTitleRegistry
      ? new ethers.Contract(cfg.contracts.GroveTitleRegistry, ABI.GroveTitleRegistry, r) : null,
    attesters: cfg.contracts.AttesterRegistry
      ? new ethers.Contract(cfg.contracts.AttesterRegistry, ABI.AttesterRegistry, r) : null,
  };
}

function allInterfaces() {
  return Object.values(ABI).map((frags) => new ethers.Interface(frags));
}

// Explicit transaction fees priced well above the current base fee. This chain's
// effective base fee can jump above the fee floor (Subnet-EVM block gas cost), and
// ethers' automatic estimate can under-price a tx so it never mines and tx.wait()
// hangs — which makes a button look "stuck". Overpaying is harmless: the node only
// charges the real base fee. Pass the result as the last arg to a contract call.
async function feeOverrides() {
  const provider = getProvider();
  const [block, feeData] = await Promise.all([
    provider.getBlock("latest"),
    provider.getFeeData().catch(() => ({})),
  ]);
  // UNKNOWN IS NOT ZERO. This previously read `baseFeePerGas ?? 0n`, so a block
  // that did not report a base fee produced a ZERO-priced transaction — which
  // on a chain with a 47,619 gwei floor can never be mined. It is accepted,
  // sits in the mempool forever, and the UI waits on it forever: a button that
  // says "Working…" and never finishes. Free gas is a real configuration, but
  // only when the chain actually says the base fee is zero.
  const baseFee = block?.baseFeePerGas;
  const suggested = feeData?.gasPrice ?? feeData?.maxFeePerGas ?? null;

  if (baseFee === 0n && (suggested === null || suggested === 0n)) {
    return { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }; // genuinely free
  }

  // Price well above the floor: overpaying is harmless because the node only
  // charges the real base fee, while underpaying is an invisible hang.
  const fromBase = baseFee != null ? baseFee * 3n + ethers.parseUnits("500", "gwei") : 0n;
  const fromSuggested = suggested != null ? suggested * 2n : 0n;
  const maxFeePerGas = fromBase > fromSuggested ? fromBase : fromSuggested;

  if (maxFeePerGas === 0n) {
    throw new Error(
      "Could not read a gas price from the node, so this transaction would be sent "
      + "priced at zero and would never be mined. Check the chain is serving."
    );
  }
  return { maxFeePerGas, maxPriorityFeePerGas: ethers.parseUnits("2", "gwei") };
}

function explainError(e) {
  // Native-gas shortfall: the sender holds KHRt but no tRIEL to pay gas, so the
  // node rejects the tx up front. Give an actionable message instead of the raw
  // "insufficient funds" string (fix: scripts/fund-native.js on the chain host).
  const msg = String(e?.shortMessage ?? e?.message ?? "");
  if (e?.code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(msg)) {
    return "This account has no tRIEL to pay gas. An operator must fund it (scripts/fund-native.js) before it can transact.";
  }
  const data = e?.info?.error?.data ?? e?.data ?? e?.error?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    for (const iface of allInterfaces()) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) {
          const f = FRIENDLY[parsed.name];
          return f ? f(parsed.args) : `${parsed.name}(${parsed.args.map(String).join(", ")})`;
        }
      } catch (_) { /* try next */ }
    }
  }
  return e?.shortMessage ?? e?.message ?? String(e);
}

/**
 * THE RIEL HAS NO SUBUNIT. There is no circulating fraction of a riel — prices are
 * quoted in whole riel and always have been. The token nevertheless carries two
 * decimals, which is a precision choice for the ledger (percentage levies and
 * interest accrual both need sub-unit room to be representable at ordinary amounts),
 * NOT a claim that centimes exist.
 *
 * So this used to force ".00" onto every figure via minimumFractionDigits, which
 * asserted a subunit on every screen in the app. It now shows whole riel when the
 * amount is whole and reveals the fraction only when there genuinely is one — which
 * in practice means balances touched by Aave's index, the one mechanism here that
 * creates sub-riel quantities. Nothing is hidden; the display simply stops claiming
 * precision the currency does not have.
 */
function fmtKHR(units) {
  return Number(ethers.formatUnits(units, 2))
    .toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function parseKHR(str) {
  return ethers.parseUnits(String(str).replaceAll(",", ""), 2);
}
function short(addr) {
  const a = String(addr);
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
function shortHash(h) {
  const s = String(h);
  return `${s.slice(0, 10)}…`;
}

function banner(el, kind, msg) {
  el.className = `banner ${kind}`;
  el.textContent = msg;
}

async function ensureSession() {
  const r = await fetch("/session");
  const { authed } = await r.json();
  if (authed) return;
  const overlay = document.createElement("div");
  overlay.id = "login-overlay";
  // A plain <form> with a standard, visible text input. No -webkit-text-security
  // masking (which rendered blank on some browsers) and no password-manager
  // triggers. The passcode is a shared demo gate that also travels in the ?pw=
  // URL, so masking bought nothing — reliability matters more here.
  overlay.innerHTML = `
    <form class="box" id="pcform" autocomplete="off">
      <h2>🇰🇭 CSB — Restricted Access</h2>
      <p>This explorer and its chain data are accessible to authorized users only.
         Production replaces this passcode with national digital-identity login.</p>
      <label for="pc">Access passcode</label>
      <input id="pc" type="text" autocomplete="off" autocapitalize="off"
             autocorrect="off" spellcheck="false" />
      <div id="pcerr" class="banner"></div>
      <button id="pcgo" type="submit">Enter</button>
    </form>`;
  document.body.appendChild(overlay);
  const pcEl = overlay.querySelector("#pc");
  const form = overlay.querySelector("#pcform");
  return new Promise((resolve) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); // never navigate — submit is our trigger
      // Strip zero-width chars some keyboards inject, then trim ends.
      const passcode = pcEl.value.replace(/[​-‍﻿]/g, "").trim();
      const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      if (res.ok) {
        overlay.remove();
        resolve();
      } else {
        banner(overlay.querySelector("#pcerr"), "err", `Invalid passcode (sent ${passcode.length} chars).`);
        pcEl.focus();
        pcEl.select();
      }
    });
    setTimeout(() => pcEl.focus(), 50); // ensure keystrokes land in the field
  });
}

async function kycSummary(addr) {
  const { identity, enforcement, khr } = await getContracts();
  const [att, frozen, bal, sys] = await Promise.all([
    identity.attestationOf(addr),
    enforcement.isFrozen(addr),
    khr.balanceOf(addr),
    khr.isSystemContract(addr),
  ]);
  return {
    status: STATUS_NAMES[Number(att.status)] ?? "?",
    tier: Number(att.tier),
    identity: att.identity,
    frozen,
    balance: bal,
    system: sys,
  };
}
