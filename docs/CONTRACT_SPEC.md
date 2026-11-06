# ConsentCraftMarket contract specification

Status: interface defined, business logic not implemented.
Interface: [contracts/contracts/interfaces/IConsentCraftMarket.sol](../contracts/contracts/interfaces/IConsentCraftMarket.sol)

One integrated Solidity contract on Sepolia holds deposits and sale payments in native ETH (wei) and is the only authority for deposits, sales, entitlements, settlements and withdrawals. It is built with Solidity 0.8.28 and OpenZeppelin Contracts 5.6.1 (`AccessControl`, `Pausable`, `ReentrancyGuard`, `EIP712`, `ECDSA`).

Items marked **[OPEN]** are provisional defaults that still need a decision; see the last section.

## 1. System boundaries

| System | Role | Trust |
| --- | --- | --- |
| Sepolia contract | Deposits, sales, entitlements, settlements, withdrawals | Authority |
| Arweave | Permanent storage of the encrypted full bundle and the public preview manifest | Storage only. No Arweave contract, AO process or bridge. |
| Arkiv | Public queryable index of listings and the trade feed, built from contract events | Not authoritative. The contract never calls it. |
| Backend | Holds decryption keys; signs quotes and personhood certificates; checks `hasReadingAccess` before releasing keys | Trusted signer, bounded by the contract's rules |

The contract cannot verify Arweave contents or availability. Before signing a quote, the backend confirms that both transactions are available and match `manifestHash` and `previewManifestHash`. The reporter checks them again before signing a review report.

Keys and plaintext paid pages are never placed on Arweave, on Arkiv, in calldata or in events.

## 2. Symbols and formulas

| Symbol | Meaning |
| --- | --- |
| `S` | Deposit. Immutable, `msg.value` at creation, and strictly greater than `aiCap`. |
| `R` | Cumulative gross sales in wei, including self-purchases. |
| `A` | Recognized AI cost. Set once, from the first review report, with `A <= aiCap < S`. |
| `Q` | `ceil(S / 4)` = `(S + 3) / 4` in integer arithmetic. |
| `D` | Retained deposit: `min(S, max(R, A, Q))`. |
| `F` | Author refund: `S - D`. |
| `O` | Additional owner allocation: `D - A`. |

Settlement invariant: `S = A + F + O`. It holds because `A <= D <= S`; `D >= A` follows from `max(R, A, Q) >= A` and `S > aiCap >= A`.

The settlement formula uses the values of `R` and `A` at the moment of settlement. For Rejected and AppealTimeout, `R = 0` because nothing can have been sold. **[OPEN Q1]**

Sale fee: `f(P) = max(minFee, floor(P * feeBps / 10000))`. A publication's price must satisfy `price >= minFee` and `price > 0`, and every policy has `feeBps <= 10000`. Together these guarantee `f(P) <= P`.

Worked example: `S = 1000`, `aiCap = 200`, `A = 150`, so `Q = 250`.

| Case | R | D | F | O |
| --- | --- | --- | --- | --- |
| Rejected, no sales | 0 | 250 | 750 | 100 |
| AuthorRefund after sales | 600 | 600 | 400 | 450 |
| ThresholdReached | ≥ 1000 | 1000 | 0 | 850 |

## 3. Money flow

The contract uses pull payments. Every allocation becomes a credit (`creditOf[account]`), and only that account can withdraw it, by calling `withdraw()`.

| When | Credit | Recipient | Kind |
| --- | --- | --- | --- |
| Review report recognizes A (once) | `A` | AI expense recipient (current) | `AiExpense` |
| Each purchase | `f(P)` | Owner recipient (current) | `PlatformFee` |
| Each purchase | `P - f(P)` | Author | `SaleProceeds` |
| Deposit settlement | `F` | Author | `DepositRefund` |
| Deposit settlement | `O` | Owner recipient (current) | `OwnerAllocation` |

A deposit is settled exactly once. Settlement credits `F` and `O` and records `settlementReason`, `authorRefund`, `ownerAllocation` and `settledAt`. `A` is credited when it is recognized, not at settlement. Zero-amount credits are skipped and emit no event.

