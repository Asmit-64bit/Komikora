// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IConsentCraftMarket
/// @notice Interface for the ConsentCraft comic marketplace contract on Sepolia.
/// All amounts are native ETH in wei. See docs/CONTRACT_SPEC.md for the
/// normative rules and docs/CONTRACT_INTEGRATION.md for the call flow.
/// @dev Access control is OpenZeppelin AccessControl; pausing is OpenZeppelin
/// Pausable (its Paused/Unpaused events and EnforcedPause/ExpectedPause errors
/// are inherited by the implementation, not redeclared here). Role checks
/// revert with AccessControlUnauthorizedAccount.
interface IConsentCraftMarket {
    // ---------------------------------------------------------------------
    // Enums
    // ---------------------------------------------------------------------

    /// @notice Review state of a publication.
    enum PublicationState {
        Deposited, // created, awaiting a review report
        Flagged, // report flagged it; author may appeal until appealDeadline
        AppealPending, // author appealed; reviewer may resolve until resolutionDeadline
        Approved, // cleared for publication, not yet published
        Published, // author published it (terminal for review)
        Rejected // terminal; deposit settled with Rejected or AppealTimeout
    }

    /// @notice Marketplace listing state, independent of review state.
    enum ListingState {
        Unlisted, // never listed
        Listed, // purchasable
        Delisted // removed by the author; existing entitlements remain
    }

    /// @notice Why a publication's deposit was settled. None means not yet settled.
    enum SettlementReason {
        None,
        Rejected,
        AppealTimeout,
        ThresholdReached,
        AuthorRefund
    }

    /// @notice Outcome carried in a signed ReviewReport.
    enum ReviewOutcome {
        Approve,
        Flag
    }

    /// @notice How an approval was reached.
    enum ApprovalPath {
        Report,
        Appeal
    }

    /// @notice Classification of a credit, for indexers and accounting.
    enum CreditKind {
        SaleProceeds, // P - f(P) to the author
        PlatformFee, // f(P) to the owner
        AiExpense, // A to the AI expense recipient
        DepositRefund, // F to the author
        OwnerAllocation // O to the owner
    }

    // ---------------------------------------------------------------------
    // Structs
    // ---------------------------------------------------------------------

    /// @notice Immutable fee and timing terms. A policy never changes after creation.
    struct Policy {
        uint256 minFee; // wei
        uint16 feeBps; // <= 10_000
        uint64 appealWindow; // seconds the author has to appeal after a flag
        uint64 resolutionWindow; // seconds the reviewer has to resolve an appeal
        bool exists;
    }

    /// @notice Publication record. Fields marked frozen never change after creation.
    struct Publication {
        // frozen terms
        address author;
        uint256 policyId;
        bytes32 manifestHash; // hash of the canonical encrypted-bundle manifest
        bytes32 previewManifestHash; // hash of the canonical public preview manifest bytes
        bytes32 arweaveBundleTxId; // encrypted full pages, non-zero
        bytes32 arweavePreviewTxId; // public preview manifest, non-zero
        uint32 pageCount;
        uint256 price; // P, wei
        uint256 deposit; // S, wei
        uint256 aiCap; // wei, aiCap < S
        // set by review
        uint8 ratingSnapshot;
        uint256 aiCost; // A, recognized once, A <= aiCap
        // sales and settlement
        uint256 grossSales; // R, cumulative, includes self-purchases
        uint256 authorRefund; // F, set at settlement
        uint256 ownerAllocation; // O, set at settlement
        // states
        PublicationState state;
        ListingState listingState;
        SettlementReason settlementReason;
        // timestamps (unix seconds, 0 = not reached)
        uint64 createdAt;
        uint64 reviewedAt;
        uint64 appealDeadline;
        uint64 appealedAt;
        uint64 resolutionDeadline;
        uint64 decidedAt; // final approval or rejection
        uint64 publishedAt;
        uint64 delistedAt;
        uint64 settledAt;
    }

    /// @notice EIP-712 quote signed by a QUOTE_SIGNER_ROLE account after the backend
    /// has verified that both Arweave transactions are available and match the hashes.
    struct PublicationQuote {
        bytes32 quoteId; // single use
        address author; // must equal msg.sender
        uint256 policyId;
        bytes32 manifestHash;
        bytes32 previewManifestHash;
        bytes32 arweaveBundleTxId;
        bytes32 arweavePreviewTxId;
        uint32 pageCount;
        uint256 price;
        uint256 deposit; // must equal msg.value
        uint256 aiCap;
        uint64 expiresAt;
    }

