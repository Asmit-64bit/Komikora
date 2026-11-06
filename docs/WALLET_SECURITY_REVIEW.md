# MetaMask website classification review

Prepared 7 November 2026. **Not submitted. Classification remains unresolved.**

## Report to submit

Please investigate the phishing / wallet-draining classification for https://creato-phi.vercel.app/.

MetaMask displays “Continue at your own risk” during wallet connection. The screenshot says the site shows signs of phishing or wallet-draining activity. The project is ConsentCraft, a collaborative comic NFT studio; source: https://github.com/Asmit-64bit/eth.

The deployed sign-in flow was checked on 7 November 2026 using a temporary injected test wallet. Its only signing request was `personal_sign` for an ERC-4361 sign-in message. Both the domain and URI matched the public website, and the signature was cryptographically verified. No transaction, typed-data signature, or token approval was requested in that tested connection/sign-in flow. The browser audit stopped before creating a session and cleared its temporary challenge.

Separate live backend checks passed wallet authentication, secure session cookies, replay rejection, draft saving, persistence after signing out/in, and cross-origin rejection. The earlier studio database outage has been repaired with hosted PostgreSQL.

These checks do not establish that the classification is incorrect, audit every application flow, or reproduce MetaMask's threat intelligence. Please identify the flagged domain, contract, request, or other risk signal and the remediation required. We can provide the warning screenshot, wallet version, affected network, and reproduction details.

## Submission and evidence

- Attach the user's current warning screenshot. Record the actual MetaMask version and affected network; these have not been established by the screenshot.
- Follow [MetaMask's manual classification review instructions](https://support.metamask.io/configure/wallet/security-alerts/#how-to-report-a-false-classification). Its current guidance directs URL warnings to support; the in-alert reporting flow applies to transaction alerts.
- Source coverage: `tests/e2e/wallet-auth.spec.ts` checks attempted signing and transaction methods, including rejected signatures. A separate browser audit ran against the production site with an injected test provider. It does not reproduce a real MetaMask classification decision.
- Publishing, purchasing, and other contract interactions are separate from login. The current deployment still lacks parts of the NFT publishing configuration; this report does not claim those paths were fully verified.

Keep the warning in place while the finding is investigated. A deployment or metadata change does not itself clear an external classification, and no classification review has been submitted by this work.
