// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IConsentCraftMarketTypes
/// @notice Enums, structs, events and custom errors shared by the ConsentCraft
/// marketplace interface, implementation, tests and indexers.
/// @dev OpenZeppelin AccessControl and Pausable events/errors (RoleGranted,
/// Paused, AccessControlUnauthorizedAccount, EnforcedPause, ...) come from the
/// implementation's base contracts and are not redeclared here.
interface IConsentCraftMarketTypes {
    // ---------------------------------------------------------------------
    // Enums
    // ---------------------------------------------------------------------

    /// @notice Review state of a publication.
    enum PublicationState {
        Deposited, // created, awaiting a review report
        Flagged, // report flagged it; author may appeal before appealDeadline
        AppealPending, // author appealed; reviewer may resolve before resolutionDeadline
        Approved, // cleared for publication, not yet published
        Published, // author published it (terminal for review)
        Rejected // terminal; deposit settled with Rejected or AppealTimeout
    }

    /// @notice Marketplace listing state, independent of review state.
    enum ListingState {
        Unlisted, // never listed
        Listed, // purchasable
        Delisted // removed via refundAndDelist; existing entitlements remain
    }

    /// @notice Why a publication's deposit was settled. None means not yet settled.
    enum SettlementReason {
        None,
        Rejected,
        AppealTimeout,
        ThresholdReached,
        AuthorRefund
    }

    /// @notice How an approval was reached.
    enum ApprovalPath {
        Report,
        Appeal
    }

    /// @notice Action a PersonhoodCertificate authorizes. Encoded as uint8 in EIP-712.
    enum PersonhoodAction {
        Publish,
        Purchase
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

    /// @notice Append-only fee, price and timing terms. Never modified after creation,
    /// so a publication's policyId freezes its terms.
    struct Policy {
        uint256 minFee; // wei
        uint256 minPrice; // wei, > minFee
        uint256 maxPrice; // wei, >= minPrice
        uint16 feeBps; // <= 10_000
        uint64 appealDuration; // seconds after a flag during which the author may appeal
        uint64 appealResolutionDuration; // seconds after an appeal during which a reviewer may resolve
        uint64 refundDelay; // seconds after publication before refundAndDelist is allowed
        bool purchaseRequiresPersonhood;
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
        uint8 ratingSnapshot; // author-rating snapshot from the quote
        uint256 price; // P, wei
        uint256 deposit; // S, wei
        uint256 aiCap; // wei, aiCap < S
        // review
        uint256 aiCost; // A, recognized once, A <= aiCap
        bytes32 reportHash; // hash of the private review record from the accepted report
        uint16 score; // advisory content score from the accepted report; scale defined off chain
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
        uint64 flaggedAt;
        uint64 appealDeadline;
        uint64 appealedAt;
        uint64 appealResolutionDeadline;
        uint64 decidedAt; // final approval or rejection
        uint64 publishedAt;
        uint64 refundEligibleAt; // publishedAt + policy.refundDelay
        uint64 delistedAt;
        uint64 settledAt;
    }

    /// @notice EIP-712 quote signed by a QUOTE_SIGNER_ROLE account after the backend
    /// has verified that both Arweave transactions are available and match the hashes.
    /// @dev All fields are static, so abi.encode(TYPEHASH, quote) equals the EIP-712 encodeData.
    struct PublicationQuote {
        address author; // must equal msg.sender
        bytes32 manifestHash;
        bytes32 previewManifestHash;
        bytes32 arweaveBundleTxId;
        bytes32 arweavePreviewTxId;
        uint32 pageCount;
        uint256 policyId;
        uint256 price;
        uint256 deposit; // must equal msg.value
        uint256 aiCap;
        uint8 ratingSnapshot;
        uint64 expiresAt;
        uint256 nonce; // single use
    }

    /// @notice EIP-712 personhood certificate signed by a QUOTE_SIGNER_ROLE account.
    /// Single use; bound to one wallet and one action. The domain binds chain and contract.
    struct PersonhoodCertificate {
        address wallet; // must equal msg.sender
        PersonhoodAction action;
        uint64 expiresAt;
        uint256 nonce; // single use
    }