    /// @notice EIP-712 personhood certificate signed by a QUOTE_SIGNER_ROLE account.
    /// Reusable by `account` until `expiresAt`. personhoodHash is opaque to the
    /// contract: it is bound into the signature but never stored or emitted.
    struct PersonhoodCertificate {
        address account;
        bytes32 personhoodHash;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    /// @notice EIP-712 review report signed by a REPORTER_ROLE account after it has
    /// checked the Arweave contents against manifestHash and previewManifestHash.
    struct ReviewReport {
        bytes32 reportId; // single use
        uint256 publicationId;
        bytes32 manifestHash; // must equal the publication's manifestHash
        ReviewOutcome outcome;
        uint256 aiCost; // becomes A; must be <= aiCap
        uint8 ratingSnapshot;
        bytes32 reasonHash; // hash of the private review rationale
        uint64 expiresAt;
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event PolicyCreated(
        uint256 indexed policyId, uint16 feeBps, uint256 minFee, uint64 appealWindow, uint64 resolutionWindow
    );

    event OwnerRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);
    event AiExpenseRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);

    event PublicationCreated(
        uint256 indexed publicationId,
        address indexed author,
        uint256 indexed policyId,
        bytes32 manifestHash,
        bytes32 previewManifestHash,
        bytes32 arweaveBundleTxId,
        bytes32 arweavePreviewTxId,
        uint32 pageCount,
        uint256 price,
        uint256 deposit,
        uint256 aiCap
    );

    /// @notice Emitted for every state transition in the review lifecycle.
    event ReviewStatusChanged(
        uint256 indexed publicationId, PublicationState previousState, PublicationState newState
    );

    event ReviewReportSubmitted(
        uint256 indexed publicationId,
        bytes32 indexed reportId,
        ReviewOutcome outcome,
        uint256 aiCost,
        uint8 ratingSnapshot,
        bytes32 reasonHash
    );

    event PublicationFlagged(uint256 indexed publicationId, uint64 appealDeadline, bytes32 reasonHash);

    event AppealFiled(uint256 indexed publicationId, bytes32 appealHash, uint64 resolutionDeadline);

    event AppealResolved(
        uint256 indexed publicationId, address indexed reviewer, bool approved, bytes32 resolutionHash
    );

    event PublicationApproved(uint256 indexed publicationId, ApprovalPath path);

    event PublicationRejected(uint256 indexed publicationId, SettlementReason reason);

    event PublicationPublished(uint256 indexed publicationId, uint256 price);

    event PublicationDelisted(uint256 indexed publicationId);

    event Purchased(
        uint256 indexed publicationId,
        address indexed buyer,
        bytes32 indexed requestId,
        uint256 price,
        uint256 platformFee,
        uint256 authorProceeds,
        uint256 cumulativeGrossSales
    );

    /// @notice Deposit settlement. Always satisfies deposit == aiCost + authorRefund + ownerAllocation.
    event DepositSettled(
        uint256 indexed publicationId,
        SettlementReason indexed reason,
        uint256 deposit,
        uint256 aiCost,
        uint256 authorRefund,
        uint256 ownerAllocation,
        uint256 grossSales
    );

    event Credited(
        address indexed account, uint256 indexed publicationId, CreditKind indexed kind, uint256 amount
    );

