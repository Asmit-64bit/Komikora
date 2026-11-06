# ConsentCraftMarket contract specification

Interface: [IConsentCraftMarket.sol](../contracts/contracts/interfaces/IConsentCraftMarket.sol) (functions) extends [IConsentCraftMarketTypes.sol](../contracts/contracts/interfaces/IConsentCraftMarketTypes.sol) (enums, structs, events, errors).
Implementation: [ConsentCraftMarket.sol](../contracts/contracts/ConsentCraftMarket.sol)
Product source: ConsentCraft Final Project Report (6 November 2026), referred to below as "the report".

One integrated Solidity contract on Sepolia holds deposits and sale payments in native ETH (wei). It is the only authority for deposits, sales, entitlements, settlements and withdrawals. It is built with Solidity 0.8.28 and OpenZeppelin Contracts 5.6.1 (`AccessControl`, `Pausable`, `EIP712`, `ECDSA`; `ReentrancyGuard` arrives with the first ETH-sending function).

Items marked **[OPEN]** are provisional defaults that still need a decision; see section 13.

## Implementation status

| Area | Status |
| --- | --- |
| Roles, recipients, pausing | Implemented |
| Policies (`createPolicy`, `getPolicy`, `policyCount`) | Implemented |
| `createPublication`, quote and certificate verification | Implemented |
| Liability views (`totalCredits`, `totalLockedDeposits`, `totalLiabilities`, `liabilitiesCovered`), direct-ETH rejection | Implemented |
| Review, appeals, publish, purchase, refund, withdraw, `hasReadingAccess`, `saleFee`, `previewSettlement` | Not yet implemented |

Until every function exists, the contract inherits `IConsentCraftMarketTypes` rather than `IConsentCraftMarket`, so it has no stub functions.

## 1. System boundaries

| System | Role | Trust |
| --- | --- | --- |
| Sepolia contract | Deposits, sales, entitlements, settlements, withdrawals | Authority |
| Arweave | Permanent storage of the encrypted full bundle and the public preview manifest | Storage only. No Arweave contract, AO process or bridge. |
| Arkiv | Public queryable index of listings and the trade feed, built from contract events | Not authoritative. The contract never calls it. |
| Backend | Holds decryption keys; signs quotes and personhood certificates; checks `hasReadingAccess` before releasing keys | Trusted signer, bounded by the contract's rules |

The contract cannot verify Arweave contents or availability. Before signing a quote, the backend confirms that both transactions are available and match `manifestHash` and `previewManifestHash`. The reporter checks them again before signing a review report.

Keys and plaintext paid pages are never placed on Arweave, on Arkiv, in calldata or in events. Personhood certificates are a trusted attestation bridge from the backend's World ID check. They are not on-chain World ID verification.

## 2. Symbols and formulas

| Symbol | Meaning |
| --- | --- |
| `S` | Deposit. Immutable, `msg.value` at creation, and strictly greater than `aiCap`. |
| `R` | Cumulative gross sales in wei, including self-purchases. |
| `A` | Recognized AI cost. Set once, from the review report, with `A <= aiCap < S`. |
| `Q` | `ceil(S / 4)`, computed as `S / 4 + (S % 4 == 0 ? 0 : 1)`. |
| `D` | Retained deposit: `min(S, max(R, A, Q))`. |
| `F` | Author refund: `S - D`. |
| `O` | Additional owner allocation: `D - A`. |

Invariant at every settlement: `S = A + F + O`.

| Settlement reason | When | F | O |
| --- | --- | --- | --- |
| `AuthorRefund` | `refundAndDelist`, using the current R | `S - D` | `D - A` |
| `ThresholdReached` | Purchase makes `R >= S` | 0 | `S - A` |
| `Rejected` | No appeal by the deadline, or appeal rejected | 0 | `S - A` |
| `AppealTimeout` | The reviewer missed the resolution deadline | `S - A` | 0 **[OPEN Q1]** |

Per the report's confirmed rules, a final rejection forfeits the remainder `S - A` to the owner. The AppealTimeout row follows the report's recommended fallback, which it marks as still needing product approval.

