# Similarity scanning in collaborative publishing

The scanner from the `originality` branch now runs in the active `ConsentCraftReading` workflow. Every collaborator must approve the saved version before similarity or curator inference is requested. The fixed-price, multi-reader model remains active.

## Scan sequence

1. Check for blank or single-colour pages locally before upload or paid inference.
2. Read every confirmed comic in the configured reading contract at a pinned block. The catalogue fingerprint includes chain, contract, comic keys and manifest hashes, so a same-count reorganization also invalidates cached results.
3. Use private 0G inference to summarize the new comic. Prior comics are summarized from decrypted, hash-verified pages using server-only wrapped keys. Hash-bound synopsis caches stay private in the studio database.
4. Compare against batches of up to 20 prior synopses. Every supplied comic ID must have exactly one valid result. Missing/duplicate/unknown IDs fail closed, as does unavailable prior content or keys for a new scan.
5. Similarity **above 85%** blocks upload and publication; exactly 85% remains allowed. The team can inspect the synopsis, highest score and comparison explanations in Review & publish. Reopening for corrections resets collaborator approvals.
6. Recheck the catalogue before signing a publication permit. Refresh stale scans and regenerate metadata when findings change. The permit binds the new metadata hash. Public findings omit the private plot synopsis.

## Cost and concurrency

Each owner wallet has five new scan attempts per rolling 24 hours, including failed and rejected attempts. A durable database reservation records the attempt before inference; a separate durable lease serializes scans of the same project across function instances.

Completed results are reused when approved content, model, prompt version and catalogue match. Repeated requests for a blocked unchanged comic do not spend inference or quota again. Verified source synopses are reused when the catalogue grows. Failed inference counts toward the limit, even if an intermediate synopsis was saved for retry. The existing curator submission quota remains separate.

## Scope and limits

Only confirmed comics in the current reading contract are compared. The scanner does not search external websites, earlier edition contracts or unpublished drafts. It estimates narrative/visual similarity through model-generated synopses and does not establish copying, copyright, authorship or legal permission. Model mistakes and synopsis omissions remain possible.

The server signer and 0G gateway remain trusted. The existing contract does not independently run AI. Already-issued permits cannot be retroactively revoked by the backend; concurrent permits can use the same confirmed catalogue snapshot during their validity window. This port does not replace the contract or rotate encryption keys.

Caches avoid repeated vision inference on unchanged source pages, but catalogue reads and text comparisons still grow with the number of published comics. Larger catalogues may require a durable queue and retrieval/indexing strategy beyond the pilot.

## Verification

`tests/unit/originality.test.ts` covers catalogue coverage, caching, failed/rejected scan quotas, same-count fingerprint changes, missing data, malformed comparison IDs, concurrent leases and public/private findings. Reading service tests cover the threshold, blank-page ordering, regenerated metadata and collaborator enforcement. Browser coverage uses an explicitly mocked result for blocked-publication and responsive-findings checks. `test:reading` uses labeled synthetic review/similarity fixtures to verify the real contract, wallet approvals, purchases and encrypted reader without paid inference.
