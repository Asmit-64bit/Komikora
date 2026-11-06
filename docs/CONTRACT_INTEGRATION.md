# ConsentCraftMarket integration guide

For backend, indexer and frontend developers integrating with the deployed contract. The rules are in [CONTRACT_SPEC.md](CONTRACT_SPEC.md) and the security review in [CONTRACT_AUDIT.md](CONTRACT_AUDIT.md).

| Artifact | Path |
| --- | --- |
| JSON ABI | [contracts/abi/ConsentCraftMarket.json](../contracts/abi/ConsentCraftMarket.json) |
| Typed ABI (`as const`, for viem and wagmi) | [contracts/abi/ConsentCraftMarket.ts](../contracts/abi/ConsentCraftMarket.ts) |
| Deployment record | `contracts/deployments/sepolia.json` (format: [sepolia.example.json](../contracts/deployments/sepolia.example.json), [lib/deployment.ts](../contracts/lib/deployment.ts)) |
| EIP-712 types and signing | [contracts/lib/eip712.ts](../contracts/lib/eip712.ts) |
| Arweave ID conversion | [contracts/lib/arweave-tx-id.ts](../contracts/lib/arweave-tx-id.ts) |

All amounts are native ETH in wei (`bigint` in TypeScript; decimal strings in JSON). Timestamps are unix seconds from block time. The contract's clock is authoritative, and UI timers are informational only.

## 1. Trust boundaries

| System | Authority | Notes |
| --- | --- | --- |
| Contract (Sepolia) | Deposits, sales, entitlements, settlements, withdrawals | Rules are enforced on chain; hiding UI controls is never the safeguard. |
| Backend | Holds content keys. Signs quotes, personhood certificates and review reports. Releases keys. | A trusted signer. The contract checks every signature against a role. |
| Arweave | Stores encrypted bundles and public previews | The contract can't verify contents or availability. Uploads are permanent. |
| Arkiv | Public index built from contract events | Never a source of truth for money or access. |

Personhood certificates are a **trusted backend bridge**: the backend verifies World ID off chain and signs a certificate. The contract doesn't verify World ID proofs itself.

## 2. Actors and keys

| Actor | Key | Calls | Signs |
| --- | --- | --- | --- |
| Author | User wallet | `createPublication`, `appeal`, `publish`, `refundAndDelist`, `withdraw` | None |
| Buyer | User wallet | `purchase`, `withdraw` (if it holds credits) | None |
| Quote signer | Backend key with `QUOTE_SIGNER_ROLE` | None | `PublicationQuote`, `PersonhoodCertificate` |
| Reporter | Backend key with `REPORTER_ROLE` | None (a relayer submits) | `ReviewReport` |
| Relayer | Any account | `submitReviewReport` | None |
| Reviewer | `REVIEWER_ROLE` | `resolveAppeal` | None |
| Pauser | `PAUSER_ROLE` | `pause`, `unpause` | None |
| Admin | `DEFAULT_ADMIN_ROLE` (use a multisig) | `createPolicy`, `setOwnerRecipient`, `setAiExpenseRecipient`, `grantRole`, `revokeRole` | None |
| Anyone | Any account | `finalizeRejection`, `claimAppealTimeout` | None |
| Owner recipient, AI expense recipient | Configured addresses | `withdraw` | None |
| Key service, indexer | Read-only | Views and events | None |

## 3. Functions

### Writes

