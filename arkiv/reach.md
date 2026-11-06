# Reach

## What is public today (verified)

| Item | Status |
| --- | --- |
| Network | Arkiv Rabdi testnet, chain 7794095, confirmed via `eth_chainId` on 2026-11-06 |
| Who can read | Anyone, with the SDK or raw `arkiv_query` JSON-RPC, no key needed (rate limited). Example in the root README. |
| Entities written by ConsentCraft | **0** so far. The writer wallet isn't configured and the market isn't deployed on Sepolia yet. |
| Live query check | The node accepted our listing search (all filters, including a u256 price range) and the trade feed, returning 0 rows |

## TODO (team)

- [ ] Writer address and entity counts (listings, trades) after the first real backfill
- [ ] Number of comics, authors and buyers in the demo
- [ ] Who consumes the index: frontend pages, judges, other teams
- [ ] Any external use of the public listing or trade data
