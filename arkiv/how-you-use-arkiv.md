# How ConsentCraft uses Arkiv

## Data flow

```
Sepolia ConsentCraftMarket ──events──► indexer (confirmed blocks only) ──► Arkiv Rabdi entities ──► frontend search and trade feed
                                         │                                    (owned by the writer wallet)
                                         └── Arweave preview manifest, verified against previewManifestHash
```

1. The indexer reads `PublicationCreated`, `ReviewStatusChanged`, `PublicationPublished`, `PublicationDelisted` and `Purchased` from blocks at least `INDEXER_CONFIRMATIONS` deep.
2. It folds them into a deterministic projection (listings, trades).
3. For each listing, it fetches the public preview manifest from Arweave and hashes the exact bytes. Only a match with the on-chain `previewManifestHash` lets title, genre, language and preview reference into Arkiv.
4. It writes `consentcraft.listing.v1` and `consentcraft.trade.v1` entities (see [schema.md](schema.md)):
   - creates when no entity with that `listingId` / `tradeId` exists among its own
   - patches when the content hash changed
   - leaves them alone otherwise
5. Reorgs are detected through the stored hash of the last indexed block. The projection is rebuilt from events, and entities whose events disappeared are deleted.
6. `renew` keeps active entities alive; Arkiv caps a lifetime at about 182 days.
7. The frontend uses `searchListings` and `recentTrades` ([indexer/src/read.ts](../indexer/src/read.ts)). Before releasing content keys, it checks reading access on the contract, never on Arkiv.

## SDK features used

`createPublicClient`, `createWalletClient`, `rabdi({ accessKey })`, `defineSchema` with indexed and optional columns, `createEntity`, `patchEntity` (`set` / `unset`), `extendEntity`, `deleteEntity`, `ExpirationTime.fromDays`, and the query builder (`select`, `from`, `where`, `eq`, `gte`, `lte`, `gt`, `and`, `ownedBy`, `orderBy`, `limit`).

## Verified results

| Date | What | Result |
| --- | --- | --- |
| 2026-11-06 | `eth_chainId` on the Rabdi RPC | `0x76edaf` (7794095) |
| 2026-11-06 | Keyless SDK query with a filter | Returned rows (another project's entities) in 384 ms |
| 2026-11-06 | `searchListings` (genre, language, author, u256 price range, review status) and `recentTrades` against Rabdi | Accepted by the node; 0 rows (nothing written yet) |
| 2026-11-06 | Raw `arkiv_query` JSON-RPC with our schema and owner | `{"data":[],"blockNumber":"0x43b42"}` |
| 2026-11-06 | Indexer test suite (recorded real contract events) | 21 passing |
| n/a | **Real entity write** | **Not done:** no funded writer key configured |

## TODO (team)

- [ ] After funding the writer: run `npm run indexer:test:live` and record the entity key and transaction hash here
- [ ] After the Sepolia deployment: run `npm run indexer -- backfill` and record entity counts and keys
- [ ] Screenshots or explorer links of entities on <https://rabdi.explorer.arkiv.network>