| Function | Caller | Payable | Paused | Preconditions (revert) | Effect |
| --- | --- | --- | --- | --- | --- |
| `createPolicy(Policy)` | Admin | No | Allowed | `feeBps ≤ 10000`, `minPrice > minFee`, `maxPrice ≥ minPrice`, durations in `[1, 2^32−1]` (`InvalidPolicy`) | Appends an immutable policy; returns its id |
| `setOwnerRecipient(addr)` / `setAiExpenseRecipient(addr)` | Admin | No | Allowed | Non-zero (`ZeroAddress`) | Future credits only |
| `pause()` / `unpause()` | Pauser | No | n/a | OZ `EnforcedPause` / `ExpectedPause` | Blocks or unblocks `createPublication` and `purchase` |
| `createPublication(quote, quoteSig, cert, certSig)` | Author | `= deposit` | **Blocked** | See [§5.1](#51-publicationquote) | New id, Deposited, Unlisted; S locked |
| `submitReviewReport(id, report, sig)` | Anyone | No | Allowed | See [§5.3](#53-reviewreport) | A credited to the AI recipient; Approved or Flagged |
| `appeal(id, evidenceHash)` | Author | No | Allowed | Flagged; `now < appealDeadline` | AppealPending; sets `appealResolutionDeadline` |
| `resolveAppeal(id, approved, reasonHash)` | Reviewer | No | Allowed | AppealPending; `now < appealResolutionDeadline` | Approved, or Rejected (owner gets S − A) |
| `finalizeRejection(id)` | Anyone | No | Allowed | Flagged; `now ≥ appealDeadline` | Rejected (owner gets S − A) |
| `claimAppealTimeout(id)` | Anyone | No | Allowed | AppealPending; `now ≥ appealResolutionDeadline` | Rejected (author gets S − A; *pending product approval*) |
| `publish(id)` | Author | No | Allowed | Approved; Unlisted | Published, Listed; `refundEligibleAt = now + refundDelay` |
| `purchase(id, requestId, cert, certSig)` | Buyer | `= price` | **Blocked** | Published and Listed; exact value; non-zero, unused `requestId`; one per wallet; PURCHASE certificate if the policy requires one | Entitlement; R += P; fee to owner, rest to author; threshold settlement when R ≥ S |
| `refundAndDelist(id, minRefund)` | Author | No | Allowed | Published and Listed; unsettled; R < S; `now ≥ refundEligibleAt`; F ≥ `minRefund` | Delisted; author gets F and owner gets O |
| `withdraw()` | Credit holder | No | Allowed | Credit > 0 | Sends the full credit; reverts on failure (credit kept) |

### Views

| Function | Returns |
| --- | --- |
| `getPublication(id)` | Full `Publication` struct (reverts `UnknownPublication`) |
| `getPolicy(id)` | `Policy` (reverts `UnknownPolicy`) |
| `publicationCount()`, `policyCount()` | Ids are `1..count` |
| `hasReadingAccess(id, wallet)` | True if `wallet` bought `id`; never revoked. Authors aren't included automatically. |
| `saleFee(policyId, price)` | `max(minFee, floor(price × feeBps / 10000))` |
| `previewSettlement(id)` | `(D, F, O)` for an AuthorRefund now; pass F as `minRefund` |
| `creditOf(account)` | Withdrawable wei |
| `totalCredits()`, `totalLockedDeposits()`, `totalLiabilities()`, `liabilitiesCovered()` | Solvency |
| `isQuoteNonceUsed(n)`, `isCertificateNonceUsed(n)`, `isJobIdUsed(id)`, `isRequestIdUsed(id)` | Replay state, for reload recovery |
| `ownerRecipient()`, `aiExpenseRecipient()`, `paused()`, `hasRole(role, account)` | Configuration |
| `eip712Domain()` | ERC-5267 domain fields |
| `QUOTE_SIGNER_ROLE()` … `PAUSER_ROLE()`, `*_TYPEHASH()` | Constants |

## 4. State transitions

```
                 report: flagged = false
 Deposited ─────────────────────────────────────────► Approved ──publish──► Published
     │ report: flagged = true                             ▲               (Listed)
     ▼                     resolveAppeal(true)            │                   │ refundAndDelist
  Flagged ──appeal (now < appealDeadline)──► AppealPending┘                   ▼
     │                                     │          │               Published (Delisted)
     │ finalizeRejection                   │          │ claimAppealTimeout
     │ (now >= appealDeadline)             │          │ (now >= appealResolutionDeadline)
     ▼                                     ▼          ▼
  Rejected / Rejected  ◄── resolveAppeal(false)    Rejected / AppealTimeout
```

| From | Action | Caller | To | Settlement |
| --- | --- | --- | --- | --- |
| None | `createPublication` | Author | Deposited, Unlisted | None |
| Deposited | `submitReviewReport` (not flagged) | Anyone | Approved | None (A credited) |
| Deposited | `submitReviewReport` (flagged) | Anyone | Flagged | None (A credited) |
| Flagged | `appeal` | Author | AppealPending | None |
| Flagged | `finalizeRejection` | Anyone | Rejected | Rejected: F = 0, O = S − A |
| AppealPending | `resolveAppeal(true)` | Reviewer | Approved | None |
| AppealPending | `resolveAppeal(false)` | Reviewer | Rejected | Rejected: F = 0, O = S − A |
| AppealPending | `claimAppealTimeout` | Anyone | Rejected | AppealTimeout: F = S − A, O = 0 |
| Approved | `publish` | Author | Published, Listed | None |
| Published, Listed | `purchase` reaching R ≥ S | Buyer | (unchanged; still Listed) | ThresholdReached: F = 0, O = S − A |
| Published, Listed | `refundAndDelist` | Author | Published, Delisted | AuthorRefund: D = min(S, max(R, A, ⌈S/4⌉)), F = S − D, O = D − A |

Every settlement satisfies S = A + F + O and happens at most once. Service errors (timeouts, unsupported models, malformed AI output) must never produce a signed report. The publication stays Deposited and nothing can forfeit its deposit.

## 5. EIP-712

Domain: `{ name: "ConsentCraftMarket", version: "1", chainId, verifyingContract: <market address> }`. Enums are encoded as `uint8`. Use the type objects in [lib/eip712.ts](../contracts/lib/eip712.ts) rather than retyping them: the test suite signs with those same objects.

### 5.1 PublicationQuote

```
PublicationQuote(address author,bytes32 manifestHash,bytes32 previewManifestHash,bytes32 arweaveBundleTxId,bytes32 arweavePreviewTxId,uint32 pageCount,uint256 policyId,uint256 price,uint256 deposit,uint256 aiCap,uint8 ratingSnapshot,uint64 expiresAt,uint256 nonce)
```

Signed by `QUOTE_SIGNER_ROLE`, only after the backend has confirmed both Arweave transactions and their hashes. `createPublication` checks, in order:
1. `author == msg.sender`
2. not expired (`now ≤ expiresAt`)
3. nonce unused
4. valid signer
5. certificate (§5.2, action PUBLISH)
6. policy exists
7. non-zero hashes, Arweave IDs and page count
8. `minPrice ≤ price ≤ maxPrice`
9. `deposit > aiCap`
10. `msg.value == deposit`

### 5.2 PersonhoodCertificate

```
PersonhoodCertificate(address wallet,uint8 action,uint64 expiresAt,uint256 nonce)      action: 0 = PUBLISH, 1 = PURCHASE
```

Signed by `QUOTE_SIGNER_ROLE` after the backend's World ID check. It is single use (the nonce is consumed), bound to `wallet == msg.sender` and to one action. It isn't bound to a publication. `purchase` checks it only when the policy has `purchaseRequiresPersonhood`; otherwise pass a zeroed certificate and `"0x"`.

### 5.3 ReviewReport

```
ReviewReport(uint256 publicationId,bytes32 manifestHash,bytes32 arweaveBundleTxId,bytes32 reportHash,bytes32 modelVersion,bytes32 promptVersion,uint256 policyId,uint16 score,bool flagged,uint256 aiCost,bytes32 jobId)
```

Signed by `REPORTER_ROLE`; anyone may relay it. It requires:
- the publication is Deposited
- `report.publicationId` equals the argument
- `jobId` is unused (across all publications)
- a valid signer
- `manifestHash`, `arweaveBundleTxId` and `policyId` match the publication
- `aiCost ≤ aiCap`

Use a random `jobId`, and derive the idempotency key on your side from (publication, content hash).

### 5.4 Signing in the backend (TypeScript)

```ts
import { privateKeyToAccount } from "viem/accounts";
import {
  PersonhoodAction, randomBytes32, randomNonce,
  signPersonhoodCertificate, signPublicationQuote, signReviewReport,
  type PersonhoodCertificate, type PublicationQuote, type ReviewReport,
} from "./contracts/lib/eip712";
import { arweaveTxIdToBytes32 } from "./contracts/lib/arweave-tx-id";
import deployment from "./contracts/deployments/sepolia.json";

const chainId = deployment.chainId;            // 11155111
const market = deployment.address as `0x${string}`;
const quoteSigner = privateKeyToAccount(process.env.QUOTE_SIGNER_PRIVATE_KEY as `0x${string}`); // server only
const reporter = privateKeyToAccount(process.env.REPORTER_PRIVATE_KEY as `0x${string}`);       // server only

// 1. After confirming both Arweave transactions and re-hashing their bytes:
const quote: PublicationQuote = {
  author,                                                   // the session wallet
  manifestHash, previewManifestHash,                        // keccak256 of canonical manifest bytes
  arweaveBundleTxId: arweaveTxIdToBytes32(bundleTxId),      // 43-char base64url -> bytes32
  arweavePreviewTxId: arweaveTxIdToBytes32(previewTxId),
  pageCount, policyId: 1n, price, deposit, aiCap, ratingSnapshot,
  expiresAt: BigInt(Math.floor(Date.now() / 1000) + 15 * 60),
  nonce: randomNonce(),                                     // persist it for reload recovery
};
const quoteSignature = await signPublicationQuote(quoteSigner, chainId, market, quote);

// 2. After World ID verification for this wallet and action:
const certificate: PersonhoodCertificate = {
  wallet: author, action: PersonhoodAction.Publish,
  expiresAt: quote.expiresAt, nonce: randomNonce(),
};
const certificateSignature = await signPersonhoodCertificate(quoteSigner, chainId, market, certificate);
// -> return { quote, quoteSignature, certificate, certificateSignature } to the author's wallet,
//    which calls createPublication(...) with value = quote.deposit.

// 3. After a successful review only (never on service errors):
const report: ReviewReport = {
  publicationId, manifestHash: quote.manifestHash, arweaveBundleTxId: quote.arweaveBundleTxId,
  reportHash, modelVersion, promptVersion, policyId: quote.policyId,
  score, flagged, aiCost, jobId: randomBytes32(),
};
const reportSignature = await signReviewReport(reporter, chainId, market, report);
// -> any relayer calls submitReviewReport(publicationId, report, reportSignature).
```

The helpers depend only on `viem` and Web Crypto. The same calls run in [scripts/smoke-sepolia.ts](../contracts/scripts/smoke-sepolia.ts) and in the test *backend signing helpers are accepted by the contract*. Never send signer keys to the browser.

## 6. Arweave transaction IDs

Arweave IDs are 43-character unpadded Base64URL strings that encode 32 bytes. They are stored as `bytes32`.

```ts
import { arweaveTxIdToBytes32, bytes32ToArweaveTxId, isArweaveTxId } from "./contracts/lib/arweave-tx-id";

arweaveTxIdToBytes32("BNttzDav3jHVnNiV7nYbQv-GY0HQ-4XXsdkE5K9ylHQ");
// "0x04db6dcc36afde31d59cd895ee761b42ff866341d0fb85d7b1d904e4af729474"
bytes32ToArweaveTxId("0x04db6dcc36afde31d59cd895ee761b42ff866341d0fb85d7b1d904e4af729474");
// "BNttzDav3jHVnNiV7nYbQv-GY0HQ-4XXsdkE5K9ylHQ"
isArweaveTxId("BNttzDav3jHVnNiV7nYbQv-GY0HQ-4XXsdkE5K9ylHQ="); // false (padding is rejected)
```

Both converters throw `InvalidArweaveTxIdError` for:
- the wrong length
- padding
- the characters `+` and `/`
- whitespace
- non-canonical trailing bits
- the all-zero value

## 7. Events

All events come from the market address. An indexer starts at `deployments/sepolia.json#startBlock`.

| Event | Indexed | Data | Emitted by |
| --- | --- | --- | --- |
| `PolicyCreated` | policyId | minFee, feeBps, minPrice, maxPrice, appealDuration, appealResolutionDuration, refundDelay, purchaseRequiresPersonhood | `createPolicy` |
| `OwnerRecipientUpdated`, `AiExpenseRecipientUpdated` | previous, new | None | Constructor, setters |
| `PublicationCreated` | publicationId, author, policyId | manifestHash, previewManifestHash, arweaveBundleTxId, arweavePreviewTxId, pageCount, price, deposit, aiCap | `createPublication` (implies Deposited, Unlisted) |
| `ReviewReportSubmitted` | publicationId, jobId | flagged, score, aiCost, reportHash, modelVersion, promptVersion | `submitReviewReport` |
| `ReviewStatusChanged` | publicationId | previousState, newState | Every review-state change after creation |
| `PublicationFlagged` | publicationId | flaggedAt, appealDeadline | Flagged report |
| `AppealFiled` | publicationId | evidenceHash, appealResolutionDeadline | `appeal` |
| `AppealResolved` | publicationId, reviewer | approved, reasonHash | `resolveAppeal` |
| `PublicationApproved` | publicationId | path (0 Report, 1 Appeal) | Approval |
| `PublicationRejected` | publicationId | reason (1 Rejected, 2 AppealTimeout) | Rejection |
| `PublicationPublished` | publicationId | price, refundEligibleAt | `publish` (implies Listed) |
| `PublicationDelisted` | publicationId | None | `refundAndDelist` |
| `Purchased` | publicationId, buyer, requestId | price, platformFee, authorProceeds, cumulativeGrossSales | `purchase` |
| `DepositSettled` | publicationId, reason | deposit, aiCost, authorRefund, ownerAllocation, grossSales | Any settlement |
| `Credited` | account, publicationId, kind | amount | Every non-zero credit (kind: 0 SaleProceeds, 1 PlatformFee, 2 AiExpense, 3 DepositRefund, 4 OwnerAllocation) |
| `Withdrawn` | account | amount | `withdraw` |
| `Paused`, `Unpaused`, `RoleGranted`, `RoleRevoked`, `RoleAdminChanged` | (OpenZeppelin) | None | Admin and pauser |

Enum values:
- **PublicationState:** 0 Deposited, 1 Flagged, 2 AppealPending, 3 Approved, 4 Published, 5 Rejected
- **ListingState:** 0 Unlisted, 1 Listed, 2 Delisted
- **SettlementReason:** 0 None, 1 Rejected, 2 AppealTimeout, 3 ThresholdReached, 4 AuthorRefund

### Rebuilding the Arkiv index

A test rebuilds every listing, the trade feed, buyer access and all credit balances from these events alone and matches contract state.
- **Listing entity**, keyed by (chain, market address, publicationId): created from `PublicationCreated` and updated by the review, publish, delist, `Purchased` and settlement events. Convert Arweave IDs back with `bytes32ToArweaveTxId`. Fetch display metadata from the preview manifest on Arweave and check it against `previewManifestHash`. `ratingSnapshot` isn't in an event; read it once from `getPublication` (it's frozen).
- **Trade entity**, one per `Purchased`, keyed by (txHash, logIndex).
- Show as purchasable only publications whose `state` is Published and whose `listingState` is Listed.
- Project only confirmed blocks. Handle reorgs by keying on (blockHash, logIndex) and replaying, and renew Arkiv entities before they expire. Never treat Arkiv as proof of payment or access.

## 8. Reading access (key service)

Before releasing a content key, authenticate the session wallet, then require either:
- `hasReadingAccess(id, wallet)` at a confirmed block, or
- `wallet == getPublication(id).author`.

Access survives delisting and pausing.

## 9. Never put on chain, Arweave or Arkiv

Content keys, plaintext paid pages, World ID proofs or nullifiers, appeal text, review rationale and personal data. Only salted hashes (`evidenceHash`, `reasonHash`, `reportHash`) go on chain. `requestId` and `jobId` must be random, not derived from order or user data. Arweave uploads are permanent and can't be deleted.

## 10. Recovery and idempotency

- **Lost publication ID after a wallet prompt:** query `PublicationCreated` filtered by author, then match `manifestHash`. Also check `isQuoteNonceUsed(nonce)`.
- **Purchase retry:** if `isRequestIdUsed(requestId)` is true, it already succeeded. A `RequestIdAlreadyUsed` revert can also mean someone front-ran the ID (audit L-02); retry with a new random ID.
- **Refund race:** call `previewSettlement(id)` and pass its F as `minRefund`. If a purchase lands first, the refund reverts with `RefundBelowMinimum` instead of paying less.