Accounting:
- `totalHeldDeposits` = the sum, over unsettled publications, of `S - A`. Before review the term for a publication is the full `S`.
- `totalCredits` = the sum of unwithdrawn credits.
- `address(this).balance >= totalHeldDeposits + totalCredits` always holds. The contract has no `receive` or `fallback`, so plain ETH transfers revert.

Changing the owner or AI expense recipient affects future credits only.

## 4. Roles

| Role | Can | Cannot |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` | Grant and revoke roles, `createPolicy`, `setOwnerRecipient`, `setAiExpenseRecipient` | Anything below |
| `QUOTE_SIGNER_ROLE` | Sign `PublicationQuote` and `PersonhoodCertificate` (off chain) | Call privileged functions; no on-chain power of its own |
| `REPORTER_ROLE` | Sign `ReviewReport` (off chain) | Same |
| `REVIEWER_ROLE` | `resolveAppeal` | Same |
| `PAUSER_ROLE` | `pause`, `unpause` | Same |

No role may sweep funds, change a publication's frozen terms (author, policy, hashes, Arweave IDs, page count, price, deposit, aiCap), change an existing policy, or withdraw or redirect another account's credits. The contract has no function that does any of these things.

Signatures are verified by recovering the signer with `ECDSA.recover` over the EIP-712 digest and checking that the signer holds the required role at the time of the call. Revoking a signer's role invalidates its unused signatures.

The constructor takes `(admin, ownerRecipient, aiExpenseRecipient)`, all non-zero. It grants `DEFAULT_ADMIN_ROLE` to `admin` and grants no other roles; the admin grants them explicitly.

## 5. Policies

`createPolicy(feeBps, minFee, appealWindow, resolutionWindow)` creates an immutable policy with sequential ids starting at 1. It requires `feeBps <= 10000`, `appealWindow > 0` and `resolutionWindow > 0`. A publication references its `policyId`, and because policies never change, the publication's fee and timing terms are frozen. Policies cannot be retired in Parts 1-8; the backend simply stops quoting a policy it no longer wants to use.

## 6. Publication record

| Group | Fields |
| --- | --- |
| Frozen | `author`, `policyId`, `manifestHash`, `previewManifestHash`, `arweaveBundleTxId`, `arweavePreviewTxId`, `pageCount`, `price`, `deposit` (S), `aiCap` |
| Review | `ratingSnapshot`, `aiCost` (A) |
| Money | `grossSales` (R), `authorRefund` (F), `ownerAllocation` (O) |
| States | `state` (review), `listingState`, `settlementReason` |
| Timestamps | `createdAt`, `reviewedAt`, `appealDeadline`, `appealedAt`, `resolutionDeadline`, `decidedAt`, `publishedAt`, `delistedAt`, `settledAt` |

- Publication ids are sequential and start at 1.
- Both Arweave IDs are stored as `bytes32`: the 32 raw bytes of the 43-character Base64URL ID (see section 10). Both must be non-zero and can never change.
- `arweaveBundleTxId` points to the encrypted full pages. `arweavePreviewTxId` points to a public preview manifest with display metadata (title, description, language, genre, preview image references). `previewManifestHash` is `keccak256` of that manifest's canonical bytes. `manifestHash` is `keccak256` of the canonical bundle manifest. **[OPEN Q4]**
- `ratingSnapshot` is the content-maturity code set by the review report. Its meaning is defined off chain. It is not a user rating. **[OPEN Q5]**

## 7. State machines

Review state, listing state and settlement reason are three separate fields.

```
                 report: Approve
 Deposited ─────────────────────────────────────────► Approved ──publish──► Published
     │ report: Flag                                       ▲
     ▼                     resolveAppeal(approve)         │
  Flagged ──appeal (≤ appealDeadline)──► AppealPending ───┘
     │                                     │      │
     │ finalizeRejection                   │      │ claimAppealTimeout
     │ (> appealDeadline)                  │      │ (> resolutionDeadline)
     ▼                                     ▼      ▼
  Rejected (reason Rejected) ◄─resolveAppeal(reject)   Rejected (reason AppealTimeout)
