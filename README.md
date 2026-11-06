# ConsentCraft

Vercel deployments require persistent PostgreSQL for wallet sessions and drafts. See [Vercel configuration and verification](docs/VERCEL_DEPLOYMENT.md). Local development keeps its existing file store unless `STUDIO_STORAGE=postgres` is selected.

The NFT MVP now lives at **Marketplace** (`/marketplace`) and **Trade** (`/trade`): fixed-supply ERC-721 editions, per-edition first-sale auctions, secondary asks/auctions, comic swaps with exact ETH top-ups, and reading access that follows confirmed ownership. New publishing uses a rights declaration, wallet confirmation, encrypted Arweave content and 0G review, with no legacy publishing deposit. See [NFT rules, deployment, tests and remaining launch work](docs/NFT_MVP.md).

The existing paid-reading contract and APIs documented below are retained for legacy records. Their permanent reading entitlements do not grant access to NFT editions. New NFT publications use `ConsentCraftEditions`.

The NFT path includes private 0G image scoring and reading recommendations, wallet-authorized publishing, linked edition detail pages, and a Network service-status page. Scoring requires private routing and gateway-reported provider checks; it never falls back to standard inference. The live generated-image private scoring test passed. Funded Arweave upload and public NFT deployment still require operator configuration; these are shown explicitly in the UI. See [current setup and verification limits](docs/NFT_MVP.md).

