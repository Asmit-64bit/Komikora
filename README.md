# ConsentCraft development environment

The Next.js starter screen is unchanged. Marketplace routes, authentication, AI review, database schemas and workers are not implemented. The **ConsentCraftMarket contract** is implemented and tested but not yet deployed: see [contracts/README.md](contracts/README.md) for setup, testing, Sepolia deployment, verification and known limitations.

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
Open http://localhost:3000. The starter can run without Docker or external credentials.
`env:setup` creates an ignored `.env.local`, generates a random session secret, and preserves an existing file. Placeholder settings are not yet consumed by application features.

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
| Tests | Vitest and Playwright Chromium configurations; no feature tests yet |

shadcn is configured for future component generation. Initialize the desired theme tokens when UI work begins; this setup does not restyle the starter or add components. The contract workspace is excluded from the web TypeScript build and checked separately. Dependency versions are recorded in `package-lock.json`.

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

- WalletConnect: project ID from the Reown dashboard.
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
npm run contracts:compile
```

`contracts:compile` builds ConsentCraftMarket with solc 0.8.28 (optimizer on) and downloads the compiler as needed.

Test commands are ready for future implementation:

```sh
npm test
npm run test:watch
npm run test:e2e:install
npm run test:e2e
npm run contracts:test
```

Put unit tests in `tests/unit`, integration tests in `tests/integration`, browser tests in `tests/e2e`, Solidity sources in `contracts/contracts`, and contract tests in `contracts/test`. Vitest and Playwright report no tests until tests are added; this is not a passing feature suite. Playwright starts an isolated development server on port 3100. The starter's Google font build requires internet access on an uncached first build.

## Verified setup

Lint, web and contract TypeScript checks, and the production build pass. The contract
suite (unit, fuzz and invariant tests) passes, and a local deploy and smoke run succeeded.
Vitest and Playwright load their configurations, and Chromium successfully opened the
starter with HTTP 200. PostgreSQL connectivity and S3 write/read/delete were verified;
anonymous S3 object access returned HTTP 403. The local service containers are running.

External World ID, Arkiv, 0G and WalletConnect credentials are intentionally blank.
Those service integrations have not been exercised. `npm run dev` starts the app;
`npm run services:down` stops the local services while preserving data.
