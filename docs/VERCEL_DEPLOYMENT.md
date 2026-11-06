# Vercel deployment

The studio requires persistent PostgreSQL on Vercel. NFT ownership and payments remain in Solidity; PostgreSQL holds wallet challenges, sessions, drafts, review records and wrapped content keys. The local JSON store is retained for local development and persistent single-process servers.

## Production settings

Connect a hosted PostgreSQL database to the Vercel project. Use its pooled connection URL where available. Set these variables for Production and redeploy:

```dotenv
APP_ORIGIN=https://creato-phi.vercel.app
NEXT_PUBLIC_APP_URL=https://creato-phi.vercel.app
STUDIO_STORAGE=postgres
STUDIO_DATABASE_URL=<hosted PostgreSQL connection URL>
CONSENTCRAFT_DATA_NAMESPACE=studio
```

`DATABASE_URL` and `POSTGRES_URL` are accepted alternatives when `STUDIO_DATABASE_URL` is absent. A localhost database URL will not connect from Vercel. Database credentials must remain server-only. Keep the namespace and `CONTENT_KEY_ENCRYPTION_KEY` stable across deployments, and back up the database and encryption key securely.

The database role needs permission to create `consentcraft_studio_state` initially and read/write its rows. Mutations take a PostgreSQL row lock and commit atomically, so parallel function instances cannot overwrite each other's sessions or drafts. The table stores one JSONB document per namespace; this is an MVP storage adapter, not a normalized large-scale database design. Existing local `.data` files are preserved and are not automatically imported into PostgreSQL.

When copied origin settings still point to localhost, Vercel's trusted system metadata supplies the production origin or preview deployment origin. Explicit custom domains remain authoritative. Enable system environment variables for this fallback, or set the explicit origins above. Incoming Host headers never determine a production sign-in domain. [Vercel system variables](https://vercel.com/docs/environment-variables/system-environment-variables)

Vercel refuses file storage and reports a clear 503 if persistent storage is missing or unavailable. It never falls back to `/tmp`, which would lose sessions and content keys. [Vercel filesystem behavior](https://vercel.com/docs/functions/runtimes)

## Verify after redeployment

1. Open `/network` and check “Studio sessions and data.” Run connection checks.
2. `GET /api/studio` should return 200 and an anonymous user before login.
3. Connect a wallet and sign the session message. Confirm the message names the public domain.
4. Refresh and sign out/in; create and save a small draft. Verify it survives a redeployment.
5. Test a rejected signature and retry. A different origin must still be rejected.

Local verification can use the existing PostgreSQL container: set `STUDIO_STORAGE=postgres` for the browser test process and run `npm run test:e2e`. Set `TEST_STUDIO_DATABASE_URL` to a test database to enable `tests/integration/postgres-store.test.ts`; it checks independent instances, concurrent writes, rollback and read-only callbacks in an isolated namespace.

The wallet's phishing classification is managed by its security provider. The sign-in origin/storage fixes do not clear that classification. Obtain the wallet's specific finding and request a review through its official support flow if appropriate. Do not disable or bypass wallet security checks to demonstrate the app.

## Investigate a wallet security warning

The “Continue at your own risk” phishing/wallet-draining warning is a wallet security decision. The screenshot alone does not identify the flagged URL, provider, or cause, and a false positive has not been established. Session persistence failures and origin errors are separate application failures.

The connector supplies ConsentCraft's description and `/icon.svg` with the browser's actual origin, including previews. RainbowKit already defaults the connection URL to that origin; explicit metadata is an identity improvement, not a removal of a malicious-site classification. Never substitute another domain to evade a warning.

1. Record the exact URL, wallet name/version, network, warning details and whether it appears during connection, session signing or a transaction.
2. Confirm that the deployed build matches the reviewed source. Check the sign-in message's domain and URI against the address bar. Login should request `personal_sign` for the server's SIWE message, with no payment, typed-data allowance or NFT approval. Purchases, bids and publishing are separate wallet transactions.
3. For MetaMask, use the alert's reporting option when available, or contact official support for a classification review. Include the affected URL, screenshot, network, repository and reproduction steps. [MetaMask security alerts and reporting instructions](https://support.metamask.io/configure/wallet/security-alerts/)
4. If connecting through WalletConnect, check the project's domain configuration in Reown. Domain verification and a malicious-domain finding are distinct; verification alone does not clear a threat finding. [Reown Verify API](https://reown.com/blog/what-is-verify-api)

`tests/e2e/wallet-auth.spec.ts` records attempted wallet methods during rejected and successful session signing, checks the SIWE domain/URI, and rejects transaction or alternate-signing requests in that flow. Its injected test wallet does not reproduce a real wallet's reputation service, WalletConnect classification or the deployed site's security status.

### Observed deployment on 6 November 2026

The reported wallet is MetaMask and the affected URL is `https://creato-phi.vercel.app/`. The screenshot's exact warning text matches MetaMask's `trustSignalPhishingWarning` message in its [English localization source](https://github.com/MetaMask/metamask-extension/blob/main/app/_locales/en/messages.json). A read of MetaMask's [public phishing configuration](https://github.com/MetaMask/eth-phishing-detect/blob/main/src/config.json) found no exact entry for `creato-phi.vercel.app` or its parent `vercel.app` in the blacklist, whitelist or fuzzylist. This does not rule out other security signals, provider classifications or a stale wallet response.

The homepage returned HTTP 200, while `GET /api/studio` returned HTTP 500 with `{"error":"Something went wrong. Please try again."}`. The public response does not disclose the underlying error; check Vercel function logs and the storage settings above. The local PostgreSQL/origin changes must be deployed and verified independently of the MetaMask review.

Suggested review request, to submit through MetaMask's official reporting/support flow:

> Please investigate the phishing/wallet-draining classification for https://creato-phi.vercel.app/. MetaMask shows “Continue at your own risk” while connecting. The project is ConsentCraft, a comic NFT marketplace; source: https://github.com/Asmit-64bit/eth. Its reviewed local sign-in flow requests a domain-bound ERC-4361 session signature and does not request a transaction or asset approval. Local browser checks cover rejected signatures, retries and the requested wallet methods. We have not established the classification's cause or confirmed parity of the deployed build with local source. Please identify the finding and any remediation needed. We can provide the warning screenshot, wallet version and reproduction details.

No classification review has been submitted by the local code changes.