Sale fee: `f(P) = max(minFee, floor(P * feeBps / 10000))`. Every policy has `feeBps <= 10000` and `minPrice > minFee`, and every price satisfies `minPrice <= P <= maxPrice`. Together these guarantee `0 <= f(P) <= P` and `P > 0`.

Worked examples from the report (`S = 100`), checked against the formula:

| R | A | D | F | O |
| --- | --- | --- | --- | --- |
| 0 | 10 | 25 | 75 | 15 |
| 60 | 10 | 60 | 40 | 50 |
| 20 | 40 | 40 | 60 | 0 |
| 100 | 10 | 100 | 0 | 90 |

## 3. Money flow and accounting

The contract uses pull payments. Every allocation becomes a credit, and only the credited account can withdraw it.

| When | Credit | Recipient | Kind |
| --- | --- | --- | --- |
| Review report recognizes A (once) | `A` | AI expense recipient (current) | `AiExpense` |
| Each purchase | `f(P)` | Owner recipient (current) | `PlatformFee` |
| Each purchase | `P - f(P)` | Author | `SaleProceeds` |
| Deposit settlement | `F` | Author | `DepositRefund` |
| Deposit settlement | `O` | Owner recipient (current) | `OwnerAllocation` |

Accounting:
- `totalLockedDeposits` = the sum, over unsettled publications, of `S - A`. Creation adds `S`. Recognizing A moves `A` from locked to credits. Settlement moves `F + O` to credits.
- `totalCredits` = the sum of unwithdrawn credits.
- `liabilitiesCovered()` returns `address(this).balance >= totalCredits + totalLockedDeposits`, which must always be true.
- `receive` and `fallback` revert with `DirectPaymentRejected`, so ETH enters only through `createPublication` and `purchase`. ETH force-sent via `selfdestruct` becomes unreachable surplus. No function sweeps it.

Changing the owner or AI expense recipient affects future credits only. Zero-amount credits are skipped.

## 4. Roles