```

| Function | Caller | Precondition | Effect | Paused? |
| --- | --- | --- | --- | --- |
| `createPublication` | Author (`quote.author`) | Valid quote and certificate, `msg.value == deposit` | Deposited, Unlisted | Blocked |
| `submitReviewReport` | Anyone (relayer) | State Deposited; valid report; `report.manifestHash` matches | Sets `A`, `ratingSnapshot`, `reviewedAt`; credits `A`; goes to Approved, or to Flagged with `appealDeadline = now + appealWindow` | Blocked |
| `appeal` | Author | Flagged, `now <= appealDeadline` | AppealPending, `resolutionDeadline = now + resolutionWindow` | Allowed |
| `resolveAppeal` | `REVIEWER_ROLE` | AppealPending, `now <= resolutionDeadline` | Approved, or Rejected and settled (`Rejected`) | Allowed |
| `finalizeRejection` | Anyone | Flagged, `now > appealDeadline` | Rejected and settled (`Rejected`) | Allowed |
| `claimAppealTimeout` | Author | AppealPending, `now > resolutionDeadline` | Rejected and settled (`AppealTimeout`) | Allowed |
| `publish` | Author | Approved, Unlisted | Published, Listed, `publishedAt` | Blocked |
| `purchase` | Buyer | Published and Listed; `msg.value == price`; valid certificate for the buyer; unused `requestId`; buyer not already entitled | Entitlement; `R += P`; fee and proceeds credited; if the deposit is unsettled and `R >= S`, it settles (`ThresholdReached`) | Blocked |
| `refundAndDelist` | Author | Approved or Published, not Delisted | Settles (`AuthorRefund`) if unsettled; listing becomes Delisted; review state unchanged | Allowed |
| `withdraw` | Any credit holder | Credit > 0 | Sends the full credit | Allowed |

Pausing blocks only new inflows (create, report, publish, purchase). Exits and the time-bounded review steps keep working, so pausing can never trap funds or make a deadline pass unfairly. Deadlines keep running while the contract is paused. **[OPEN Q3]**

After `ThresholdReached`, `R` keeps accumulating, but settlement is final. `refundAndDelist` then only delists, and `F = 0` is already recorded.

`refundAndDelist` on an Approved publication that was never published is allowed. Its listing state goes from Unlisted to Delisted, which blocks a later `publish`.

### Entitlements

- `hasReadingAccess(id, account)` returns true if `account` is the author or has purchased `id`.
- Entitlements are permanent. Delisting does not revoke them. The backend must still deliver keys to existing buyers of delisted publications.
- One purchase per account per publication. A repeat purchase reverts with `AlreadyEntitled`. The author may buy their own publication, and that sale counts toward `R`.
- `requestId` is a buyer-chosen, globally unique `bytes32` idempotency key used to link a purchase to a backend order. A reused `requestId` reverts.

## 8. EIP-712

Domain: `name = "ConsentCraftMarket"`, `version = "1"`, `chainId` (11155111 on Sepolia, 31337 locally), `verifyingContract = <market address>`. The domain is exposed through ERC-5267 `eip712Domain()`.

Enums are encoded as `uint8`. Field order is normative.

```
PublicationQuote(bytes32 quoteId,address author,uint256 policyId,bytes32 manifestHash,bytes32 previewManifestHash,bytes32 arweaveBundleTxId,bytes32 arweavePreviewTxId,uint32 pageCount,uint256 price,uint256 deposit,uint256 aiCap,uint64 expiresAt)

PersonhoodCertificate(address account,bytes32 personhoodHash,uint64 issuedAt,uint64 expiresAt)

