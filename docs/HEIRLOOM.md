# Comic inheritance after inactivity

The supplied `heirloom-project.zip` contains an ETH vault, a Foundry test suite, a separate frontend and a notifier. This integration adapts its owner heartbeat, inactivity timeout, challenge window and two guardian vetoes to the reading marketplace. It uses the repository's Hardhat 3, Solidity 0.8.28, viem and OpenZeppelin setup. It does not run the archive's deployment or notification instructions.

## What a plan covers

`ConsentCraftReadingHeirloom` extends the existing reading contract through internal activity and credit hooks. Every wallet can opt in for 1–8 heirs with positive allocations totaling 10,000 basis points. The plan applies only to this contract and wallet:

- Each heir can explicitly claim reading access for comics the wallet purchased or contributed to. Reading claims are bounded to 50 comics per transaction. The original account loses reading access when inheritance is finalized. The standard Library discovers inherited access from `ReadingInherited` events.
- Unwithdrawn marketplace credits at finalization, plus future credits to that original contributor wallet, are split by the plan. Earlier withdrawn proceeds are excluded. Each heir pulls their own cumulative allocation; another heir's failing recipient does not block it. Less than one wei per heir may remain as rounding dust.
- Creator attribution, copyright, publication metadata, signed team approvals and original collaborator allocations are not transferred or rewritten. Inheriting a 40% allocation of a creator's 60% revenue share means 24% of the comic's net proceeds, not 40% of the whole comic.

This does not cover assets on other contracts, tokens in external wallets, old-market credits or old reading entitlements. An heir's uncollected claim against a previous ancestor is not automatically forwarded to that heir's own heirs; heirs should collect proceeds while their wallets are active.

## Timer and claim workflow

The UI proposes 180 inactive days and a 14-day challenge window. Owners can choose 30–3,650 inactive days and 7–90 challenge days. All timing uses block timestamps.

1. The owner confirms `configureInheritance` in their wallet. Plans, addresses and shares are public.
2. `checkIn`, publishing, purchasing, revoking approval and normal withdrawals on the Heirloom marketplace reset the owner's timer and cancel an open claim. Merely logging in, reading pages or using an unrelated contract does not reset it. Anyone else's deposits, purchases or credits cannot keep the owner active.
3. After the inactivity period, a configured heir can start a claim. The owner can cancel it by checking in. The optional guardian can restart the timer twice per configured plan, without moving funds. A replacement plan resets the veto allowance.
4. After the challenge window, a configured heir can finalize. Finalization is permanent: the old wallet cannot reset its plan, withdraw its credits, purchase or publish again through this contract.
5. Heirs claim specific comics and withdraw their proceeds from the Inheritance page. Future sales continue to credit the original wallet and become claimable in the frozen split.

Inactivity does not establish death. No automatic notification service is enabled; owners and guardians must monitor their deadlines. The frontend uses confirmed chain state and never changes a plan or finalizes a claim through an administrator key.

## Existing deployment and new deployment

Existing `ConsentCraftReading` deployments cannot gain this feature because they are immutable. The app probes `heirloomVersion()` and shows an unsupported-deployment message rather than presenting inactive controls as working. The feature uses the existing `NEXT_PUBLIC_READING_ADDRESS`, chain/RPC, reviewer and treasury settings; there is no independent ETH vault or key custody service.

Local preparation and tests:

```sh
npm run contracts:compile
npm run heirloom:abi
npm run contracts:test
npm run build
npm run test:heirloom
```

`test:heirloom` creates a temporary local Hardhat chain, generated wallets and a separate file-store namespace. It checks real wallet approvals, inactivity claims, inherited encrypted HTTP reading, library discovery and current/future creator proceeds. Storage and curator review are explicit synthetic fixtures; it makes no paid inference or public-storage calls.

A new testnet deployment is prepared with the same reviewer and treasury addresses used by the project. Fund the deployer in the target testnet and run:

```sh
DEPLOY_PREFLIGHT=1 npm run heirloom:deploy:sepolia
# Only when the deployment is intended:
npm run heirloom:deploy:sepolia
```

The new manifest is `contracts/deployments/reading-heirloom-sepolia.json`; the script refuses to overwrite it. A local equivalent is `heirloom:deploy:local`, with `EDITION_REVIEWER_ADDRESS` and `EDITION_TREASURY_ADDRESS` provided in the shell. Neither command is run automatically. Existing deployment manifests are preserved. Do not replace a live marketplace's address without a plan for keeping old publications, content keys, entitlements and earnings accessible; there is no automatic migration in this change.

## Source review changes

Compared with the ZIP, the integration rejects zero/self/duplicate heirs, bounds list sizes and timing, supports owner plan replacement and cancellation before finalization, uses custom errors, and handles future revenue through cumulative accounting rather than a one-time ETH balance snapshot. Pull withdrawals use the existing reentrancy guard and update accounting before sending ETH. The original Base Sepolia deployment and Telegram notifier are not activated.
