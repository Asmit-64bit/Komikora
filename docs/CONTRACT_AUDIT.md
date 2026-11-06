# ConsentCraftMarket internal audit

Date: 2026-11-06
Scope: [ConsentCraftMarket.sol](../contracts/contracts/ConsentCraftMarket.sol) and its interfaces, checked against [CONTRACT_SPEC.md](CONTRACT_SPEC.md)
Tooling: Solidity 0.8.28 with the optimizer (200 runs), OpenZeppelin 5.6.1, Hardhat 3 with viem

This is an internal review by the development team, not an independent third-party audit. Get an external audit before the contract holds real value.

## Summary

| ID | Severity | Title | Status |
| --- | --- | --- | --- |
| L-01 | Low | Unbounded policy durations can overflow deadlines and lock deposits | **Fixed** |
| C-01 | Medium (centralization) | The admin can give itself signing and reviewing roles and decide deposits under review | Accepted trust assumption; operational mitigation |
| L-02 | Low | A globally unique `requestId` lets an observer front-run a pending purchase | Not fixed (spec choice); documented |
| I-01 | Info | The purchase certificate isn't bound to a publication | Spec choice |
| I-02 | Info | Review reports have no expiry | Bounded by `jobId` and the Deposited-only rule |
| I-03 | Info | `ratingSnapshot` and the quote nonce aren't in events | Readable from state, which is frozen |
| I-04 | Info | `previewSettlement` is hypothetical for settled or unpublished publications | UI must check the state |
| I-05 | Info | Valid but extreme durations or prices are governance decisions | Backend and admin practice |
| I-06 | Info | ETH force-sent to the contract becomes unrecoverable surplus | By design (no sweep) |
| I-07 | Info | Guard against unreachable states | Defense in depth |
| I-08 | Info | Liveness: a review that never arrives leaves S locked | Open product question (spec Q3) |
| I-09 | Info | `requestId` and the evidence and reason hashes are public | Must not be derived from private data |

No critical or high-severity issues were found.

## Findings

### L-01 Unbounded policy durations can overflow deadlines and lock deposits (fixed)

