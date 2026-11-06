# ConsentCraftMarket contracts

ConsentCraftMarket is one Solidity contract that holds publishing deposits and comic sale payments in native Sepolia ETH. It records reading entitlements, settles deposits and pays everyone through pull withdrawals.

| Document | Purpose |
| --- | --- |
| [docs/CONTRACT_SPEC.md](../docs/CONTRACT_SPEC.md) | Rules and formulas |
| [docs/CONTRACT_INTEGRATION.md](../docs/CONTRACT_INTEGRATION.md) | Functions, EIP-712, events, signing and indexing |
| [docs/CONTRACT_AUDIT.md](../docs/CONTRACT_AUDIT.md) | Internal audit findings and remaining risks |

## Layout

| Path | Contents |
| --- | --- |
| `contracts/ConsentCraftMarket.sol` | The market |
| `contracts/interfaces/` | `IConsentCraftMarket` (functions) and `IConsentCraftMarketTypes` (structs, enums, events, errors) |
| `contracts/test/` | Test-only recipient contracts. Never deploy these. |
| `lib/` | Backend helpers: EIP-712 signing, Arweave ID conversion, deployment record type |
| `abi/` | Exported ABI (`.json` and typed `.ts`) |
| `deployments/` | `sepolia.json` after deployment; `sepolia.example.json` shows the format |
| `scripts/` | `deploy.ts`, `smoke-sepolia.ts`, `export-abi.ts` |
| `test/`, `test-support/` | Unit, fuzz and invariant tests, and shared fixtures |

## Setup

Requires Node.js 24.16.x and npm 11. From the repository root:

```sh
npm ci
npm run contracts:compile
```

Compiling and testing need no environment variables.

## Test

```sh
npm run contracts:test                    # unit, invariant and fuzz tests (~5 s)
npm run typecheck                         # includes the contract workspace
FUZZ_SEEDS=1,2,3 FUZZ_STEPS=1000 npm run contracts:test   # longer fuzz campaign
```

## Local dry run

This uses Hardhat's public development accounts from `local-node.env`. Never use those keys anywhere else.

```sh
npm run contracts:node                    # terminal 1: local chain on 127.0.0.1:8545
npm run contracts:deploy:local            # terminal 2: deploy, grant roles, create SAMPLE policy
npm run contracts:smoke:local             # create -> report -> publish -> purchase -> withdraw
```

## Deploy to Sepolia

1. Copy `contracts/.env.example` to `contracts/.env` and fill it in. `.env` is git-ignored. Prefer the encrypted Hardhat keystore for the deployer key and API key:
   ```sh
   cd contracts
   npx hardhat keystore set SEPOLIA_DEPLOYER_PRIVATE_KEY
   npx hardhat keystore set ETHERSCAN_API_KEY
   ```
2. Fund the deployer with Sepolia ETH. Fund the two smoke-test wallets if you'll run the smoke test.
3. Deploy. This grants every role, creates the **SAMPLE** policy, optionally hands admin to `ADMIN_ADDRESS`, and writes `contracts/deployments/sepolia.json`:
   ```sh
   npm run contracts:deploy:sepolia
   ```
4. Verify the source on Etherscan. The deploy script prints this exact command:
   ```sh
   npm run contracts:verify:sepolia -- <address> <deployer> <ownerRecipient> <aiExpenseRecipient>
   ```
5. Run the smoke test. It spends about 0.0012 Sepolia ETH plus gas, and the 0.0009 ETH deposit remainder stays locked until a refund:
   ```sh
   npm run contracts:smoke:sepolia
   ```
6. Commit `contracts/deployments/sepolia.json` and set `NEXT_PUBLIC_MARKETPLACE_ADDRESS` in the web app's `.env.local`.

The deploy script refuses any chain other than Sepolia (11155111) or local (31337). It won't overwrite an existing deployment file unless `DEPLOY_OVERWRITE=1`.

### SAMPLE demo policy

The deploy script creates policy 1 with **sample values for a testnet demo, not an approved launch configuration**:

| Setting | Value |
| --- | --- |
| `feeBps` | 500 (5%) |
| `minFee` | 0.00001 ETH |
| `minPrice` to `maxPrice` | 0.0001 to 0.01 ETH |
| `appealDuration` | 2 minutes |
| `appealResolutionDuration` | 5 minutes |
| `refundDelay` | 5 minutes |
| `purchaseRequiresPersonhood` | true |

Policies are immutable. Approved launch values need a new policy.

## Regenerate the ABI

```sh
npm run contracts:abi                     # writes abi/ConsentCraftMarket.{json,ts}
```

A test fails if the committed ABI differs from the compiled contract.

## Known limitations

- **Personhood certificates are a trusted backend bridge.** The backend verifies World ID off chain and signs a single-use certificate. The contract checks the signature, not a World ID proof.
- **The contract can't verify Arweave contents or availability.** It stores the two transaction IDs and hashes it's given. The backend confirms availability and hashes before signing a quote, and the reporter checks again before signing a report.
- **Arkiv is only an index.** It's rebuilt from contract events, and it is never an authority for payments, entitlements or settlements.
- **Arweave uploads can't be deleted.** Encrypted bundles and previews are permanent and public. If a content key leaks, the bundle can't be withdrawn, and a takedown can only stop key delivery. Never upload keys or plaintext paid pages.
- **Admin and signing roles are trusted.** An admin who also holds the reporter or reviewer role can flag and reject deposits under review (audit C-01). Use a multisig admin, separate keys per role and an independent reviewer before any real value.
- **Open product decisions:**
  - the AppealTimeout payout (S − A to the author) is pending product approval
  - a review that never arrives leaves the deposit locked
  - purchase certificates aren't bound to a single publication
- **Testnet only.** This has been reviewed internally only, with no external audit, and is not for mainnet or real value.

## Comic ratings

`ComicRatingRegistry` records comic pointers and immutable ratings by rubric version. Anyone can submit a comic; only a relayer can post a rating. Admins manage relayers, the minimum panel size (1–9), and pause/unpause. The latest rating is the most recently posted, regardless of version number. Even-panel medians average the two middle scores, rounded down. The registry trusts relayers to validate signed off-chain results; it does not verify TEE attestations or storage contents. Comic IDs are registry-local and are not marketplace publication IDs.

For a Galileo testnet deployment, configure `REGISTRY_ADMIN_ADDRESS`, `REGISTRY_RELAYER_ADDRESS`, and `REGISTRY_MIN_PANEL_SIZE` in `contracts/.env` or the shell environment. Configure `OG_RPC_URL` and `OG_DEPLOYER_PRIVATE_KEY` in `contracts/.env` or the Hardhat keystore. Fund the deployer with testnet 0G. Then run:

```sh
npm run compile --workspace @consentcraft/contracts
npm run deploy:registry:galileo --workspace @consentcraft/contracts
npm run contracts:abi
```

Record the printed contract address for your client. The generated `abi/ComicRatingRegistry.ts` provides a typed viem ABI; the JSON ABI is also exported. No existing worker automatically submits ratings.