    event Withdrawn(address indexed account, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error InvalidPolicy();
    error UnknownPolicy(uint256 policyId);
    error UnknownPublication(uint256 publicationId);

    error InvalidSignature();
    error QuoteExpired(bytes32 quoteId);
    error QuoteAlreadyUsed(bytes32 quoteId);
    error QuoteAuthorMismatch(address expected, address caller);
    error CertificateExpired();
    error CertificateNotYetValid();
    error CertificateAccountMismatch(address expected, address caller);
    error ReportExpired(bytes32 reportId);
    error ReportAlreadyUsed(bytes32 reportId);
    error ReportManifestMismatch(uint256 publicationId);

    error ZeroManifestHash();
    error ZeroArweaveTxId();
    error ZeroPageCount();
    error InvalidPrice(uint256 price, uint256 minFee);
    error InvalidDepositTerms(uint256 deposit, uint256 aiCap);
    error DepositMismatch(uint256 expected, uint256 received);
    error AiCostExceedsCap(uint256 aiCost, uint256 aiCap);

    error NotAuthor(uint256 publicationId, address caller);
    error InvalidPublicationState(uint256 publicationId, PublicationState current);
    error InvalidListingState(uint256 publicationId, ListingState current);
    error AppealWindowOpen(uint256 publicationId, uint64 appealDeadline);
    error AppealWindowClosed(uint256 publicationId, uint64 appealDeadline);
    error ResolutionWindowOpen(uint256 publicationId, uint64 resolutionDeadline);
    error ResolutionWindowClosed(uint256 publicationId, uint64 resolutionDeadline);

    error PaymentMismatch(uint256 expected, uint256 received);
    error RequestIdAlreadyUsed(bytes32 requestId);
    error AlreadyEntitled(uint256 publicationId, address buyer);

    error NothingToWithdraw();
    error WithdrawalFailed(address account, uint256 amount);

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /// @notice DEFAULT_ADMIN_ROLE. Creates an immutable policy.
    function createPolicy(uint16 feeBps, uint256 minFee, uint64 appealWindow, uint64 resolutionWindow)
        external
        returns (uint256 policyId);

    /// @notice DEFAULT_ADMIN_ROLE. Affects future credits only; existing credits stay with their holder.
    function setOwnerRecipient(address newRecipient) external;

    /// @notice DEFAULT_ADMIN_ROLE. Affects future credits only; existing credits stay with their holder.
    function setAiExpenseRecipient(address newRecipient) external;

    /// @notice PAUSER_ROLE.
    function pause() external;

    /// @notice PAUSER_ROLE.
    function unpause() external;

    // ---------------------------------------------------------------------
    // Publication lifecycle
    // ---------------------------------------------------------------------

    /// @notice Author creates a publication with msg.value == quote.deposit.
    function createPublication(
        PublicationQuote calldata quote,
        bytes calldata quoteSignature,
        PersonhoodCertificate calldata certificate,
        bytes calldata certificateSignature
    ) external payable returns (uint256 publicationId);

    /// @notice Anyone may relay a REPORTER_ROLE-signed report for a Deposited publication.
    function submitReviewReport(ReviewReport calldata report, bytes calldata signature) external;

    /// @notice Author appeals a Flagged publication on or before appealDeadline.
    function appeal(uint256 publicationId, bytes32 appealHash) external;

    /// @notice REVIEWER_ROLE resolves an appeal on or before resolutionDeadline.
    function resolveAppeal(uint256 publicationId, bool approve, bytes32 resolutionHash) external;

    /// @notice Anyone, after appealDeadline, for a Flagged publication that was not appealed.
    function finalizeRejection(uint256 publicationId) external;

    /// @notice Author, after resolutionDeadline, for an unresolved appeal.
    function claimAppealTimeout(uint256 publicationId) external;

    /// @notice Author lists an Approved publication.
    function publish(uint256 publicationId) external;

    /// @notice Buyer pays exactly the publication price and receives a reading entitlement.
    function purchase(
        uint256 publicationId,
        bytes32 requestId,
        PersonhoodCertificate calldata certificate,
        bytes calldata certificateSignature
    ) external payable;

    /// @notice Author delists and, if the deposit is unsettled, settles it with AuthorRefund.
    function refundAndDelist(uint256 publicationId) external;

    /// @notice Withdraws the caller's entire credit balance.
    function withdraw() external;

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function hasReadingAccess(uint256 publicationId, address account) external view returns (bool);

    function getPublication(uint256 publicationId) external view returns (Publication memory);

    function getPolicy(uint256 policyId) external view returns (Policy memory);

    function publicationCount() external view returns (uint256);

    function policyCount() external view returns (uint256);

    function ownerRecipient() external view returns (address);

    function aiExpenseRecipient() external view returns (address);

    /// @notice f(P) under a policy.
    function saleFee(uint256 policyId, uint256 price) external view returns (uint256);

    /// @notice F and O the deposit would settle to now, with the publication's current A and R.
    function previewSettlement(uint256 publicationId)
        external
        view
        returns (uint256 retained, uint256 authorRefund, uint256 ownerAllocation);

    function creditOf(address account) external view returns (uint256);

    function isQuoteUsed(bytes32 quoteId) external view returns (bool);

    function isReportUsed(bytes32 reportId) external view returns (bool);

    function isRequestIdUsed(bytes32 requestId) external view returns (bool);

    /// @notice Sum of all unwithdrawn credits.
    function totalCredits() external view returns (uint256);

    /// @notice Sum of unsettled deposit amounts not yet converted to credits.
    function totalHeldDeposits() external view returns (uint256);

    /// @notice totalCredits() + totalHeldDeposits(). The contract balance is always >= this.
    function totalLiabilities() external view returns (uint256);
}