| Role | Can | Cannot |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` | Grant and revoke roles, `createPolicy`, `setOwnerRecipient`, `setAiExpenseRecipient` | Anything below |
| `QUOTE_SIGNER_ROLE` | Sign `PublicationQuote` and `PersonhoodCertificate` (off chain) | Call privileged functions; no on-chain power of its own |
| `REPORTER_ROLE` | Sign `ReviewReport` (off chain) | Same |
| `REVIEWER_ROLE` | `resolveAppeal` | Same |
| `PAUSER_ROLE` | `pause`, `unpause` | Same |

No role may sweep funds, change a publication's frozen terms, change an existing policy, or withdraw or redirect another account's credits. A test asserts that the deployed contract's state-changing functions are exactly the documented set.

Signatures are verified with `ECDSA.tryRecover` over the EIP-712 digest, and the recovered signer must currently hold the role. Malformed signatures revert with the contract's own error, not an ECDSA error. Revoking a signer's role invalidates its unused signatures.

The constructor takes `(admin, ownerRecipient, aiExpenseRecipient)`, all non-zero. It grants only `DEFAULT_ADMIN_ROLE`.

## 5. Policies

`createPolicy(Policy)` appends an immutable policy. It is `DEFAULT_ADMIN_ROLE` only, and ids are sequential from 1. No function modifies a policy, so a publication's `policyId` freezes its terms.

| Field | Rule |
| --- | --- |
| `minFee` | wei, may be 0 |
| `feeBps` | `<= 10000` |
| `minPrice` | `> minFee` |
| `maxPrice` | `>= minPrice` |
| `appealDuration` | `> 0` seconds (report: 72 hours) |
| `appealResolutionDuration` | `> 0` seconds (report: not yet approved) |
| `refundDelay` | `> 0` seconds after `publishedAt` (report: 30 days) |
| `purchaseRequiresPersonhood` | Whether `purchase` requires a Purchase certificate |

Any other combination reverts with `InvalidPolicy`. The report's richer price ceiling, `min(global cap, alpha·S, beta·pages·ratingMultiplier)`, is computed by the backend when it issues a quote. The contract enforces only `[minPrice, maxPrice]`.

## 6. Publication record

| Group | Fields |
| --- | --- |
| Frozen (from the quote) | `author`, `policyId`, `manifestHash`, `previewManifestHash`, `arweaveBundleTxId`, `arweavePreviewTxId`, `pageCount`, `ratingSnapshot`, `price`, `deposit` (S), `aiCap` |
| Review | `aiCost` (A) |
| Money | `grossSales` (R), `authorRefund` (F), `ownerAllocation` (O) |
| States | `state` (review), `listingState`, `settlementReason` |
| Timestamps | `createdAt`, `reviewedAt`, `appealDeadline`, `appealedAt`, `resolutionDeadline`, `decidedAt`, `publishedAt`, `delistedAt`, `settledAt` |

- Publication ids are sequential from 1. A new version of a comic is a new publication.
- The Arweave IDs are stored as `bytes32`: the 32 raw bytes of the 43-character Base64URL ID (section 10). Both must be non-zero and can never change.
- `arweaveBundleTxId` points to encrypted full pages. `arweavePreviewTxId` points to a public preview manifest holding the title, description, language, genre and preview image references. `previewManifestHash` hashes that manifest's canonical bytes, and `manifestHash` hashes the canonical bundle manifest. Both are `keccak256` **[OPEN Q4]**.
- `ratingSnapshot` is the author-rating snapshot frozen into the quote (report §7, items 12 and 15). It is a `uint8` whose scale is defined off chain.

## 7. State machines

Review state, listing state and settlement reason are separate fields. A published comic may have a settled deposit and still sell.

```
                 report: Approve
 Deposited ─────────────────────────────────────────► Approved ──publish──► Published
     │ report: Flag                                       ▲
     ▼                     resolveAppeal(approve)         │
  Flagged ──appeal (< appealDeadline)──► AppealPending ───┘
     │                                     │      │
     │ finalizeRejection                   │      │ claimAppealTimeout
     │ (>= appealDeadline)                 │      │ (>= resolutionDeadline)
     ▼                                     ▼      ▼
  Rejected (reason Rejected) ◄─resolveAppeal(reject)   Rejected (reason AppealTimeout)
```

Time boundaries follow the report:
- An action allowed "before a deadline" needs `block.timestamp < deadline`.
- The fallback becomes available when `block.timestamp >= deadline`.
- Expiry of a quote or certificate allows use while `block.timestamp <= expiresAt`.

| Function | Caller | Precondition | Effect | Paused? |
| --- | --- | --- | --- | --- |
| `createPublication` | Author | See section 8 | Deposited, Unlisted; `totalLockedDeposits += S` | **Blocked** |
| `submitReviewReport` | Anyone (relayer) | Deposited; valid unused report; `manifestHash` matches; `aiCost <= aiCap` | Sets A and `reviewedAt`; credits A; Approved, or Flagged with `appealDeadline = now + appealDuration` | Allowed |
| `appeal` | Author | Flagged, `now < appealDeadline` | AppealPending, `resolutionDeadline = now + appealResolutionDuration` | Allowed |
| `resolveAppeal` | `REVIEWER_ROLE` | AppealPending, `now < resolutionDeadline` | Approved, or Rejected and settled (`Rejected`) | Allowed |
| `finalizeRejection` | Anyone | Flagged, `now >= appealDeadline` | Rejected and settled (`Rejected`) | Allowed |
| `claimAppealTimeout` | Author | AppealPending, `now >= resolutionDeadline` | Rejected and settled (`AppealTimeout`) | Allowed |
| `publish` | Author | Approved, Unlisted | Published, Listed, `publishedAt` | Allowed |
| `purchase` | Buyer | Published and Listed; `msg.value == price`; unused `requestId`; buyer not entitled; valid Purchase certificate if the policy requires one | Entitlement; `R += P`; fee and proceeds credited; if the deposit is unsettled and `R >= S`, settles (`ThresholdReached`) | **Blocked** |
| `refundAndDelist(id, minRefund)` | Author | Published and Listed; `now >= publishedAt + refundDelay`; `R < S`; deposit unsettled; `F >= minRefund` | Delisted, settles (`AuthorRefund`) | Allowed |
| `withdraw` | Credit holder | Credit > 0 | Sends the full credit (`nonReentrant`, checks-effects-interactions) | Allowed |

Pausing blocks only new deposits and purchases. Review, appeals, publishing, refunds and withdrawals keep working, so pausing never traps funds or makes a deadline pass unfairly. Deadlines keep running while the contract is paused.

There is no automatic refund or forfeiture when time passes. Delisting without a refund, and delisting before `refundDelay`, are not supported. The report says not to add them silently.

### Entitlements

- `hasReadingAccess(id, account)` returns true if `account` is the author or has purchased `id`.
- Entitlements are permanent and survive delisting.
- One entitlement per wallet per publication; a repeat purchase reverts. Self-purchases are allowed and count toward `R`.
- `requestId` is a buyer-chosen, globally unique `bytes32` idempotency key.

## 8. EIP-712 and publication creation

Domain: `name = "ConsentCraftMarket"`, `version = "1"`, `chainId`, `verifyingContract`. It is exposed via ERC-5267 `eip712Domain()`. Enums are encoded as `uint8`, and field order is normative. Every field is static, so the contract hashes `abi.encode(TYPEHASH, struct)` directly.

```
PublicationQuote(address author,bytes32 manifestHash,bytes32 previewManifestHash,bytes32 arweaveBundleTxId,bytes32 arweavePreviewTxId,uint32 pageCount,uint256 policyId,uint256 price,uint256 deposit,uint256 aiCap,uint8 ratingSnapshot,uint64 expiresAt,uint256 nonce)

