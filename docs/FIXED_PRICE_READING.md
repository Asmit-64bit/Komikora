# Collaborative publication and fixed-price reading

The active studio publishes to `ConsentCraftReading`. It uses one fixed price per comic and unlimited distinct purchasing wallets. Each wallet purchases once and keeps non-transferable reading access. Another buyer does not displace an existing reader. There is no edition-supply setting, auction, bid, resale, or swap in the active interface.

## Team approval

1. The owner saves all pages, title, description, reading license, price, collaborators and shares. Accepted collaborators must each have a wallet. Shares total 100%; even a collaborator with 0% must approve. Pending invitations must be accepted or cancelled.
2. Starting team review freezes the saved content and roster. Every collaborator, including the owner, reviews the saved pages, price, license and revenue split and signs an EIP-712 `TeamApproval`. This signature authorizes publication of that exact version and carries no payment or token allowance.
3. Only after every signature is recorded can the owner submit to the private curator. The server verifies the content fingerprint and each signature before spending upload or inference resources. A database-backed job lease prevents concurrent submissions across instances. New submissions retain the five-per-owner-wallet daily limit; retries reuse saved encrypted uploads.
4. After curator approval, the owner requests a short-lived reviewer permit and confirms `publishComic` in their wallet. The contract itself checks every collaborator signature, not just a backend approval count. It binds the comic key, plaintext content fingerprint, encrypted manifest, metadata, license, price, contributor wallets, shares, deployment and chain. The reviewer permit expires after ten minutes; team approvals expire after seven days.
5. Reopening before publication clears every approval and creates a fresh key on the next review. Publication permits already issued must expire on chain before reopening. A collaborator can invalidate even an issued permit with the contract's `revokeApproval` transaction. The server confirms that transaction before removing the saved approval; a new review is then required.

AI review is advisory and cannot establish authorship or copyright. A flagged review issues no publication permit. The owner may reopen it for corrections and collect new approvals. No automatic or mock approval substitutes for team or curator checks.

After unanimous approval, a [similarity scan](ORIGINALITY.md) compares the saved comic with every confirmed comic in the current reading contract before upload. Similarity above 85% blocks publication. Results are cached against approved content and a verified catalogue fingerprint. Failed/rejected new scans consume the separate scan budget; publication permits require current findings, and metadata is regenerated after changed results.

## Reading and proceeds

`buyReading(comicId)` requires the exact approved price. Each successful purchase records a permanent wallet entitlement; all collaborators can also read their own publication. A 2.5% platform fee is credited to the existing project treasury. The remaining proceeds are allocated to the approved collaborator wallets. Integer-division dust goes to the first contributor (the owner); the sum of all credits always equals the purchase amount. Every recipient withdraws their own credit; no untrusted recipient is called during a purchase.

The reader requires a signed-in wallet with confirmed on-chain access before fetching or decrypting pages. Content keys remain in private PostgreSQL storage, wrapped with the existing stable encryption key. Public storage contains encrypted full pages, a small public cover, and public listing metadata. The Library finds a wallet's purchase events and contributions, then verifies entitlement on chain. Delisting blocks new purchases but preserves existing reading access.

## Deployment and compatibility

Set `NEXT_PUBLIC_READING_ADDRESS` and `READING_START_BLOCK`, together with the existing Sepolia chain/RPC settings and server reviewer key. Public variables require a rebuild. The reading contract uses the existing project reviewer and treasury; existing database records, encryption keys and old contract deployments are preserved. Unminted earlier NFT submissions can be reopened before entering the new workflow. Already-published contracts are immutable; their historical obligations and reader endpoints remain available.

The canonical public deployment manifest is `contracts/deployments/reading-sepolia.json`. `reading:abi` regenerates the ABI, `reading:deploy:sepolia` deploys after a `DEPLOY_PREFLIGHT=1` estimate, and `test:reading` runs the real local-chain/SIWE/purchase/reader integration with synthetic approved-review and encrypted-storage fixtures. It does not spend paid inference credits or create public storage items.

Validation covers missing approvals (including zero-share members), tampered prices/content/license/splits, wrong callers and deployments, expired approvals, on-chain withdrawal, duplicate/wrong-value purchases, multiple independent readers, preserved access after later purchases/delisting, revenue accounting, server authorization, concurrent curator jobs, stale signatures, and permit/reopening races.