Location: `createPolicy` ([ConsentCraftMarket.sol:101](../contracts/contracts/ConsentCraftMarket.sol#L101)). The deadlines are computed in `submitReviewReport`, `appeal` and `publish`.

`createPolicy` only required durations above zero. Deadlines are computed as `uint64(block.timestamp) + duration` with checked arithmetic. A policy with a duration near `2^64` made every overflowing call revert:
- `publish` with a huge `refundDelay`: an Approved publication could never be published or refunded, so its deposit stayed locked forever.
- A flagged report with a huge `appealDuration`: such a publication could never be flagged.
- `appeal` with a huge `appealResolutionDuration`: the author could never appeal and would lose `S − A` at finalization.

Fix: each duration must be `<= type(uint32).max` (about 136 years), which can't overflow before the year 2^64 seconds. It's a technical bound, not a business value. Regression tests are in [ConsentCraftMarket.audit.test.ts](../contracts/test/ConsentCraftMarket.audit.test.ts) under "L-01". They fail without the fix and pass with it, and they also show that flag, appeal and publish work at the maximum durations.

### C-01 Admin can decide deposits under review (centralization)

Location: AccessControl roles ([ConsentCraftMarket.sol:79](../contracts/contracts/ConsentCraftMarket.sol#L79)), `submitReviewReport` (L218), `resolveAppeal` (L281)

`DEFAULT_ADMIN_ROLE` can grant itself `REPORTER_ROLE` and `REVIEWER_ROLE`, and it chooses `ownerRecipient` and `aiExpenseRecipient`. A malicious or compromised admin could do the following to any publication in Deposited:
1. Sign a flagged report with `aiCost = aiCap`.
2. Reject the appeal, or let the window pass.
3. Collect `aiCap` plus `S − A`.

This matches the report's stated trust model ("privileged review and proof attestations are explicit MVP trust assumptions", "owner benefits financially from rejection"). The contract still enforces these bounds:
- A ≤ aiCap, which the author accepted.
- At most one report per publication.
- The appeal window always opens.
- Published works, sale proceeds and existing credits can't be touched.

Mitigation before real value:
- multisig admin with a timelock
- separate keys per role
- a reviewer independent of the beneficiary
- public reasons for every decision

### L-02 Front-running a pending purchase's `requestId`

Location: `purchase` ([ConsentCraftMarket.sol:356](../contracts/contracts/ConsentCraftMarket.sol#L356))

`requestId` is globally unique, as the spec requires. An observer can copy a pending buyer's `requestId` into their own purchase. The victim's transaction reverts with `RequestIdAlreadyUsed`. The attacker pays the full price and receives a copy, and the victim loses only gas and retries with a new ID. There's no fund loss.

Not fixed: the fix would scope request IDs per buyer, which changes the specified semantics. Clients should treat `RequestIdAlreadyUsed` as "retry with a new ID".

### Informational

- **I-01:** A PURCHASE certificate binds wallet, action, expiry and nonce, but not a publication ID. The report (§13) recommends binding a publication. A buyer could use a certificate meant for one comic on another. It still attests the same verified wallet, so the effect is minimal.
- **I-02:** A report can be replayed only while its publication is Deposited and its `jobId` is unused, so a missing expiry adds no attack surface. An old, never-submitted report stays valid until the reporter role is revoked.
- **I-03:** `PublicationCreated` follows the specified field list and omits `ratingSnapshot`. The field is frozen, so an indexer can read it from `getPublication` at any block. The quote nonce isn't emitted. The backend recovers a lost publication ID from `PublicationCreated` (author plus `manifestHash`) and from `isQuoteNonceUsed`.
- **I-04:** `previewSettlement` always computes the AuthorRefund split from the current R and A. For settled, Rejected or unpublished publications, the numbers are hypothetical.
- **I-05:** Durations, prices and `maxPrice` are bounded only for technical safety. A 100-year `refundDelay` or an absurd fee is a valid policy. Policy creation is admin-only and immutable, so review values before creating a policy. The report proposes 72 h, 30 days, etc.
- **I-06:** `receive` and `fallback` revert. ETH force-sent via `selfdestruct` raises the balance above liabilities and can't be recovered, because no sweep exists. `liabilitiesCovered` uses `>=`.
- **I-07:** `SalesReachedDeposit` (L395) is unreachable, because the threshold settles on the purchase that reaches it. The `assert` in `_settle` (L597) checks S = A + F + O. Both are defense in depth.
- **I-08:** A publication whose review never arrives stays Deposited with S locked, and no function forfeits it. The exit is the open product decision Q3. An Approved but unpublished publication is locked by the author's own choice.
- **I-09:** `requestId`, `evidenceHash`, `reasonHash` and `reportHash` appear on chain. Backends must use random IDs and salted hashes, never values derived from emails, order data or appeal text.

## Checklist results

| Area | Result |
| --- | --- |
| Signature replay across actions | Separate type hashes. PUBLISH and PURCHASE certificates aren't interchangeable. A quote signature fails as a certificate or report, even when one key holds every role (audit tests). |
| Replay across publications | Reports bind `publicationId`, manifest hash, Arweave bundle ID and policy. `jobId` is single use. Quote and certificate nonces are single use. |
| Replay across chains and deployments | The EIP-712 domain binds `chainId` and `verifyingContract`. OZ EIP712 rebuilds the separator after a fork. Tested for quotes, certificates and reports. |
| Signature malleability | OZ `tryRecover` rejects high-s. Replay keys are struct fields, not signatures. |
| Checks-effects-interactions and reentrancy | `withdraw` is the only external call: credit zeroed first, `nonReentrant`, failure reverts. Other functions make no external calls. A reentrant recipient is tested. During the call, state is already final, so read-only reentrancy only sees an over-covered balance. |
| Rounding | Fee rounds down (floor); Q = ceil(S/4) without overflow. f(P) ≤ P is guaranteed by `feeBps ≤ 10000` and `minPrice > minFee`. |
| Timestamp boundaries | Every before/after pair has no gap or overlap: `<` then `>=` for appeal/finalize and resolve/timeout, `>=` for refund, `<=` for expiry. Each boundary is tested at −1 s and 0 s. |
| State transitions | Only the documented transitions exist, and each settlement path runs once. A successful appeal never settles. |
| Arithmetic | Checked; deadline overflow fixed (L-01). `price * feeBps` overflows only above about 1.16e73 wei, which can't be paid. |
| No sweep or frozen-term edits | A test asserts the exact set of state-changing functions. Frozen fields and Arweave IDs are written only in `createPublication`. The fuzz suite checks after every step that they never change. |
| Contract rather than UI enforcement | Every rule in spec §7–8 is a `revert` in the contract. Rules enforced by the backend signer, not the contract: the report's price ceiling formula, the deposit schedule, Arweave availability and content checks, wallet-session authorization, and AI cost conversion. Each is bound into a signed quote, certificate or report. |
| Events | A test rebuilds every listing (state, listing, terms, Arweave IDs, A, score, report hash, R, settlement, deadlines, refund eligibility), the trade feed, buyer access and all credit balances from events alone, and matches contract state. Events carry only hashes for private material; no keys, proofs, nullifiers, appeal text or plaintext. |
| Contract size | Runtime 17,143 bytes (limit 24,576); initcode 18,615 bytes (limit 49,152), with the optimizer at 200 runs. A test guards the runtime limit. |

## Invariant and fuzz testing

[ConsentCraftMarket.invariants.test.ts](../contracts/test/ConsentCraftMarket.invariants.test.ts) runs seeded random sequences of every lifecycle action, including invalid re-settlement, early-refund and double-withdrawal attempts. It compares an independent model with the contract after every step:
- **I1:** balance equals locked deposits plus credits
- **I2:** credits match per account and in total
- **I3:** locked deposits equal the sum of S − A over unsettled publications
- **I4:** S = A + F + O, with AuthorRefund matching `min(S, max(R, A, ceil(S/4)))`
- **I5:** at most one settlement per publication
- **I6:** exact payout, and no withdrawal above the credit
- **I7:** frozen terms never change

The default CI run is 4 seeds × 140 steps. A one-off campaign of 40 seeds × 400 steps (16,000 steps) passed. Reproduce or extend it with `FUZZ_SEEDS=1,2,3 FUZZ_STEPS=1000`. Six deliberately planted accounting bugs were each caught by the fuzz suite alone.

## Remaining risks

1. Centralization (C-01): use a multisig and timelock admin, separate signing keys, and an independent reviewer.
2. Off-chain attestations are trusted: quotes, certificates, reports, Arweave availability and AI cost conversion.
3. Encrypted bundles on permanent public Arweave (spec Q5): a leaked content key can't be revoked by deleting the bundle.
4. Open product decisions: the AppealTimeout payout (Q1), the review-never-arrives exit (Q3), and certificate scope (Q2, I-01).
5. This is an internal review only; no external audit or formal verification has been done.
