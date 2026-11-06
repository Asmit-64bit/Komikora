# ConsentCraftMarket integration guide

This guide covers who calls and signs what, and which event each step emits. The rules are in [CONTRACT_SPEC.md](CONTRACT_SPEC.md); the ABI comes from [IConsentCraftMarket.sol](../contracts/contracts/interfaces/IConsentCraftMarket.sol).

## Actors

| Actor | Key | Does |
| --- | --- | --- |
| Author wallet | User EOA | Calls `createPublication`, `appeal`, `claimAppealTimeout`, `publish`, `refundAndDelist`, `withdraw` |
| Buyer wallet | User EOA | Calls `purchase` and `withdraw` (only if it holds credits) |
| Backend quote signer | `QUOTE_SIGNER_ROLE` EOA (server-side) | Signs `PublicationQuote` and `PersonhoodCertificate`; never sends transactions |
| Reporter | `REPORTER_ROLE` EOA (server-side) | Signs `ReviewReport`. Any account, such as a backend relayer, may submit it. |
| Reviewer | `REVIEWER_ROLE` EOA | Calls `resolveAppeal` |
| Pauser | `PAUSER_ROLE` | Calls `pause` and `unpause` |
| Admin | `DEFAULT_ADMIN_ROLE` | Calls `createPolicy`, manages roles and recipients |
| Indexer | None | Reads contract events and writes Arkiv entities |
| Key service | Backend | Calls `hasReadingAccess` before releasing decryption keys |

## Publication flow