    /// @notice EIP-712 review report signed by a REPORTER_ROLE account after it has
    /// checked the Arweave contents against manifestHash and previewManifestHash.
    /// Only successful reviews are signed: service errors (timeouts, unsupported models,
    /// malformed output) never produce a report, so they cannot cause forfeiture.
    /// @dev All fields are static, so abi.encode(TYPEHASH, report) equals the EIP-712 encodeData.
    struct ReviewReport {
        uint256 publicationId; // must equal the publicationId argument
        bytes32 manifestHash; // must equal the publication's manifestHash
        bytes32 arweaveBundleTxId; // must equal the publication's arweaveBundleTxId
        bytes32 reportHash; // hash of the private review record
        bytes32 modelVersion; // hash or identifier of the model version used
        bytes32 promptVersion; // hash or identifier of the prompt version used
        uint256 policyId; // must equal the publication's policyId
        uint16 score; // advisory content score; scale defined off chain
        bool flagged;
        uint256 aiCost; // becomes A; must be <= aiCap
        bytes32 jobId; // single use across all publications
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event PolicyCreated(
        uint256 indexed policyId,
        uint256 minFee,
        uint16 feeBps,
        uint256 minPrice,
        uint256 maxPrice,
        uint64 appealDuration,
        uint64 appealResolutionDuration,
        uint64 refundDelay,
        bool purchaseRequiresPersonhood
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

    /// @notice Emitted for every review-state transition after creation.
    event ReviewStatusChanged(
        uint256 indexed publicationId, PublicationState previousState, PublicationState newState
    );

    event ReviewReportSubmitted(
        uint256 indexed publicationId,
        bytes32 indexed jobId,
        bool flagged,
        uint16 score,
        uint256 aiCost,
        bytes32 reportHash,
        bytes32 modelVersion,
        bytes32 promptVersion
    );

    event PublicationFlagged(uint256 indexed publicationId, uint64 flaggedAt, uint64 appealDeadline);

    event AppealFiled(uint256 indexed publicationId, bytes32 evidenceHash, uint64 appealResolutionDeadline);

    event AppealResolved(uint256 indexed publicationId, address indexed reviewer, bool approved, bytes32 reasonHash);

    event PublicationApproved(uint256 indexed publicationId, ApprovalPath path);

    event PublicationRejected(uint256 indexed publicationId, SettlementReason reason);

    event PublicationPublished(uint256 indexed publicationId, uint256 price, uint64 refundEligibleAt);

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
    error DirectPaymentRejected();
    error InvalidPolicy();
    error UnknownPolicy(uint256 policyId);
    error UnknownPublication(uint256 publicationId);

    error InvalidQuoteSignature();
    error QuoteExpired(uint64 expiresAt);
    error QuoteNonceUsed(uint256 nonce);
    error QuoteAuthorMismatch(address expected, address caller);

    error InvalidCertificateSignature();
    error CertificateExpired(uint64 expiresAt);
    error CertificateNonceUsed(uint256 nonce);
    error CertificateWalletMismatch(address expected, address caller);
    error CertificateActionMismatch(PersonhoodAction expected, PersonhoodAction actual);

    error InvalidReportSignature();
    error ReportPublicationMismatch(uint256 expected, uint256 actual);
    error ReportJobIdUsed(bytes32 jobId);
    error ReportManifestMismatch(uint256 publicationId);
    error ReportArweaveTxIdMismatch(uint256 publicationId);
    error ReportPolicyMismatch(uint256 publicationId, uint256 expected, uint256 actual);

    error ZeroManifestHash();
    error ZeroArweaveTxId();
    error ZeroPageCount();
    error PriceOutOfBounds(uint256 price, uint256 minPrice, uint256 maxPrice);
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
    error RefundNotYetAvailable(uint256 publicationId, uint64 refundEligibleAt);
    error DepositAlreadySettled(uint256 publicationId, SettlementReason reason);
    error RefundBelowMinimum(uint256 refund, uint256 minRefund);

    error PaymentMismatch(uint256 expected, uint256 received);
    error ZeroRequestId();
    error RequestIdAlreadyUsed(bytes32 requestId);
    error AlreadyEntitled(uint256 publicationId, address buyer);

    error NothingToWithdraw();
    error WithdrawalFailed(address account, uint256 amount);
}
