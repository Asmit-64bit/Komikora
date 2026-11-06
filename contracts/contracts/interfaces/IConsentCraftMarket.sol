// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IConsentCraftMarketTypes} from "./IConsentCraftMarketTypes.sol";

/// @title IConsentCraftMarket
/// @notice Complete external interface of the ConsentCraft comic marketplace on Sepolia.
/// All amounts are native ETH in wei. See docs/CONTRACT_SPEC.md for the normative
/// rules and docs/CONTRACT_INTEGRATION.md for the call flow.
/// @dev Role checks revert with AccessControlUnauthorizedAccount; pause checks with
/// EnforcedPause. The implementation inherits this interface once every function
/// exists; until then it inherits IConsentCraftMarketTypes and implements a subset
/// (see the spec's implementation status).
interface IConsentCraftMarket is IConsentCraftMarketTypes {
    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /// @notice DEFAULT_ADMIN_ROLE. Appends an immutable policy. Ids start at 1.
    function createPolicy(Policy calldata policy) external returns (uint256 policyId);

    /// @notice DEFAULT_ADMIN_ROLE. Affects future credits only.
    function setOwnerRecipient(address newRecipient) external;

    /// @notice DEFAULT_ADMIN_ROLE. Affects future credits only.
    function setAiExpenseRecipient(address newRecipient) external;

    /// @notice PAUSER_ROLE. Blocks createPublication and purchase only.
    function pause() external;

    /// @notice PAUSER_ROLE.
    function unpause() external;

    // ---------------------------------------------------------------------
    // Publication lifecycle
    // ---------------------------------------------------------------------

    /// @notice Author creates a publication with msg.value == quote.deposit.
    /// The certificate must carry action Publish.
    function createPublication(
        PublicationQuote calldata quote,
        bytes calldata quoteSignature,
        PersonhoodCertificate calldata certificate,
        bytes calldata certificateSignature
    ) external payable returns (uint256 publicationId);

    /// @notice Anyone may relay a REPORTER_ROLE-signed report for a Deposited publication.
    /// Recognizes A once and credits it to the AI expense recipient.
    function submitReviewReport(uint256 publicationId, ReviewReport calldata report, bytes calldata signature)
        external;

    /// @notice Author appeals a Flagged publication strictly before appealDeadline.
    function appeal(uint256 publicationId, bytes32 evidenceHash) external;

    /// @notice REVIEWER_ROLE resolves an appeal strictly before appealResolutionDeadline.
    /// Rejection settles the deposit with reason Rejected (S - A to the owner).
    function resolveAppeal(uint256 publicationId, bool approved, bytes32 reasonHash) external;

    /// @notice Anyone, at or after appealDeadline, for a Flagged publication that was not appealed.
    /// Settles with reason Rejected (S - A to the owner).
    function finalizeRejection(uint256 publicationId) external;

    /// @notice Anyone, at or after appealResolutionDeadline, for an unresolved appeal.
    /// Settles with reason AppealTimeout (S - A to the author; pending product approval).
    function claimAppealTimeout(uint256 publicationId) external;

    /// @notice Author lists an Approved publication: Published, Listed, publishedAt and refundEligibleAt set once.
    function publish(uint256 publicationId) external;

    /// @notice Buyer pays exactly the price and receives a reading entitlement. The
    /// certificate (action Purchase) is checked only when the policy requires personhood;
    /// otherwise pass a zeroed certificate and empty signature.
    function purchase(
        uint256 publicationId,
        bytes32 requestId,
        PersonhoodCertificate calldata certificate,
        bytes calldata certificateSignature
    ) external payable;

    /// @notice Author, at or after publishedAt + refundDelay with R < S and an unsettled
    /// deposit, delists and settles with AuthorRefund. Reverts if F < minRefund.
    function refundAndDelist(uint256 publicationId, uint256 minRefund) external;

    /// @notice Withdraws the caller's entire credit balance.
    function withdraw() external;

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice True when `wallet` holds an entitlement (bought a copy). Survives delisting.
    function hasReadingAccess(uint256 publicationId, address wallet) external view returns (bool);

    function getPublication(uint256 publicationId) external view returns (Publication memory);

    function getPolicy(uint256 policyId) external view returns (Policy memory);

    function publicationCount() external view returns (uint256);

    function policyCount() external view returns (uint256);

    function ownerRecipient() external view returns (address);

    function aiExpenseRecipient() external view returns (address);

    /// @notice f(P) under a policy.
    function saleFee(uint256 policyId, uint256 price) external view returns (uint256);

    /// @notice D, F and O the deposit would settle to under AuthorRefund with current A and R.
    function previewSettlement(uint256 publicationId)
        external
        view
        returns (uint256 retained, uint256 authorRefund, uint256 ownerAllocation);

    function creditOf(address account) external view returns (uint256);

    function isQuoteNonceUsed(uint256 nonce) external view returns (bool);

    function isCertificateNonceUsed(uint256 nonce) external view returns (bool);

    function isJobIdUsed(bytes32 jobId) external view returns (bool);

    function isRequestIdUsed(bytes32 requestId) external view returns (bool);

    /// @notice Sum of all unwithdrawn credits.
    function totalCredits() external view returns (uint256);

    /// @notice Sum over unsettled publications of S - A (deposit not yet converted to credits).
    function totalLockedDeposits() external view returns (uint256);

    /// @notice totalCredits() + totalLockedDeposits().
    function totalLiabilities() external view returns (uint256);

    /// @notice True when address(this).balance >= totalLiabilities().
    function liabilitiesCovered() external view returns (bool);
}