PersonhoodCertificate(address wallet,uint8 action,uint64 expiresAt,uint256 nonce)      action: 0 = PUBLISH, 1 = PURCHASE

ReviewReport(bytes32 reportId,uint256 publicationId,bytes32 manifestHash,uint8 outcome,uint256 aiCost,bytes32 reportHash,uint64 expiresAt)
```

| Type | Signer | Replay protection |
| --- | --- | --- |
| PublicationQuote | `QUOTE_SIGNER_ROLE` | `nonce` single use (global quote-nonce set), plus domain and expiry |
| PersonhoodCertificate | `QUOTE_SIGNER_ROLE` | `nonce` single use (global certificate-nonce set), bound to wallet and action, plus domain and expiry |
| ReviewReport | `REPORTER_ROLE` | `reportId` single use; a publication accepts one report |

The backend should draw nonces at random as 256-bit values. Nonces are consumed only when a call succeeds, so a reverted transaction can be retried with the same signatures.

`createPublication(quote, quoteSignature, certificate, certificateSignature)` is payable and `whenNotPaused`. It checks the following in order and reverts on the first failure:

1. `quote.author == msg.sender` (`QuoteAuthorMismatch`)
2. `block.timestamp <= quote.expiresAt` (`QuoteExpired`)
3. The quote nonce is unused (`QuoteNonceUsed`)
4. The quote signature recovers to a `QUOTE_SIGNER_ROLE` holder (`InvalidQuoteSignature`)
5. `certificate.wallet == msg.sender` (`CertificateWalletMismatch`), `action == Publish` (`CertificateActionMismatch`), `block.timestamp <= expiresAt` (`CertificateExpired`), unused nonce (`CertificateNonceUsed`), valid signer (`InvalidCertificateSignature`)
6. The policy exists (`UnknownPolicy`)
7. Both manifest hashes are non-zero (`ZeroManifestHash`), both Arweave IDs are non-zero (`ZeroArweaveTxId`), and `pageCount > 0` (`ZeroPageCount`)
8. `minPrice <= price <= maxPrice` (`PriceOutOfBounds`)
9. `deposit > aiCap` (`InvalidDepositTerms`)
10. `msg.value == deposit` (`DepositMismatch`)

Then it marks both nonces used, stores the publication with `createdAt = block.timestamp`, adds S to `totalLockedDeposits`, and emits `PublicationCreated`.

## 9. Events

Every state change emits an event. Together they let an indexer rebuild the marketplace and the trade feed without private data.

| Event | Emitted by |
| --- | --- |
| `PolicyCreated` (all policy fields) | `createPolicy` |
| `OwnerRecipientUpdated`, `AiExpenseRecipientUpdated` | Constructor (previous recipient is zero) and the setters |
| `PublicationCreated` (id, author, policyId, manifestHash, previewManifestHash, both Arweave IDs, pageCount, price, deposit, aiCap) | `createPublication`; implies Deposited and Unlisted |
| `ReviewStatusChanged` | Every review-state transition after creation |
| `ReviewReportSubmitted`, `PublicationFlagged`, `AppealFiled`, `AppealResolved`, `PublicationApproved`, `PublicationRejected` | Review and appeal steps |
| `PublicationPublished` (price, `refundEligibleAt`) | `publish` |
| `PublicationDelisted` | `refundAndDelist` |
| `Purchased` (id, buyer, requestId, price, platformFee, authorProceeds, cumulativeGrossSales) | `purchase` |
| `DepositSettled` (reason, S, A, F, O, R) | Any settlement |
| `Credited` (account, publicationId, kind, amount) | Every non-zero credit |
| `Withdrawn` | `withdraw` |
| `Paused`, `Unpaused`, `RoleGranted`, `RoleRevoked`, `RoleAdminChanged` | Inherited from OpenZeppelin |

## 10. Arweave transaction IDs

According to the [Arweave HTTP API docs](https://docs.arweave.org/developers/arweave-node-server/http-api), a transaction `id` is "A SHA-256 hash of the transaction signature", serialized as a case-sensitive Base64URL string. That is 32 bytes, or 43 unpadded characters, stored directly as `bytes32`.

[contracts/lib/arweave-tx-id.ts](../contracts/lib/arweave-tx-id.ts) converts between the two forms. It rejects:
- the wrong length
- padding
- the characters `+` and `/`
- whitespace
- non-canonical trailing bits
- the all-zero value

## 11. Security notes

- Checks-effects-interactions everywhere. `nonReentrant` on every function that sends ETH.
- `withdraw` uses `call`, and a failure reverts and preserves the credit. A recipient that rejects ETH blocks only its own withdrawal.
- Arithmetic is checked (0.8.x).
- A reviewer should be separate from the financial beneficiary where feasible. The owner gains from rejections, which is a governance risk the report says must be disclosed.

## 12. Conflicts with the report

| Topic | Report | This spec | Resolution |
| --- | --- | --- | --- |
| Paid page storage | "Protected file storage", "private object storage", "full paid pages are not publicly retrievable", plus takedown remedies | Encrypted bundles on permanent public Arweave | **[OPEN Q5]** The ciphertext is public and permanent, so a leaked key can't be revoked by deleting the file, and takedowns can only revoke keys. |
| Rejection settlement | Rejection forfeits `S - A`; F = 0 | Previously applied the general formula | Spec now follows the report |
| Refund eligibility | 30 days after publication, R < S, unsettled; optional minimum refund; no early or plain delisting | Previously allowed refunds on Approved, and delisting after threshold | Spec now follows the report |
| Deadline boundaries | Appeal strictly before the deadline; finalization at or after it | Previously `<=` and `>` | Spec now follows the report |
| Rating snapshot | Author-rating snapshot frozen at submission | Previously set by the review report | Now carried in the quote, as the Part 2 prompt specifies |
| Pause scope | Pausing stops new financial exposure | Previously also blocked reports and publishing | Now blocks only deposits and purchases |

## 13. Open questions

- **Q1:** AppealTimeout returns `S - A`. The report recommends this but says it needs product approval.
- **Q2:** The personhood certificate is single use and covers one action. Should a buyer get a fresh certificate for every purchase? The report implies short-lived certificates.
- **Q3:** There is no exit when the review never completes, so S stays locked. The report lists "service failure exit" as an undecided launch decision.
- **Q4:** Are the manifest hashes `keccak256`, or SHA-256?
- **Q5:** Should encrypted bundles go on public, permanent Arweave (your spec) or on private storage (the report)?
