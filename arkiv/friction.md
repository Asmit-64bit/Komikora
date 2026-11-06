# Friction log

Real issues met while building the ConsentCraft Arkiv indexer on 2026-11-06, with `@arkiv-network/sdk` 1.0.1 and the Rabdi testnet. Each entry says what happened and what we did.

| # | What happened | Impact | What we did |
| --- | --- | --- | --- |
| 1 | A query with no filter threw `InvalidPredicateError: A query needs at least one filter — the language has no spelling for 'match every entity'` | A "list everything" probe failed | Every query filters on the schema tag and owner. Our probe used `exists("arkiv.schema")`. |
| 2 | Entity keys are minted by the chain as `keccak256(chainId ++ registry ++ owner ++ nonce ++ salt)`; the caller can't choose a key | No natural idempotency for "one entity per event" | We store our own `listingId` / `tradeId` as an indexed `key` attribute and search before creating. This leaves a race if two writers run at once, so we run a single writer. |
| 3 | `str` attributes are limited to 128 bytes; schema and attribute names to 32 bytes | Comic titles can exceed 128 bytes | Titles are truncated at a character boundary with "…", and a `titleTruncated` flag is kept in indexer state |
| 4 | An entity can live at most 7,884,000 blocks (~182.5 days) | Index rows disappear unless renewed | 180-day lifetime plus a `renew` command that extends entities within 30 days of expiry and recreates expired ones |
| 5 | The public RPC works without a key but is "heavily rate limited" (SDK warning); the access key goes into the RPC URL path (`…/rpc.rabdi…/<key>`) | The key can end up in URLs and logs | We keep the key in `indexer/.env` (git-ignored) and never log RPC URLs. An unofficial troubleshooting page suggests header-based keys; we didn't find that in the official docs. |
| 6 | Anyone can write entities with our schema tag | Readers could be fed spoofed listings | Every read helper adds `ownedBy(writer)`. A test checks that a foreign-owned look-alike is ignored. |
| 7 | The docs landing page (docs.arkiv.network) lists the network, faucet and access-key links but no SDK package name or version. The SDK README's install example shows `"^0.9.0"`, while npm gave us 1.0.1. | Minor confusion when pinning versions | Pinned 1.0.1 from the lockfile |
| 8 | Schema-typed `where()` rejects a dynamically built `Expression[]` at compile time | Optional search filters don't typecheck without a cast | One `as never` cast; the SDK still checks predicates against the schema at runtime |
| 9 | Writes need test tGLM from the faucet and an access key from the hub, both obtained in a browser | We couldn't do a real write from this environment | **TODO (team):** record how long faucet and access-key setup took, and any problems |

**TODO (team):** add friction from the first real writes, renewals and frontend use (latency, gas in tGLM per create, rate-limit hits).
