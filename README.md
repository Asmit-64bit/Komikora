# ConsentCraft

The development environment includes the ConsentCraft UI and basic studio backend, adapted from [Asmit-64bit/consentcraft](https://github.com/Asmit-64bit/consentcraft) at commit `97057e02ddcce17035398917f73860cc64656f21`. It preserves the reference styling and layouts, plus its file-backed account, project, invitation, and image-validation flows.

Choose **Connect wallet**, select your wallet in RainbowKit, and choose **Sign message**. Approve the sign-in message to open your studio; the first verified sign-in creates your account. Start a project, upload artwork, and save your draft. New wallets start with an empty workspace. Saved changes survive page reloads and server restarts. Owners manage titles, credits, shares, terms, and invitations; accepted collaborators can edit panels and captions. Invitations are addressed to a wallet and can also be shared as links.

Authentication is wallet-only. Email/password forms and login endpoints are disabled. The backend does not implement the reference repository's NFT economics or send email.

The **ConsentCraftMarket contract** (publishing, purchases, review, refunds, withdrawals) is implemented and tested but not yet deployed: see [contracts/README.md](contracts/README.md). The **Arkiv indexer** that projects its events into a public marketplace index is in [indexer/](indexer/README.md). The UI does not call the contract or the Arkiv index yet; AI review and World ID remain unconnected.

## Prerequisites

- Node.js 24.16.x (see `.nvmrc`) and npm 11.x.
- Docker Desktop with the Linux container engine for local PostgreSQL and storage.
- Run commands from this repository's root.

## Start locally

On Windows, this repository path contains an ampersand. Native dependency lifecycle checks mis-handle that path. Install without lifecycle scripts, then validate the provided binaries with the checks below:

```powershell
npm ci --ignore-scripts
npm run env:setup
npm run services:up
npm run services:init
npm run dev
```

On macOS/Linux, use plain `npm ci` for the first command.
Project scripts invoke the Node entry points directly so they also work from this
Windows path. A scoped override gives the older wallet connector's Valtio dependency
the React 19-compatible `use-sync-external-store` 1.4 shim.
Open http://localhost:3000. The basic studio needs only `npm run dev`; Docker and external credentials are optional for later integrations.
`env:setup` creates an ignored `.env.local`, generates a random session secret for future integrations, and preserves an existing file. The basic backend uses random opaque sessions and does not consume `SESSION_SECRET`, SQL, or S3 credentials.

Run `npm run contracts:node` in another terminal when a local EVM is needed. The chain listens on 127.0.0.1:8545 with chain ID 31337 and disposable test accounts. Sepolia deployment commands and their environment (`contracts/.env.example`) are documented in [contracts/README.md](contracts/README.md).

## Arkiv index (marketplace and trade feed)

The [indexer](indexer/README.md) projects confirmed ConsentCraftMarket events into public Arkiv entities on the **Rabdi testnet** (chain 7794095, explorer <https://rabdi.explorer.arkiv.network>). Entity design: [arkiv/schema.md](arkiv/schema.md). The contract stays the authority for payments and reading access; Arkiv is only an index.

| Entity-writing wallet | Network |
| --- | --- |
| **TODO:** not created yet; set `ARKIV_PRIVATE_KEY` and record the address here | Arkiv Rabdi testnet |

**Query for judges.** Read-only, no key needed:

```sh
npm run indexer -- listings --writer <WRITER_ADDRESS> --listing any --unverified
npm run indexer -- trades --writer <WRITER_ADDRESS>
```

The same listing query as raw JSON-RPC:

```sh
curl -s -X POST -H 'content-type: application/json' https://rpc.rabdi.db-chain.testnet.arkiv.network --data \
  '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str('"'"'consentcraft.listing.v1'"'"') AND $owner = addr(<WRITER_ADDRESS>)",{"select":{"key":true,"expiresAt":true,"attributes":true},"limit":"0x14"}]}'
```

No entities have been written yet. Both commands currently return empty results.

## Tooling

| Area | Setup |
| --- | --- |
| Web | Existing Next.js 16.4.5, React 19.3.0, TypeScript, Tailwind CSS 4 |
| UI | shadcn CLI configuration and utility, Lucide, class/animation dependencies |
| Validation/forms | Zod, React Hook Form, resolvers |
| Client data/wallets | TanStack Query, wagmi 2, viem 2, RainbowKit 2 |
| Personhood/catalog | World ID 4 IDKit and Arkiv TypeScript SDK |
| AI | OpenAI-compatible client for the 0G Router; no inference calls made |
| Private state/jobs | PostgreSQL 17, pg, pg-boss; no application tables or jobs yet |
| Private media | Local SeaweedFS, S3 client and presigner; private bucket initialization |
| Contracts | Separate ESM npm workspace, Hardhat 3, viem toolbox, OpenZeppelin |
| Tests | Backend integration suite and Playwright account/collaboration flow; Vitest available for future unit tests |

The copied UI uses the reference plain CSS and Arial font. Its CSS is processed natively by Next.js; the unused custom Tailwind CSS loader has been removed. shadcn tooling remains available for future components. The contract workspace is excluded from the web TypeScript build and checked separately. Dependency versions are recorded in `package-lock.json`.

## Basic backend

The Node route at `/api/studio` stores accounts, sessions, projects, embedded panel images, invitations, and activity in `.data/studio/studio.json`. This directory is ignored by Git. `CONSENTCRAFT_DATA_NAMESPACE` selects another directory under `.data`; only letters, digits, hyphens, and underscores are allowed. Back up this directory to preserve local accounts and artwork.

| Request | Behavior |
| --- | --- |
| `GET /api/studio` | Current account, its team projects, and incoming invitations; public library is empty until publishing is implemented |
| `GET /api/studio?invitations=<project-id>` | Pending invitations, visible only to the project owner |
| `POST`, action `challenge` | Create a five-minute, browser-bound SIWE message for an `address` and `chainId` |
| `POST`, action `siwe` | Verify the exact `message` and wallet `signature`, then issue a seven-day session |
| `POST`, action `logout` | Revoke the session and pending sign-in challenge |
| `POST`, action `create`, `save` | Private drafts with four panels, credits, terms, and activity |
| `POST`, action `invite`, `cancelInvite`, `accept` | Owner-created invitations bound to an Ethereum `address`, expiring after seven days and accepted once |

POST requests require JSON and a matching browser `Origin`. The server creates an [ERC-4361 Sign-In with Ethereum](https://eips.ethereum.org/EIPS/eip-4361) message containing the site, address, chain, nonce, issued time, and expiration. It verifies the signature with Viem against the exact stored message and the browser's HTTP-only challenge cookie. Each challenge is consumed on the first verification attempt, including failed signatures. Connecting or supplying an address alone never authenticates a user.

Session and challenge cookies are HTTP-only, SameSite Strict, and Secure on HTTPS. Responses are never cached. Wallet switching or disconnecting clears the active studio session; signing out also disconnects the wallet connector. A returning wallet resolves to the same account. No private key is requested or stored, and sign-in submits no transaction. RainbowKit supplies wallet selection, signature verification screens, and the account menu. Installed EIP-6963 wallets and the standard injected Ethereum provider work without a WalletConnect project ID, including a wallet's mobile browser. Setting `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` enables Rainbow, MetaMask, and WalletConnect QR connectors. This implementation verifies regular externally owned Ethereum accounts locally; smart-contract wallet signatures are not implemented.

The Next.js configuration externalizes the transitive `@coinbase/cdp-sdk` on the server. This preserves its lazy optional payment imports without requiring unrelated x402 packages for RainbowKit's connector bundle.

Legacy email-only accounts, drafts, and invitations are retained on disk for recovery. Old sessions are rejected, and new wallets cannot claim an email account or its drafts. Any deliberate migration of legacy drafts must be handled separately with verified ownership; there is no automatic linking.

Saves require the current `revision`; competing saves return HTTP 409 rather than overwrite another contributor's work. The editor keeps unsaved text after a conflict until the user chooses **Reload latest**.

Uploads are fully decoded on the server with Sharp, checked as PNG/JPEG under 20 megapixels, resized to at most 1400 pixels, and re-encoded without metadata. Draft saves validate the full payload before an atomic file replacement. Owners' shares must total 100%; zero shares are allowed while a draft is being assembled.

This is the reference's local, single-process storage model. Run only one server per data namespace; multiple instances and serverless deployment require a database-backed store. Active sign-in challenges are bounded, but deployment-level rate limiting is not implemented. PostgreSQL/S3 adapters remain separate integration work.

## Local services

| Service | Address |
| --- | --- |
| PostgreSQL | 127.0.0.1:15432, database/user `consentcraft` |
| SeaweedFS S3 | http://127.0.0.1:9000 |

Local credentials are documented in `.env.example`; they are development-only. `services:init` checks SQL connectivity and creates the private S3 bucket if missing. No public bucket policy is applied. Encryption and access control are future implementation work.

```sh
npm run services:status
npm run services:down
```

Stopping services preserves their named Docker volumes. Keep database connection strings and S3 settings synchronized when changing credentials. Changing PostgreSQL environment values does not rotate passwords in an initialized volume. SeaweedFS is pinned as local S3-compatible storage; production storage and key management remain separate deployment decisions.

## External integration settings

Fill only the relevant blank values in `.env.local` when integration work begins:

- WalletConnect: set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` to a valid project ID and restart the dev server (or rebuild production) to enable QR connections. Browser wallet sign-in needs no project ID.
- World ID: registered app ID, RP ID, server signing key, and chosen action/proof flow.
- Arkiv: selected network RPC URL and chain ID. Signing and entity renewal need implementation.
- 0G Router: API base URL, API key, and a model verified to accept actual page images.
- Sepolia: RPC URL, and `NEXT_PUBLIC_MARKETPLACE_ADDRESS` after `npm run contracts:deploy:sepolia`. Contract deployment settings live separately in `contracts/.env`.

Only variables prefixed `NEXT_PUBLIC_` may enter browser bundles. Keep service keys, session secrets and database credentials server-side. Configure public RPC URLs specifically for browser use. No service balances, accounts, purchases, proofs, or deployments are created by setup.

Official references: [World ID](https://docs.world.org/world-id/idkit/integrate), [Arkiv SDK](https://github.com/Arkiv-Network/arkiv-sdk-js), [0G Router](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/overview), [Hardhat configuration](https://hardhat.org/docs/reference/configuration).

## Verification commands

```sh
npm run check
npm run build
npm run test:backend
npm run test:e2e
npm run contracts:compile
```

`contracts:compile` builds ConsentCraftMarket with solc 0.8.28 (optimizer on) and downloads the compiler as needed.

The backend and browser suites require a successful production build. Both use isolated data namespaces and do not change the normal studio. The backend suite uses ephemeral wallets and real signatures to check message tampering, origin/browser binding, nonce reuse, expiry, old-login rejection, legacy data preservation, access control, invitations, uploads, concurrent edits, and restart persistence. Playwright injects a test EIP-1193/EIP-6963 provider that signs with ephemeral test-runner keys; the real API still verifies every signature. It checks signature rejection/retry, missing wallets, account switching/disconnection, saved artwork, invitation acceptance/cancellation, collaboration permissions, stale-save recovery, and mobile sign-out/sign-in.

Additional test tooling:

```sh
npm test
npm run test:watch
npm run test:e2e:install
npm run test:e2e
npm run contracts:test
```

Put unit tests in `tests/unit`, integration tests in `tests/integration`, browser tests in `tests/e2e`, Solidity sources in `contracts/contracts`, and contract tests in `contracts/test`. Vitest has no unit tests yet; use `test:backend` for the API suite. Playwright starts an isolated production server on port 3100 and leaves its ignored `.data/e2e-*` namespace available for debugging. The interface uses system fonts and bundled SVG artwork, so it does not require remote font or image downloads.

## Verified setup

Lint, web, contract and indexer TypeScript checks, the production build, the backend integration suite,
and the Playwright collaboration flow pass. The contract suite (unit, fuzz and invariant tests) and the
indexer suite pass, and a local contract deploy and smoke run succeeded.
Vitest and Playwright load their configurations, and Chromium successfully opened the
UI with HTTP 200. PostgreSQL connectivity and S3 write/read/delete were verified;
anonymous S3 object access returned HTTP 403. The local service containers are running.

External World ID, Arkiv, and 0G integrations remain unconnected in the UI.
Those services and real WalletConnect QR connections have not been exercised. `npm run dev` starts the app;
`npm run services:down` stops the local services while preserving data.
