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
    "function tierTransferCap(uint8 tier) view returns (uint256)",
    "function isSystemContract(address) view returns (bool)",
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
  ERC20InsufficientBalance: (a) => `Blocked: insufficient balance (${fmtKHR(a[1])} KHRt available).`,
  ERC20InsufficientAllowance: () => "Blocked: gateway allowance too low — approve first.",
};

const STATUS_NAMES = ["none", "active", "suspended", "revoked"];
const TIER_NAMES = { 0: "—", 1: "1 · citizen basic", 2: "2 · full KYC", 3: "3 · business", 4: "4 · institutional" };

let _provider, _config, _contracts;

function getProvider() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(location.origin + "/rpc", undefined, { batchMaxCount: 1 });
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
  };
}

function allInterfaces() {
  return Object.values(ABI).map((frags) => new ethers.Interface(frags));
}

function explainError(e) {
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

function fmtKHR(units) {
  return Number(ethers.formatUnits(units, 2)).toLocaleString("en-US", { minimumFractionDigits: 2 });
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
  overlay.innerHTML = `
    <div class="box">
      <h2>🇰🇭 CSB — Restricted Access</h2>
      <p>This explorer and its chain data are accessible to authorized users only.
         Production replaces this passcode with national digital-identity login.</p>
      <label>Access passcode</label>
      <input id="pc" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
      <div id="pcerr" class="banner"></div>
      <button id="pcgo">Enter</button>
    </div>`;
  document.body.appendChild(overlay);
  return new Promise((resolve) => {
    const go = async () => {
      const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode: document.getElementById("pc").value.trim() }),
      });
      if (res.ok) {
        overlay.remove();
        resolve();
      } else {
        banner(document.getElementById("pcerr"), "err", "Invalid passcode.");
      }
    };
    document.getElementById("pcgo").onclick = go;
    document.getElementById("pc").onkeydown = (e) => e.key === "Enter" && go();
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