| # | Step | Who | On chain | Event(s) |
| --- | --- | --- | --- | --- |
| 1 | **Encrypt pages.** Generate a content key and encrypt every page. Build the canonical bundle manifest of ciphertext page references and compute `manifestHash`. The key stays in the backend key store. | Backend | None | None |
| 2 | **Upload to Arweave.** Upload the encrypted bundle (`arweaveBundleTxId`). Upload the public preview manifest with title, description, language, genre and preview image references (`arweavePreviewTxId`). Compute `previewManifestHash` over its canonical bytes. | Backend | None | None |
| 3 | **Confirm availability.** Fetch both transactions from a gateway, wait for confirmation, and re-hash the fetched bytes to check them against both hashes. Convert both IDs with `arweaveTxIdToBytes32`. | Backend | None | None |
| 4 | **Sign the quote.** Choose `policyId`, a `price` within `[minPrice, maxPrice]` (and the report's backend price ceiling), `deposit` and `aiCap` with `deposit > aiCap`, and the author's `ratingSnapshot`. Set a random 256-bit `nonce` and a short `expiresAt`, then sign `PublicationQuote` for the author's address. After World ID verification, also sign a single-use `PersonhoodCertificate` (`wallet` = author, `action` = 0 PUBLISH, random `nonce`, short `expiresAt`). Persist both nonces. | Backend quote signer | None | None |
| 5 | **Author calls `createPublication(quote, quoteSig, cert, certSig)`** with `msg.value = deposit`. | Author | Deposited, Unlisted | `PublicationCreated` (implies Deposited) |
| 6 | **Review.** The reporter checks the Arweave contents against both hashes, runs the review, and signs a `ReviewReport` with `outcome`, `aiCost <= aiCap` and `reportHash`. Anyone submits `submitReviewReport(report, sig)`. | Reporter, then relayer | Approved or Flagged; `A` credited | `ReviewReportSubmitted`, `Credited(AiExpense)`, `ReviewStatusChanged`, then `PublicationApproved(Report)` or `PublicationFlagged` |
| 6a | If flagged, the author may call `appeal(id, appealHash)` while `now < appealDeadline`. | Author | AppealPending | `AppealFiled`, `ReviewStatusChanged` |
| 6b | The reviewer calls `resolveAppeal(id, approve, resolutionHash)` while `now < resolutionDeadline`. | Reviewer | Approved, or Rejected and settled | `AppealResolved`, `ReviewStatusChanged`, then `PublicationApproved(Appeal)` or `PublicationRejected(Rejected)`, `DepositSettled`, `Credited` |
| 6c | If there is no appeal, anyone calls `finalizeRejection(id)` once `now >= appealDeadline`. Remainder `S - A` goes to the owner. | Anyone | Rejected and settled | `ReviewStatusChanged`, `PublicationRejected(Rejected)`, `DepositSettled`, `Credited` |
| 6d | If the appeal goes unresolved, the author calls `claimAppealTimeout(id)` once `now >= resolutionDeadline`. Refund `S - A` (pending approval). | Author | Rejected and settled | `ReviewStatusChanged`, `PublicationRejected(AppealTimeout)`, `DepositSettled`, `Credited` |
| 7 | **Publish.** The author calls `publish(id)`. | Author | Published, Listed | `ReviewStatusChanged`, `PublicationPublished` |
| 8 | **Index to Arkiv.** The indexer turns events into Arkiv listing and trade entities (see below). | Indexer | None | None |

## Sale, reading and exit

| Step | Who | On chain | Event(s) |
| --- | --- | --- | --- |
| If the policy has `purchaseRequiresPersonhood`, the backend signs a single-use `PersonhoodCertificate` (`action` = 1 PURCHASE) for the buyer. The buyer generates a unique `requestId`. | Backend, buyer | None | None |
| `purchase(id, requestId, cert, certSig)` with `msg.value = price` | Buyer | Entitlement; `R += P`; credits | `Purchased`, `Credited(PlatformFee)`, `Credited(SaleProceeds)`, and if `R >= S` for the first time: `DepositSettled(ThresholdReached)`, `Credited(OwnerAllocation)` |
| The key service checks `hasReadingAccess(id, buyer)` against a confirmed block before it releases the content key over an authenticated channel. | Backend | View call | None |
| `refundAndDelist(id, minRefund)` once `now >= publishedAt + refundDelay`, with `R < S` and an unsettled deposit. Pass `minRefund` from `previewSettlement` to guard against a concurrent purchase. | Author | Delisted and settled | `PublicationDelisted`, `DepositSettled(AuthorRefund)`, `Credited(DepositRefund / OwnerAllocation)` |
| `withdraw()` | Any credit holder | Credit set to 0, ETH sent | `Withdrawn` |

## Arkiv indexing

Arkiv is a derived, public, non-authoritative view. Rebuilding it from block 0 of the deployment must give the same result.

- **Listing entity**, keyed by `publicationId`. Created from `PublicationCreated` (frozen terms and both Arweave IDs, converted back with `bytes32ToArweaveTxId`). Updated by `ReviewStatusChanged`, `PublicationPublished`, `PublicationDelisted`, `DepositSettled` and `Purchased` (`cumulativeGrossSales`). Display metadata comes from the preview manifest on Arweave and is checked against `previewManifestHash`.
- **Trade entity**, one per `Purchased`, keyed by `(txHash, logIndex)`. It holds the buyer, requestId, price, fee, proceeds and cumulative sales.
- Only listings whose `state` is Published and whose `listingState` is Listed are shown as purchasable. Everything else is history.
- Wait for confirmations and handle reorgs by keying on `(blockHash, logIndex)` and replaying. Never treat Arkiv as proof of payment or access.

## Pausing

A `PAUSER_ROLE` account can pause `createPublication` and `purchase` only. Every other step, including withdrawals and refunds, keeps working. Pausing rejects new wallet transactions, so the UI should check `paused()` before asking for a deposit or payment.

## Never publish

Content keys, plaintext paid pages, World ID proofs or nullifiers, review rationale text (only its hash goes on chain) and appeal text (only its hash) must not appear on Arweave, Arkiv, in calldata or in events.

## Arweave ID helpers

```ts
// contracts/lib/arweave-tx-id.ts (dependency-free; import by relative path until a package export is added)
import { arweaveTxIdToBytes32, bytes32ToArweaveTxId } from "./lib/arweave-tx-id.js";

const bundle = arweaveTxIdToBytes32("BNttzDav3jHVnNiV7nYbQv-GY0HQ-4XXsdkE5K9ylHQ");
// 0x04db6dcc36afde31d59cd895ee761b42ff866341d0fb85d7b1d904e4af729474
bytes32ToArweaveTxId(bundle); // "BNttzDav3jHVnNiV7nYbQv-GY0HQ-4XXsdkE5K9ylHQ"
```

Both functions throw `InvalidArweaveTxIdError` on malformed input.
