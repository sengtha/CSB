# Paper: what remains before submission

Ordered by what would sink the submission first.

## 1. References — currently a desk-reject

The draft cites author-year keys with no bibliography. Any editor rejects before
review. Target 30–50 entries. The works below are real and appropriate; **verify
every bibliographic detail (year, volume, DOI) against the publisher before
citing** — they are listed from memory and the details may be wrong.

**CBDC**
- Bank for International Settlements, Committee on Payments and Market
  Infrastructures & Markets Committee, *Central bank digital currencies* (2018)
- BIS, *Annual Economic Report 2021*, ch. III, "CBDCs: an opportunity for the
  monetary system"
- Auer, R. & Böhme, R., "The technology of retail central bank digital currency",
  *BIS Quarterly Review* (2020)
- Auer, R., Cornelli, G. & Frost, J., "Rise of the central bank digital
  currencies: drivers, approaches and technologies", *BIS Working Paper* 880
- National Bank of Cambodia, *Project Bakong* white paper (2020) — **essential**;
  see §2.1

**Permissioned ledgers**
- Androulaki, E. et al., "Hyperledger Fabric: A Distributed Operating System for
  Permissioned Blockchains", *EuroSys* (2018)
- Brown, R. G. et al., *Corda: An Introduction* (R3, 2016)

**DeFi and its regulation**
- Werner, S. M. et al., "SoK: Decentralized Finance (DeFi)" (2022)
- Zetzsche, D. A., Arner, D. W. & Buckley, R. P., "Decentralized Finance",
  *Journal of Financial Regulation* 6(2) (2020)
- Aramonte, S., Huang, W. & Schrimpf, A., "DeFi risks and the decentralisation
  illusion", *BIS Quarterly Review* (2021)

**Standards**
- ERC-20, ERC-721, ERC-3643 (T-REX), ERC-4337 — cite the EIP documents
- NIST FIPS 203 / 204 / 205 (post-quantum, 2024)

**Platform**
- Team Rocket et al., Avalanche consensus papers
- Avalanche ACP-77 (L1 validator management) — **required** for §6.2
- Subnet-EVM and ICM/ICTT documentation

**Cambodia context** — dollarization, mobile penetration, MSME finance, digital
fraud. Needs World Bank / IMF / NBC sources with real figures; §1 currently
asserts these without support and a reviewer will ask.

## 2. The experiment — DONE, and it is now the paper's spine

`test/defi-unmodified.test.js` deploys unmodified Uniswap V2 (published upstream
artifacts, unrecompiled) against KHRt. Written up as §5.2. Four results:

1. It runs. No source change needed.
2. The pool must be marked a system contract, and cannot be marked before
   `createPair()` — a council action inside what a front-end shows as one user
   step.
3. Compliance holds at the pool edge: swapping out to an unverified address
   reverts.
4. **LP tokens are an unrestricted derivative of a restricted asset.** Pool
   shares transfer freely to addresses with no attestation. Redemption stays
   blocked, so the asset never leaves — the *exposure* does.

Result 4 is the paper's contribution. It reframes the whole thing: the design
secures custody, not exposure, and no base-layer mechanism can close that gap.

**Still to do here:**
- Run the same experiment against the **live chain**, not just the local suite,
  so the txAllowList precompile is genuinely in the loop rather than mocked.
  Report which allowlist grants the factory and pools actually needed.
- Extend to a lending protocol (Aave V2 or Compound) — receipt tokens should
  leak identically and more visibly, since they accrue yield.
- Try the mitigations and report what they cost: permissioned factory, and a
  compliance-aware fork of `UniswapV2ERC20`.

## 3. Figures

Three minimum, none currently exist:
1. Layer model — precompiles / base contracts / applications, showing where
   compliance is enforced
2. Egress gateway decision flow (§4.4 pseudocode is the skeleton)
3. Separation-of-powers map — roles, contracts, and what each cannot do

A fourth would help §6.2: a timeline of the outage against validator balance.

## 4. Quantitative evaluation

Currently there is none. Cheap additions:
- gas cost per operation at `minBaseFee` 47,619 gwei (transfer, KHRt transfer,
  levy payment, egress request, deployment) — measurable today
- end-to-end egress latency: CSB block inclusion → relayer delivery → Fuji balance
- bridge round-trip time
- annual public-good fund yield at 1 riel/tx for plausible transaction volumes

## 5. Claims to keep checking

Corrected in this revision; re-verify before submission, since the code moves:
- **192 tests / 29 contracts** — regenerate the count at submission time
- **Single validator** — if more are added, update §4.1 and §7.1
- **Recovery** (§4.2) — no account abstraction exists; `LandTitleToken
  .recoveryAddress` and `KHRStablecoin.confiscate` are the only paths, and
  native tRIEL has none
- **Fees** — 1 riel per payment, not "near-zero" or "subsidized"
- **Ingress ungated** (§4.4) — remove the caveat if an `IngressGateway` is built

## 6. Venue

In rough order of reach:
1. IEEE ICBC — the field's serious venue; conference papers carry weight here
2. *Financial Innovation* (Springer, SSCI, strong Asian readership)
3. *Ledger* — blockchain-specific, peer-reviewed, no APC
4. *Digital Finance* (Springer)
5. *Frontiers in Blockchain* — fastest, weakest signal, APC ~US$2,000–3,000

§6 (operational findings) may also stand alone as a short systems/experience
paper, which is often an easier first publication and would strengthen the
architecture paper by citation.

## 7. Framing note

The paper's persuasive value for institutions comes from honesty about
limitations, not from claims of readiness. The single-validator deployment, the
absent audit, the ungated ingress and the unrecoverable native token are all
stated plainly — keep it that way. A reviewer who finds an overstatement will
distrust everything else, and so will a ministry.
