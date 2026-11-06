# Arkiv schema

ConsentCraft writes two kinds of public entities to the Arkiv **Rabdi testnet** (chain ID 7794095, RPC `https://rpc.rabdi.db-chain.testnet.arkiv.network`, explorer <https://rabdi.explorer.arkiv.network>). They are projected from confirmed ConsentCraftMarket events by the [indexer](../indexer/README.md), and defined in [indexer/src/entities.ts](../indexer/src/entities.ts).

Both are a public index. The Sepolia contract is the authority for payments, ownership and reading access.

## Owner

Every entity is owned by the indexer's writer wallet. Readers must filter by that owner (`ownedBy(writer)`), because anyone can write entities that carry the same schema tag.

| Network | Writer address |
| --- | --- |
| Rabdi testnet | **TODO (team):** fill in after the writer wallet is created and funded |

## Expiry

| Setting | Value |
| --- | --- |
| Lifetime per create or extension | 180 days (`ARKIV_ENTITY_TTL_DAYS`). The SDK caps it at 7,884,000 blocks × 2 s ≈ 182.5 days. |
| Renewal | `renew` extends any active entity within 30 days of expiry (`ARKIV_RENEW_BEFORE_DAYS`), and recreates any that already expired |
| Renewed | Listings that aren't rejected, and all trades |
| Allowed to expire | Rejected listings |

Expiry or an outage removes index rows only. It never affects ownership, payments or reading access, which live on the contract.

## `consentcraft.listing.v1`: one per (chain, contract, publication)

Identity: `listingId = keccak256(abi.encode(chainId, contract, publicationId))`. Arkiv assigns the entity key itself, so the indexer finds an existing entity by `listingId` before creating one.

| Attribute | Type | Indexed | Source |
| --- | --- | --- | --- |
| `listingId` | key | yes | derived |
| `chainId` | u64 | yes | config |
| `contract` | addr | yes | config |
| `publicationId` | u64 | yes | `PublicationCreated` |
| `author` | addr | yes | `PublicationCreated` |
| `title` | str (≤128 bytes, truncated with "…") | no | verified preview manifest |
| `genre` | str, lowercase | yes | verified preview manifest |
| `language` | str, lowercase | yes | verified preview manifest |
| `price` | u256 (wei) | yes | `PublicationCreated` |
| `pageCount` | u64 | no | `PublicationCreated` |
| `previewRef` | str (`ar://<43 chars>`), optional | no | verified preview manifest, first `ar://` image |
| `arweavePreviewTxId` | str (43-char Base64URL) | no | `PublicationCreated` |
| `previewManifestHash` | key | no | `PublicationCreated` |
| `metadataStatus` | str: `verified`, `unavailable`, `pending` | yes | indexer |
| `reviewStatus` | str: `deposited`, `flagged`, `appeal_pending`, `approved`, `published`, `rejected` | yes | `ReviewStatusChanged` |
| `listingStatus` | str: `unlisted`, `listed`, `delisted` | yes | `PublicationPublished`, `PublicationDelisted` |
| `totalSales` | u256 (wei, R) | no | `Purchased.cumulativeGrossSales` |
| `salesCount` | u64 | no | count of `Purchased` |
| `policyId` | u64 | yes | `PublicationCreated` |
| `sourceTx` | key | no | `PublicationCreated` transaction |
| `sourceBlock`, `lastEventBlock` | u64 | no | logs |
| `contentHash` | key | no | hash of the other values (skips no-op patches) |
| `schemaVersion` | u64 (1) | yes | constant |

`title`, `genre`, `language` and `previewRef` are written **only** when the manifest bytes fetched from Arweave hash to the on-chain `previewManifestHash`. Otherwise `metadataStatus` is `unavailable` and those attributes are absent.

**Never written:** decryption keys, pages, World ID proofs, appeal evidence, review rationale, and `arweaveBundleTxId` (the encrypted bundle).

## `consentcraft.trade.v1`: one per `Purchased` event

Identity: `tradeId = keccak256(abi.encode(chainId, contract, txHash, logIndex))`. Reruns map to the same id.

| Attribute | Type | Indexed |
| --- | --- | --- |
| `tradeId` | key | yes |
| `listingId` | key | yes |
| `chainId` | u64 | yes |
| `contract` | addr | yes |
| `publicationId` | u64 | yes |
| `buyer` | addr | yes |
| `price`, `platformFee`, `authorProceeds`, `cumulativeSales` | u256 (wei) | no |
| `blockNumber` | u64 | yes |
| `timestamp` | u64 (unix seconds) | no |
| `txHash` | key | no |
| `logIndex` | u64 | no |
| `feedOrder` | u64 = blockNumber × 1,000,000 + logIndex (sort key) | no |
| `contentHash` | key | no |
| `schemaVersion` | u64 (1) | yes |

## Queries the frontend runs

Defined in [indexer/src/read.ts](../indexer/src/read.ts). Every query adds `$owner = <writer>`.

| Helper | Predicates | Order |
| --- | --- | --- |
| `searchListings` | `chainId`, `contract`, `genre`, `language`, `author`, `price >= / <=`, `reviewStatus`, `listingStatus` (default `listed`), `metadataStatus = verified` (default), `$key > cursor` | `$key` ascending, pages of up to 100 |
| `recentTrades` | `chainId`, `contract`, optional `publicationId` | `feedOrder` descending |

Example rendered query (SDK query language):

```
arkiv.schema = str('consentcraft.listing.v1') AND genre = str('fantasy') AND $owner = addr(0x…) ORDER BY $key:key ASC
```
