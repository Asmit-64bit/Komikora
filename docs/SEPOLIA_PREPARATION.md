# Prepared NFT edition deployment

Prepared on 7 November 2026 for Sepolia (chain 11155111). No deployment transaction has been broadcast, and the predicted address must not be configured as a live contract.

| Role | Public address |
| --- | --- |
| Deployment wallet | `0x7aa489bAedb32f4841D9A4b9816705BA5F57e464` |
| Reviewer signing wallet | `0x3F9a9Be464eFaCaE6ce230A6Ab3C549221e0717F` |
| Project treasury | `0x58314EBCE554403Bbd65eA72450842F13A821310` |
| Predicted contract at nonce 0 | `0x8383D05acD33adaa603BF27269A3a981D9d7ed7B` |

These are dedicated project testnet accounts generated locally with the owner's authorization. Their keys are in the Git-ignored and deployment-excluded `.data/sepolia-wallets.env`. Preserve that file securely; private keys must never be committed, uploaded as source, or placed in `NEXT_PUBLIC_*` settings. The treasury and reviewer are immutable constructor arguments.

The deployment wallet currently has zero Sepolia ETH. Fund it with testnet ETH before broadcasting; 0.01 Sepolia ETH provides headroom over the observed estimate. Use a [Sepolia faucet listed by ethereum.org](https://ethereum.org/developers/docs/networks/#sepolia). Re-estimate fees and confirm the balance immediately before sending.

The compiled creation code is 19,050 bytes, with 17,768 bytes of runtime code. The current Sepolia estimate, independently reproduced through two public RPCs, is 28,257,738 total gas. Sepolia's Glamsterdam upgrade separately meters state creation, so its total creation-gas estimate can exceed the old 16.7M transaction ceiling for execution gas. Do not hard-code old gas assumptions. See [the testnet upgrade announcement](https://blog.ethereum.org/2026/09/17/glamsterdam-testnet-announcement) and [EIP-8037's metering rules](https://eips.ethereum.org/EIPS/eip-8037).

The existing `SEPOLIA_RPC_URL` value is not a complete HTTPS URL. The preparation used `https://ethereum-sepolia-rpc.publicnode.com` and cross-checked `https://sepolia.gateway.tenderly.co`; it did not send the incomplete setting to another service.

## Complete after funding

1. Load the generated deployer key into `SEPOLIA_DEPLOYER_PRIVATE_KEY` privately, and use a valid HTTPS Sepolia RPC. Set `EDITION_REVIEWER_ADDRESS` and `EDITION_TREASURY_ADDRESS` to the public addresses above.
2. Run `DEPLOY_PREFLIGHT=1` with the existing editions deployment command. This rechecks chain, balance and gas without sending. Review the roles, estimate and bytecode before broadcasting.
3. Run `npm run editions:deploy:sepolia` with those settings. Preserve the resulting `contracts/deployments/editions-sepolia.json`, verify the receipt and deployed code, and read back the immutable roles.
4. Configure the confirmed address and matching chain/RPC on Vercel. Configure the reviewer key, Arweave upload identity and stable content-encryption key server-side. Preserve existing production encryption keys if present. The current 0G configuration must also pass a real authorized review before declaring publishing operational.
5. Rebuild/redeploy, check Network & services, and test curator review followed by the creator's wallet-confirmed mint. No mock approval or disabled rights check should replace the real review.

Validation completed during preparation: 187 contract tests passed; the publishing browser regression checks missing-deployment explanations, artwork/rights/save requirements, inline checkbox layout at desktop/mobile sizes, and saving from the review tab.