The development environment includes the ConsentCraft UI and basic studio backend, adapted from [Asmit-64bit/consentcraft](https://github.com/Asmit-64bit/consentcraft) at commit `97057e02ddcce17035398917f73860cc64656f21`. It preserves the reference styling and layouts, plus its file-backed account, project, invitation, and image-validation flows.

Choose **Connect wallet**, select your wallet in RainbowKit, and choose **Sign message**. Approve the sign-in message to open your studio; the first verified sign-in creates your account. Start a project, upload artwork, and save your draft. New wallets start with an empty workspace. Saved changes survive page reloads and server restarts. Owners manage titles, credits, shares, terms, and invitations; accepted collaborators can edit panels and captions. Invitations are addressed to a wallet and can also be shared as links.

Authentication is wallet-only. Email/password forms and login endpoints are disabled. The backend does not implement the reference repository's NFT economics or send email.

## How the dApp works

Money, ownership and reading access live in the **ConsentCraftMarket** contract ([contracts/README.md](contracts/README.md)). Every money-moving action is a transaction sent from the user's own wallet. The server never holds user funds.

| Step | Who | What happens |
| --- | --- | --- |
| Sign in | Every account | A domain-bound wallet signature authenticates the session. Accounts represent wallets; no external identity provider is required. |
| Publish | Author's wallet | The server encrypts every panel and caption (AES-256-GCM) and uploads the ciphertext to **Arweave**, plus a small public cover and preview manifest. It reads each upload back, checks its hash, and signs a quote. The author's wallet calls `createPublication` with the deposit. |
| AI review | Server, on **0G Compute** | The server fetches the exact Arweave bundle the contract fingerprints, decrypts it and sends downscaled pages to a TEE-verified 0G vision model. The response's TEE signature must verify. The AI cost is the real token bill (`tokens × provider's on-chain price`, converted to ETH and capped at `aiCap`). A relayer submits the signed report. On any failure nothing is signed and the deposit stays locked and safe. |
| List | Author's wallet | `publish` puts an approved comic on sale. A flagged comic can be appealed: the evidence stays private and only its salted hash goes on chain. Reviewers resolve appeals from the **Admin** page. |
| Buy and read | Buyer's wallet | `purchase` pays the author (minus the platform fee) and records reading access. The server decrypts pages only for wallets where `hasReadingAccess` is true at a confirmed block, or for the author. |
| Refund | Author's wallet | After the refund delay, `refundAndDelist` returns `deposit − max(sales, AI cost, deposit/4)`. **The AI cost is always deducted.** The UI passes the exact `previewSettlement` refund as `minRefund`, so a last-second purchase can't silently shrink it. |
| Withdraw | Anyone with credits | `withdraw` pays out sale proceeds and refunds. |

Pages: **Marketplace** (on-chain listings with Arweave previews), a comic page (buy or read), **Review & publish** inside each project, **Earnings** (credits, withdraw, purchases), **Admin** (roles checked on chain: appeals, pause, contract health) and **Network** (which integrations this server has configured). The **Arkiv indexer** that projects contract events into a public index is in [indexer/](indexer/README.md).

Collaborator shares are recorded in the studio but are not enforced on chain: the contract pays the project owner's wallet.

### Run it against a local chain

```sh
npm run contracts:node                 # terminal 1: Hardhat chain on 127.0.0.1:8545
npm run contracts:deploy:local         # terminal 2: prints the market address
```

Put these in `.env.local` (created by `npm run env:setup`), then run `npm run dev`. Hardhat accounts 3 and 4 hold the quote-signer and reporter roles; their keys are Hardhat's public development keys and must never be used on a real network.

```sh
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_MARKETPLACE_ADDRESS=<printed address>
CHAIN_RPC_URL=http://127.0.0.1:8545
QUOTE_SIGNER_PRIVATE_KEY=<QUOTE_SIGNER_PRIVATE_KEY from contracts/local-node.env>
REPORTER_PRIVATE_KEY=<REPORTER_PRIVATE_KEY from contracts/local-node.env>
RELAYER_PRIVATE_KEY=<any funded Hardhat key>
ARWEAVE_UPLOAD_PRIVATE_KEY=<any new key; the ar.io sandbox is free up to 5 MiB per item>
```

0G needs a funded compute account (see `.env.example`). Without it, inference reports "not configured" instead of pretending to succeed. `npm run zg -- providers` lists live 0G providers and prices.

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
| Catalog | Arkiv TypeScript SDK |
| AI | 0G Private Computer image review and reading suggestions; private routing and gateway-reported checks |
| Private state/jobs | PostgreSQL 17, pg, pg-boss; no application tables or jobs yet |
| Private media | Local SeaweedFS, S3 client and presigner; private bucket initialization |
| Contracts | Separate ESM npm workspace, Hardhat 3, viem toolbox, OpenZeppelin |
| Tests | Vitest security/review unit tests, real-chain reader integration and Playwright wallet/collaboration/navigation checks |

The copied UI uses the reference plain CSS and Arial font. Its CSS is processed natively by Next.js; the unused custom Tailwind CSS loader has been removed. shadcn tooling remains available for future components. The contract workspace is excluded from the web TypeScript build and checked separately. Dependency versions are recorded in `package-lock.json`.

## Basic backend

The Node route at `/api/studio` stores accounts, sessions, projects, embedded panel images, invitations, and activity in `.data/studio/studio.json`. This directory is ignored by Git. `CONSENTCRAFT_DATA_NAMESPACE` selects another directory under `.data`; only letters, digits, hyphens, and underscores are allowed. Back up this directory to preserve local accounts and artwork.

| Request | Behavior |
| --- | --- |
| `GET /api/studio` | Current account, its team projects, and incoming invitations; NFT discovery uses `/api/editions` |
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
- Arkiv: selected RPC, funded indexer signing account and trusted writer address. The NFT indexer implements renewal and reconciliation; run `npm run editions:index -- --watch` after deployment.
- 0G Private Computer: API base URL, API key and an image-capable private model. The default is `0gm-1.0-35b-a3b`; trust mode must remain `private`.
- Sepolia NFT contract: RPC URL and `NEXT_PUBLIC_EDITIONS_ADDRESS` after `npm run editions:deploy:sepolia`. Contract deployment settings live separately in `contracts/.env`. `NEXT_PUBLIC_MARKETPLACE_ADDRESS` belongs to the retained legacy contract.

Only variables prefixed `NEXT_PUBLIC_` may enter browser bundles. Keep service keys, session secrets and database credentials server-side. Configure public RPC URLs specifically for browser use. No service balances, accounts, purchases, proofs, or deployments are created by setup.

Official references: [Arkiv SDK](https://github.com/Arkiv-Network/arkiv-sdk-js), [0G Router](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/overview), [Hardhat configuration](https://hardhat.org/docs/reference/configuration).

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

Put unit tests in `tests/unit`, integration tests in `tests/integration`, browser tests in `tests/e2e`, Solidity sources in `contracts/contracts`, and contract tests in `contracts/test`. `npm test` runs Vitest; `test:backend` runs the studio API suite. Playwright starts an isolated production server on port 3100 and leaves its ignored `.data/e2e-*` namespace available for debugging. The interface uses system fonts and bundled SVG artwork, so it does not require remote font or image downloads.

Set `PLAYWRIGHT_DEV=1` to run the same browser suite with Turbopack development diagnostics. It uses `.next-e2e-dev` and an isolated data namespace so an existing studio server can keep running. The provider regression checks fresh loads of the studio, Marketplace and Trade, plus wallet selection, for prerender and hydration errors.

## Verified setup

Lint, web, contract and indexer TypeScript checks, the production build, the backend integration suite,
and the Playwright collaboration flow pass. The contract suite (unit, fuzz and invariant tests) and the
indexer suite pass, and a local contract deploy and smoke run succeeded.
Vitest and Playwright load their configurations, and Chromium successfully opened the
UI with HTTP 200. PostgreSQL connectivity and S3 write/read/delete were verified;
anonymous S3 object access returned HTTP 403. The local service containers are running.

The UI exposes wallet publishing, Arkiv and 0G paths and reports missing configuration. Live private 0G image scoring and catalog checks passed; Arweave publishing, Arkiv indexing of a public NFT deployment and WalletConnect QR still require verification. `npm run dev` starts the app;
`npm run services:down` stops the local services while preserving data.

### AI comic ratings

The separate `ComicRatingRegistry` contract stores comic pointers and immutable AI jury ratings. See [contracts/README.md](contracts/README.md#comic-ratings) for the trust model, Galileo deployment configuration, and typed ABI export.
