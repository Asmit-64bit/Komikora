# ConsentCraft Arkiv indexer

A worker that projects **confirmed** ConsentCraftMarket events into public Arkiv entities for the marketplace (listings) and the trade feed. It also exports read helpers the frontend uses to query them.

The contract stays the authority for payments, ownership and reading access. Arkiv is a public index. If an Arkiv entity expires or the network is down, nobody loses ownership or access. The frontend and the key service must always check `hasReadingAccess` on the contract.

Entity design: [/arkiv/schema.md](../arkiv/schema.md). How it fits the product: [/arkiv/how-you-use-arkiv.md](../arkiv/how-you-use-arkiv.md).

## Status

| Check | Result |
| --- | --- |
| Unit and integration tests (recorded real contract events) | 21 passing |
| Live read queries against Arkiv Rabdi (chain 7794095) | Pass. The node accepted the listing search with every filter, plus the trade feed. Both returned 0 rows because nothing is written yet. |
| Live write | **Not run.** No `ARKIV_PRIVATE_KEY` is configured. |
| Indexing Sepolia | **Not run.** The market is not deployed yet (`contracts/deployments/sepolia.json` doesn't exist). |

## Setup

1. **Access key:** get a free Arkiv access key at <https://hub.arkiv.network/access-keys>. Without one, the public endpoint is heavily rate limited.
2. **Writer wallet:** create a dedicated wallet for entity writes and fund it with test tGLM at <https://hub.arkiv.network/faucet>. It owns every entity the indexer writes.
3. **Env file:** copy `indexer/.env.example` to `indexer/.env` and set:
   - `INDEXER_SOURCE_RPC_URL` (Sepolia)
   - `ARKIV_ACCESS_KEY`
   - `ARKIV_PRIVATE_KEY`
4. **Market address:** the indexer reads the market address and start block from `contracts/deployments/sepolia.json`, so deploy the contract first, or set `INDEXER_MARKET_ADDRESS` and `INDEXER_START_BLOCK`.

## Commands

Run from the repository root:

```sh
npm run indexer -- backfill            # index every confirmed block up to head - INDEXER_CONFIRMATIONS
npm run indexer -- backfill --rebuild  # rebuild everything from contract events and reconcile Arkiv
npm run indexer -- backfill --dry-run  # same, against an in-memory store (no Arkiv writes)
npm run indexer -- watch               # poll, index, renew every 6 h; retries with backoff
npm run indexer -- renew               # extend entities expiring within 30 days; recreate expired ones
npm run indexer -- status              # saved checkpoint

npm run indexer -- listings --writer 0xWRITER --genre fantasy --language en --min-price 0 --max-price 10000000000000000
npm run indexer -- trades --writer 0xWRITER [--publication 1]
```

`listings` and `trades` are read-only and work without any key.

## How it works

- **Confirmations:** only blocks at least `INDEXER_CONFIRMATIONS` deep (default 12) are indexed.
- **Reorgs:** the checkpoint stores the last indexed block's hash. If the chain no longer has it, the indexer rebuilds the projection from contract events and reconciles Arkiv:
  - entities that are missing are created
  - entities that changed are patched
  - entities whose events were reorganized away are deleted
- **Idempotent writes:** listings are identified by `listingId = keccak256(chainId, contract, publicationId)` and trades by `tradeId = keccak256(chainId, contract, txHash, logIndex)`. Before creating, the indexer searches Arkiv for that id among entities it owns, because Arkiv assigns entity keys itself. Reruns, duplicate log deliveries and a lost state file don't create duplicates.
- **Checkpoint and retries:** the checkpoint (`indexer/.state/<chain>-<contract>.json`) advances only after every write in a range succeeded. Writes retry with exponential backoff, and a failed run resumes from the same range.
- **Metadata:**
  1. The public preview manifest is fetched from Arweave.
  2. It is checked against `previewManifestHash` (keccak256 of the exact bytes) **before** it's parsed.
  3. On mismatch, invalid content or a fetch failure, the listing's `metadataStatus` is `unavailable`, and no title, genre, language or preview is written.

  Fetch failures are retried with backoff; mismatches are permanent.
- **Never written:**
  - decryption keys and page content
  - appeal evidence and review rationale
  - the encrypted bundle's Arweave ID
- **Expiry:** entities live 180 days (Arkiv's maximum is about 182). `renew` extends active listings and all trades that are within 30 days of expiry, and recreates any that already expired. Rejected listings are left to expire.

## Tests

```sh
npm run indexer:test        # recorded-event tests (no network)
npm run indexer:test:live   # live Arkiv: reads always; one write if ARKIV_PRIVATE_KEY is set
npm run contracts:record-indexer-fixture   # re-record test/fixtures/market-events.json from the real contract
```

The fixture holds real logs emitted by ConsentCraftMarket on Hardhat's in-process chain. Its Arweave IDs and manifests are labeled test fixtures. The tests cover:
- projection and replay
- confirmation depth
- duplicate logs and reruns
- lost state
- hash mismatch, a tampered gateway and fetch retries
- two reorg shapes
- transient and persistent write failures
- rebuild with damaged and spoofed entities
- renewal and recreation after expiry
- query construction
