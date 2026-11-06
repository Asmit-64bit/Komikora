# Why Arkiv

## What the design relies on (from the SDK and our tests)

- **Queryable public index:** listings need filtering by genre, language, author, price range and status. Arkiv supports indexed typed attributes (`str`, `addr`, `u64`, `u256`, `key`), with `eq`, range and `between` predicates, sorting and cursor paging. Our search runs as one query.
- **Kept apart from money:** the settlement contract stays minimal and authoritative on Sepolia. Display metadata and the trade feed live on a separate data chain, so marketplace search never touches the payment contract.
- **Verifiable and public:** the entities only hold data that is already public or derivable from contract events and verified Arweave manifests. Anyone can check that the index matches the chain.
- **Expiry matches the use:** listing and trade rows are a cache of contract state, so a bounded lifetime with renewal suits them. Losing a row never loses ownership.
- **Owner-scoped trust:** `ownedBy(writer)` gives readers a simple rule for which rows to trust.

## TODO (team)

- [ ] Why Arkiv rather than a self-hosted database or a subgraph, in the team's own words
- [ ] Hackathon or prize context, if relevant
- [ ] What the team would need from Arkiv to use it in production
