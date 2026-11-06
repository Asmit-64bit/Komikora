# Sepolia NFT edition deployment

Deployed on 7 November 2026 to Sepolia (chain 11155111). [Deployment transaction](https://sepolia.etherscan.io/tx/0x2ea4f501bbdf19b43267cd00a248c4d9d052029f8e260b94ea51a7bfc84600e2), confirmed at block 12079576. The receipt, deployed code hash and immutable roles were verified independently before configuring the app. The public deployment manifest is `contracts/deployments/editions-sepolia.json`.

| Role | Public address |
| --- | --- |
| Deployment wallet | `0x7aa489bAedb32f4841D9A4b9816705BA5F57e464` |
| Reviewer signing wallet | `0x3F9a9Be464eFaCaE6ce230A6Ab3C549221e0717F` |
| Project treasury | `0x58314EBCE554403Bbd65eA72450842F13A821310` |
| Deployed contract | `0x8383D05acD33adaa603BF27269A3a981D9d7ed7B` |

These are dedicated project testnet accounts generated locally with the owner's authorization. Their keys are in the Git-ignored and deployment-excluded `.data/sepolia-wallets.env`. Preserve that file securely; private keys must never be committed, uploaded as source, or placed in `NEXT_PUBLIC_*` settings. The treasury and reviewer are immutable constructor arguments.

The owner funded the deployment wallet with 0.01 Sepolia ETH, and the contract deployment used testnet gas from that balance. These accounts are for this testnet deployment. Re-estimate fees and confirm balances before any future transaction.

The compiled creation code is 19,050 bytes, with 17,768 bytes of runtime code. The current Sepolia estimate, independently reproduced through two public RPCs, is 28,257,738 total gas. Sepolia's Glamsterdam upgrade separately meters state creation, so its total creation-gas estimate can exceed the old 16.7M transaction ceiling for execution gas. Do not hard-code old gas assumptions. See [the testnet upgrade announcement](https://blog.ethereum.org/2026/09/17/glamsterdam-testnet-announcement) and [EIP-8037's metering rules](https://eips.ethereum.org/EIPS/eip-8037).

The original root `.env` setting for `SEPOLIA_RPC_URL` was not a complete HTTPS URL. The local app and Vercel now use `https://ethereum-sepolia-rpc.publicnode.com`, cross-checked against `https://sepolia.gateway.tenderly.co`. The incomplete setting was not sent to another service.

## Application configuration

The confirmed contract address, Sepolia chain ID/RPC and matching server reviewer key are configured in `.env.local` and Vercel Production/Preview. The operator explicitly approved transferring the generated server-only credentials to Vercel. The app uses a dedicated upload identity and the existing stable local content-encryption key; there was no existing production encryption key to rotate. Database settings and user drafts were preserved.

The deployment script now passes its validated gas limit and fee estimate explicitly. An implicit second estimate previously hit an RPC's 10M cap, even though the original Sepolia estimate had succeeded. The initial rejected attempts were not broadcast and spent no gas.

The live storage SDK also failed while importing `rpc-websockets`: its CommonJS build required an ESM-only `uuid` release. The scoped override to `uuid@11.1.1` preserves CommonJS compatibility without changing other UUID dependencies. `tests/integration/storage-sdk.test.ts` reproduces the Vercel restriction with `--no-experimental-require-module` and validates the SDK import.

Curator review, encryption and creator wallet minting remain real service/contract operations. No mock approval or disabled rights check replaces them. Arkiv indexing is optional and remains unconfigured; the marketplace can use contract RPC reads.

Validation completed during preparation: 187 contract tests passed; the publishing browser regression checks missing-deployment explanations, artwork/rights/save requirements, inline checkbox layout at desktop/mobile sizes, and saving from the review tab.

The configured form was also checked on the live site at desktop and mobile sizes: a saved comic with all artwork and rights confirmed enables “Submit for curator review.” The storage-SDK regression and ordinary suite passed (51 tests, with optional live/database tests skipped).

One explicitly authorized live submission used original synthetic artwork, encrypted external storage and the real private 0G review. Vercel recorded its `POST /api/editions` as HTTP 200 (request `fbbz6-1794005623729-ac45f3500849`), with no runtime error. For the submitted `review` action, this success path requires a completed, approved review. The test runner's subsequent studio read failed with `ECONNRESET`, so it did not retain the model score or response details. Only the generated test account, sessions, draft and associated private secrets were cleaned up. No NFT mint or sale was performed, and the external test upload cannot be recalled.
