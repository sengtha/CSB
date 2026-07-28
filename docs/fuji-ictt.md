# Real egress: CSB → Fuji C-Chain via Avalanche ICTT

How to connect the `ICTTBridgeAdapter` (contracts/egress/ICTTBridgeAdapter.sol) to a real Interchain Token Transfer deployment, bridging KHRt from the CSB L1 to Avalanche's Fuji testnet C-Chain. This replaces the `MockBridgeAdapter` used in development.

## Architecture

```
CSB L1                                        Fuji C-Chain
──────                                        ────────────
EgressGateway ── policy: allowlist/tiers/caps/pause
   │
ICTTBridgeAdapter ── route table (council-owned)
   │ forceApprove + send()
ERC20TokenHome(KHRt) ══ ICM (Teleporter) ══▶ ERC20TokenRemote ("bridged KHRt")
        ▲                                          relayer delivers
   locks collateral
```

Policy lives in the gateway (ours); transport is audited ICTT + ICM infrastructure (Ava Labs); the relayer is operated by the state.

## Steps

1. **Deploy CSB as a Fuji L1** (instead of `--local`): `avalanche blockchain deploy csb --fuji`, with VM-hosted (or later institution-hosted) validators. avalanche-cli deploys the ICM messenger + registry to the new chain by default and can run a test relayer.

2. **Deploy the ICTT pair** (contracts from `ava-labs/icm-contracts`):
   - `ERC20TokenHome` on CSB, constructor pointing at the ICM (Teleporter) registry on CSB and the **KHRt** address.
   - `ERC20TokenRemote` on Fuji C-Chain, pointing at the C-Chain ICM registry and the TokenHome (CSB blockchainID + TokenHome address), then call `registerWithHome()`.
   - avalanche-cli (`avalanche interchain tokenTransferrer deploy`) automates this pair.

3. **Mark both KYC-exempt on KHRt** (they're contracts, not people — council action):
   ```
   khr.setSystemContract(<TokenHome>, true)
   khr.setSystemContract(<ICTTBridgeAdapter>, true)
   ```

4. **Deploy + wire the adapter** (council-owned):
   ```
   ICTTBridgeAdapter(khr, <TokenHome>, council)
   adapter.setGateway(<EgressGateway>)
   adapter.setRoute(
     keccak256("avalanche-c-chain"),          // the gateway's logical destination id
     <Fuji C-Chain blockchainID (hex)>,        // e.g. 0x7fc93d85…10d5 — VERIFY against current Avalanche docs
     <ERC20TokenRemote address>,
     250000                                    // requiredGasLimit on destination
   )
   ```

5. **Point the gateway's policy at the real adapter**:
   ```
   gateway.setTokenPolicy(khr, true, 2, <dailyCap>, <ICTTBridgeAdapter>)
   ```

6. **Run the ICM relayer** (avalanche-cli's built-in for testing; a state-operated `icm-relayer` service for anything real). Without a relayer, sends lock on CSB but never deliver.

7. **Test**: KYC'd tier-2 account approves the gateway and calls `requestEgress(khr, amount, keccak256("avalanche-c-chain"), <20-byte recipient>)`. Bridged KHRt appears at the recipient on Fuji C-Chain. Verify the controls: below-tier account → `TierTooLow`; over daily cap → `DailyCapExceeded`; `gateway.pause()` → all egress halts.

## Notes

- **The boundary, made visible:** the recipient balance on Fuji is visible in any public explorer — this is the boundary where sovereign-private becomes world-public, by council-governed exception only.
- Return path (Fuji → CSB): TokenRemote's `send()` back to the TokenHome unlocks collateral. v1 can leave ingress ungated (funds re-enter the KYC'd perimeter; the recipient must still be KYC'd to receive KHRt — non-KYC'd returns will revert unless sent to a system contract or an `IngressGateway` escrow, which is future work).
- Fees: ICTT primary/secondary fees are set to zero (state-run relayer needs no fee incentive). This is the BRIDGE's own fee, and is separate from CSB gas — the transaction still costs about 1 riel like any other.
- The `SendTokensInput` struct in `contracts/egress/interfaces/IERC20TokenTransferrer.sol` mirrors `icm-contracts`; re-verify the layout against the pinned icm-contracts release before production.