ReviewReport(bytes32 reportId,uint256 publicationId,bytes32 manifestHash,uint8 outcome,uint256 aiCost,uint8 ratingSnapshot,bytes32 reasonHash,uint64 expiresAt)
```

| Type | Signer role | Checks | Replay protection |
| --- | --- | --- | --- |
| PublicationQuote | `QUOTE_SIGNER_ROLE` | `author == msg.sender`; `now <= expiresAt`; policy exists; `deposit > aiCap`; `price > 0` and `price >= minFee`; hashes and IDs non-zero; `pageCount > 0`; `msg.value == deposit` | `quoteId` single use, plus domain |
| PersonhoodCertificate | `QUOTE_SIGNER_ROLE` | `account == msg.sender`; `issuedAt <= now <= expiresAt` | Reusable until expiry; bound to `account` and the domain. `personhoodHash` (app-scoped World ID nullifier hash) is never stored or emitted. **[OPEN Q2]** |
| ReviewReport | `REPORTER_ROLE` | Publication is Deposited; `manifestHash` matches; `now <= expiresAt`; `aiCost <= aiCap` | `reportId` single use; a publication only accepts one report, from Deposited |

A certificate is required for `createPublication` (by the author) and for `purchase` (by the buyer).

## 9. Events

Every state change emits an event. Together they let an indexer rebuild the marketplace and the trade feed without private data.

| Event | Emitted by |
| --- | --- |
| `PolicyCreated` | `createPolicy` |
| `OwnerRecipientUpdated`, `AiExpenseRecipientUpdated` | Recipient setters |
| `PublicationCreated` (id, author, policyId, manifestHash, previewManifestHash, both Arweave IDs, pageCount, price, deposit, aiCap) | `createPublication` |
| `ReviewStatusChanged` (previous state, new state) | Every review-state transition after creation (`PublicationCreated` implies Deposited) |
| `ReviewReportSubmitted` | `submitReviewReport` |
| `PublicationFlagged` | Report with Flag outcome |
| `AppealFiled` | `appeal` |
| `AppealResolved` | `resolveAppeal` |
| `PublicationApproved` (path Report or Appeal) | Approval |
| `PublicationRejected` (reason Rejected or AppealTimeout) | Rejection |
| `PublicationPublished` | `publish` |
| `PublicationDelisted` | `refundAndDelist` |
| `Purchased` (id, buyer, requestId, price, platformFee, authorProceeds, cumulativeGrossSales) | `purchase` |
| `DepositSettled` (reason, S, A, F, O, R) | Any settlement |
| `Credited` (account, publicationId, kind, amount) | Every non-zero credit |
| `Withdrawn` | `withdraw` |
| `Paused`, `Unpaused`, `RoleGranted`, `RoleRevoked`, `RoleAdminChanged` | Inherited from OpenZeppelin |

## 10. Arweave transaction IDs

According to the [Arweave HTTP API docs](https://docs.arweave.org/developers/arweave-node-server/http-api), a transaction `id` is "A SHA-256 hash of the transaction signature", serialized as a case-sensitive Base64URL string. A 32-byte digest encodes to 43 characters of unpadded Base64URL. Its bytes are stored directly as `bytes32`.

Conversion lives in [contracts/lib/arweave-tx-id.ts](../contracts/lib/arweave-tx-id.ts) (`arweaveTxIdToBytes32`, `bytes32ToArweaveTxId`, `isArweaveTxId`). It rejects:
- the wrong length
- padding (`=`)
- the standard Base64 characters `+` and `/`
- whitespace
- non-canonical trailing bits (the final character must be one of `AEIMQUYcgkosw048`)
- the all-zero value

## 11. Security notes

- `nonReentrant` is applied to every function that moves ETH or changes balances. `withdraw` zeroes the credit before the external call, using checks-effects-interactions.
- `withdraw` sends via `call`, and a failure reverts. A recipient contract that rejects ETH can only block its own withdrawal.
- There is no admin sweep. ETH force-sent to the contract (via `selfdestruct`) is unreachable surplus.
- Arithmetic is checked (0.8.x). `Q` is computed as `S / 4 + (S % 4 == 0 ? 0 : 1)` to avoid overflow at the top of the range.

## 12. Open questions

- **Q1 (blocking):** Does `D = min(S, max(R, A, Q))` apply unchanged to `Rejected` and `AppealTimeout`? As written, a rejected or timed-out author loses `max(A, Q)`, which is at least a quarter of the deposit. For AppealTimeout, where the reviewer missed its own deadline, `D = A` (refund `S - A`) may be intended instead. The default applies the formula unchanged.
- **Q2:** The personhood certificate is required for both `createPublication` and `purchase`. It is reusable until expiry and not tied to a nullifier on chain. Is that the intended gate, or should it be one-shot or apply only to authors?
- **Q3:** There is no timeout if a publication sits in Deposited because the reporter never reports, so `S` is locked until a report arrives. Should the author be able to reclaim `S` after a review deadline? That would need a new function and settlement reason.
- **Q4:** `manifestHash` and `previewManifestHash` are assumed to be `keccak256`. SHA-256 is also possible; it only matters to the backend and reporter.
- **Q5:** `ratingSnapshot` is assumed to be a content-maturity code supplied by the review report.
