// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IConsentCraftMarketTypes} from "./interfaces/IConsentCraftMarketTypes.sol";

/// @title ConsentCraftMarket
/// @notice Contract layer for the ConsentCraft paid comic marketplace on Sepolia.
/// @dev Implementation status: policies, roles, recipients, pausing, liability
/// accounting, publication creation, review reports, appeals, rejection/timeout
/// settlement, publishing, purchases, threshold settlement and reading access.
/// Refunds and withdrawals are not implemented yet; see docs/CONTRACT_SPEC.md.
/// Once they are, this contract inherits IConsentCraftMarket instead of the types-only base.
contract ConsentCraftMarket is IConsentCraftMarketTypes, AccessControl, Pausable, EIP712 {
    // ---------------------------------------------------------------------
    // Roles and EIP-712 type hashes
    // ---------------------------------------------------------------------

    bytes32 public constant QUOTE_SIGNER_ROLE = keccak256("QUOTE_SIGNER_ROLE");
    bytes32 public constant REPORTER_ROLE = keccak256("REPORTER_ROLE");
    bytes32 public constant REVIEWER_ROLE = keccak256("REVIEWER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    bytes32 public constant PUBLICATION_QUOTE_TYPEHASH = keccak256(
        "PublicationQuote(address author,bytes32 manifestHash,bytes32 previewManifestHash,bytes32 arweaveBundleTxId,bytes32 arweavePreviewTxId,uint32 pageCount,uint256 policyId,uint256 price,uint256 deposit,uint256 aiCap,uint8 ratingSnapshot,uint64 expiresAt,uint256 nonce)"
    );

    bytes32 public constant PERSONHOOD_CERTIFICATE_TYPEHASH =
        keccak256("PersonhoodCertificate(address wallet,uint8 action,uint64 expiresAt,uint256 nonce)");

    bytes32 public constant REVIEW_REPORT_TYPEHASH = keccak256(
        "ReviewReport(uint256 publicationId,bytes32 manifestHash,bytes32 arweaveBundleTxId,bytes32 reportHash,bytes32 modelVersion,bytes32 promptVersion,uint256 policyId,uint16 score,bool flagged,uint256 aiCost,bytes32 jobId)"
    );

    uint16 private constant MAX_BPS = 10_000;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    address public ownerRecipient;
    address public aiExpenseRecipient;

    uint256 public policyCount;
    uint256 public publicationCount;

    /// @notice Sum of all unwithdrawn credits.
    uint256 public totalCredits;
    /// @notice Sum over unsettled publications of S - A.
    uint256 public totalLockedDeposits;

    mapping(uint256 policyId => Policy) private _policies;
    mapping(uint256 publicationId => Publication) private _publications;
    mapping(address account => uint256) private _credits;
    mapping(uint256 nonce => bool) private _quoteNonceUsed;
    mapping(uint256 nonce => bool) private _certificateNonceUsed;
    mapping(bytes32 jobId => bool) private _jobIdUsed;
    mapping(bytes32 requestId => bool) private _requestIdUsed;
    /// @dev Non-transferable reading entitlements. There is no function that removes one.
    mapping(uint256 publicationId => mapping(address wallet => bool)) private _entitled;

    // ---------------------------------------------------------------------
    // Construction and direct-payment rejection
    // ---------------------------------------------------------------------

    constructor(address admin, address ownerRecipient_, address aiExpenseRecipient_)
        EIP712("ConsentCraftMarket", "1")
    {
        if (admin == address(0) || ownerRecipient_ == address(0) || aiExpenseRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        ownerRecipient = ownerRecipient_;
        aiExpenseRecipient = aiExpenseRecipient_;
        emit OwnerRecipientUpdated(address(0), ownerRecipient_);
        emit AiExpenseRecipientUpdated(address(0), aiExpenseRecipient_);
    }

    /// @notice Plain ETH transfers are rejected; funds enter only through payable functions.
    receive() external payable {
        revert DirectPaymentRejected();
    }

    /// @notice Unknown calls, with or without value, are rejected.
    fallback() external payable {
        revert DirectPaymentRejected();
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /// @notice Appends an immutable policy. There is no function that modifies one.
    function createPolicy(Policy calldata policy) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 policyId) {
        if (
            policy.feeBps > MAX_BPS || policy.minPrice <= policy.minFee || policy.maxPrice < policy.minPrice
                || policy.appealDuration == 0 || policy.appealResolutionDuration == 0 || policy.refundDelay == 0
        ) {
            revert InvalidPolicy();
        }

        policyId = ++policyCount;
        _policies[policyId] = policy;

        emit PolicyCreated(
            policyId,
            policy.minFee,
            policy.feeBps,
            policy.minPrice,
            policy.maxPrice,
            policy.appealDuration,
            policy.appealResolutionDuration,
            policy.refundDelay,
            policy.purchaseRequiresPersonhood
        );
    }

    function setOwnerRecipient(address newRecipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit OwnerRecipientUpdated(ownerRecipient, newRecipient);
        ownerRecipient = newRecipient;
    }

    function setAiExpenseRecipient(address newRecipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit AiExpenseRecipientUpdated(aiExpenseRecipient, newRecipient);
        aiExpenseRecipient = newRecipient;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Publication creation
    // ---------------------------------------------------------------------

    function createPublication(
        PublicationQuote calldata quote,
        bytes calldata quoteSignature,
        PersonhoodCertificate calldata certificate,
        bytes calldata certificateSignature
    ) external payable whenNotPaused returns (uint256 publicationId) {
        // Quote authenticity and freshness.
        if (quote.author != msg.sender) revert QuoteAuthorMismatch(quote.author, msg.sender);
        if (block.timestamp > quote.expiresAt) revert QuoteExpired(quote.expiresAt);
        if (_quoteNonceUsed[quote.nonce]) revert QuoteNonceUsed(quote.nonce);
        if (
            !_hasRoleSignature(
                QUOTE_SIGNER_ROLE, _hashTypedDataV4(keccak256(abi.encode(PUBLICATION_QUOTE_TYPEHASH, quote))), quoteSignature
            )
        ) {
            revert InvalidQuoteSignature();
        }

        // Personhood for the Publish action.
        _consumeCertificate(certificate, certificateSignature, PersonhoodAction.Publish);

        // Terms.
        Policy storage policy = _policies[quote.policyId];
        if (quote.policyId == 0 || quote.policyId > policyCount) revert UnknownPolicy(quote.policyId);
        if (quote.manifestHash == bytes32(0) || quote.previewManifestHash == bytes32(0)) revert ZeroManifestHash();
        if (quote.arweaveBundleTxId == bytes32(0) || quote.arweavePreviewTxId == bytes32(0)) revert ZeroArweaveTxId();
        if (quote.pageCount == 0) revert ZeroPageCount();
        if (quote.price < policy.minPrice || quote.price > policy.maxPrice) {
            revert PriceOutOfBounds(quote.price, policy.minPrice, policy.maxPrice);
        }
        if (quote.deposit <= quote.aiCap) revert InvalidDepositTerms(quote.deposit, quote.aiCap);
        if (msg.value != quote.deposit) revert DepositMismatch(quote.deposit, msg.value);

        // Effects.
        _quoteNonceUsed[quote.nonce] = true;
        publicationId = ++publicationCount;

        Publication storage p = _publications[publicationId];
        p.author = quote.author;
        p.policyId = quote.policyId;
        p.manifestHash = quote.manifestHash;
        p.previewManifestHash = quote.previewManifestHash;
        p.arweaveBundleTxId = quote.arweaveBundleTxId;
        p.arweavePreviewTxId = quote.arweavePreviewTxId;
        p.pageCount = quote.pageCount;
        p.ratingSnapshot = quote.ratingSnapshot;
        p.price = quote.price;
        p.deposit = quote.deposit;
        p.aiCap = quote.aiCap;
        p.createdAt = uint64(block.timestamp);
        // state = Deposited, listingState = Unlisted, settlementReason = None (zero values)

        totalLockedDeposits += quote.deposit;

        _emitPublicationCreated(publicationId, p);
    }

    // ---------------------------------------------------------------------
    // Review and appeals
    // ---------------------------------------------------------------------
    // None of these are pausable: pausing blocks only new deposits and purchases,
    // so it can never strand a publication mid-review or let a deadline pass unfairly.

    /// @notice Relays a REPORTER_ROLE-signed review report. Anyone may call.
    /// @dev A is recognized here exactly once: only a Deposited publication accepts a
    /// report and acceptance always leaves Deposited. Service errors never produce a
    /// signed report, so they leave the publication Deposited with no forfeiture.
    function submitReviewReport(uint256 publicationId, ReviewReport calldata report, bytes calldata signature)
        external
    {
        Publication storage p = _existing(publicationId);
        if (report.publicationId != publicationId) revert ReportPublicationMismatch(publicationId, report.publicationId);
        _requireState(publicationId, p, PublicationState.Deposited);
        if (_jobIdUsed[report.jobId]) revert ReportJobIdUsed(report.jobId);
        if (!_hasRoleSignature(REPORTER_ROLE, _hashTypedDataV4(keccak256(abi.encode(REVIEW_REPORT_TYPEHASH, report))), signature)) {
            revert InvalidReportSignature();
        }
        if (report.manifestHash != p.manifestHash) revert ReportManifestMismatch(publicationId);
        if (report.arweaveBundleTxId != p.arweaveBundleTxId) revert ReportArweaveTxIdMismatch(publicationId);
        if (report.policyId != p.policyId) revert ReportPolicyMismatch(publicationId, p.policyId, report.policyId);
        if (report.aiCost > p.aiCap) revert AiCostExceedsCap(report.aiCost, p.aiCap);

        _jobIdUsed[report.jobId] = true;
        uint64 nowTs = uint64(block.timestamp);
        p.aiCost = report.aiCost;
        p.reportHash = report.reportHash;
        p.score = report.score;
        p.reviewedAt = nowTs;

        // Recognize A once: move it from locked deposits to the AI expense recipient's credit.
        totalLockedDeposits -= report.aiCost;
        _credit(aiExpenseRecipient, publicationId, CreditKind.AiExpense, report.aiCost);

        emit ReviewReportSubmitted(
            publicationId,
            report.jobId,
            report.flagged,
            report.score,
            report.aiCost,
            report.reportHash,
            report.modelVersion,
            report.promptVersion
        );

        if (report.flagged) {
            p.flaggedAt = nowTs;
            p.appealDeadline = nowTs + _policies[p.policyId].appealDuration;
            _setState(publicationId, p, PublicationState.Flagged);
            emit PublicationFlagged(publicationId, nowTs, p.appealDeadline);
        } else {
            _approve(publicationId, p, ApprovalPath.Report);
        }
    }

    /// @notice Author appeals a flag strictly before appealDeadline.
    function appeal(uint256 publicationId, bytes32 evidenceHash) external {
        Publication storage p = _existing(publicationId);
        if (msg.sender != p.author) revert NotAuthor(publicationId, msg.sender);
        _requireState(publicationId, p, PublicationState.Flagged);
        if (block.timestamp >= p.appealDeadline) revert AppealWindowClosed(publicationId, p.appealDeadline);

        uint64 nowTs = uint64(block.timestamp);
        p.appealedAt = nowTs;
        p.appealResolutionDeadline = nowTs + _policies[p.policyId].appealResolutionDuration;
        _setState(publicationId, p, PublicationState.AppealPending);
        emit AppealFiled(publicationId, evidenceHash, p.appealResolutionDeadline);
    }

    /// @notice REVIEWER_ROLE decides an appeal strictly before appealResolutionDeadline.
    /// Upholding the rejection forfeits S - A to the owner (report: confirmed rule).
    function resolveAppeal(uint256 publicationId, bool approved, bytes32 reasonHash)
        external
        onlyRole(REVIEWER_ROLE)
    {
        Publication storage p = _existing(publicationId);
        _requireState(publicationId, p, PublicationState.AppealPending);
        if (block.timestamp >= p.appealResolutionDeadline) {
            revert ResolutionWindowClosed(publicationId, p.appealResolutionDeadline);
        }

        emit AppealResolved(publicationId, msg.sender, approved, reasonHash);
        if (approved) {
            _approve(publicationId, p, ApprovalPath.Appeal);
        } else {
            _reject(publicationId, p, SettlementReason.Rejected);
        }
    }

    /// @notice Anyone may finalize an unappealed flag at or after appealDeadline.
    /// Forfeits S - A to the owner (report: confirmed rule).
    function finalizeRejection(uint256 publicationId) external {
        Publication storage p = _existing(publicationId);
        _requireState(publicationId, p, PublicationState.Flagged);
        if (block.timestamp < p.appealDeadline) revert AppealWindowOpen(publicationId, p.appealDeadline);
        _reject(publicationId, p, SettlementReason.Rejected);
    }

    /// @notice Anyone may claim the timeout fallback at or after appealResolutionDeadline.
    /// @dev PRODUCT APPROVAL NEEDED: returning S - A to the author when the platform
    /// fails to decide in time is the report's *recommended* fallback, not a confirmed
    /// rule (report §8 item 31, §12 "Missed appeal resolution"). Change before any
    /// real-value deployment if product decides otherwise.
    function claimAppealTimeout(uint256 publicationId) external {
        Publication storage p = _existing(publicationId);
        _requireState(publicationId, p, PublicationState.AppealPending);
        if (block.timestamp < p.appealResolutionDeadline) {
            revert ResolutionWindowOpen(publicationId, p.appealResolutionDeadline);
        }
        _reject(publicationId, p, SettlementReason.AppealTimeout);
    }

    // ---------------------------------------------------------------------
    // Publishing and purchases
    // ---------------------------------------------------------------------

    /// @notice Author lists an Approved publication. Not pausable: it creates no new exposure.
    /// @dev Approved is reachable only once and publish leaves it, so publishedAt is set once.
    function publish(uint256 publicationId) external {
        Publication storage p = _existing(publicationId);
        if (msg.sender != p.author) revert NotAuthor(publicationId, msg.sender);
        _requireState(publicationId, p, PublicationState.Approved);
        if (p.listingState != ListingState.Unlisted) revert InvalidListingState(publicationId, p.listingState);

        uint64 nowTs = uint64(block.timestamp);
        p.publishedAt = nowTs;
        p.refundEligibleAt = nowTs + _policies[p.policyId].refundDelay;
        p.listingState = ListingState.Listed;
        _setState(publicationId, p, PublicationState.Published);
        emit PublicationPublished(publicationId, p.price, p.refundEligibleAt);
    }

    /// @notice Buys one non-transferable reading entitlement at the frozen price.
    /// @dev Effects only (credits), no external calls. The certificate is checked and
    /// consumed only when the frozen policy requires personhood; otherwise it is ignored.
    function purchase(
        uint256 publicationId,
        bytes32 requestId,
        PersonhoodCertificate calldata certificate,
        bytes calldata certificateSignature
    ) external payable whenNotPaused {
        Publication storage p = _existing(publicationId);
        _requireState(publicationId, p, PublicationState.Published);
        if (p.listingState != ListingState.Listed) revert InvalidListingState(publicationId, p.listingState);
        if (msg.value != p.price) revert PaymentMismatch(p.price, msg.value);
        if (requestId == bytes32(0)) revert ZeroRequestId();
        if (_requestIdUsed[requestId]) revert RequestIdAlreadyUsed(requestId);
        if (_entitled[publicationId][msg.sender]) revert AlreadyEntitled(publicationId, msg.sender);
        if (_policies[p.policyId].purchaseRequiresPersonhood) {
            _consumeCertificate(certificate, certificateSignature, PersonhoodAction.Purchase);
        }

        _requestIdUsed[requestId] = true;
        _entitled[publicationId][msg.sender] = true;
        uint256 price = msg.value;
        uint256 fee = _saleFee(_policies[p.policyId], price);
        p.grossSales += price;

        emit Purchased(publicationId, msg.sender, requestId, price, fee, price - fee, p.grossSales);
        _credit(ownerRecipient, publicationId, CreditKind.PlatformFee, fee);
        _credit(p.author, publicationId, CreditKind.SaleProceeds, price - fee);

        // Threshold settlement: once R >= S, the remaining deposit S - A goes to the owner,
        // exactly once (the settlementReason guard). The listing stays active.
        if (p.settlementReason == SettlementReason.None && p.grossSales >= p.deposit) {
            _settle(publicationId, p, SettlementReason.ThresholdReached, 0, p.deposit - p.aiCost);
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        if (policyId == 0 || policyId > policyCount) revert UnknownPolicy(policyId);
        return _policies[policyId];
    }

    function getPublication(uint256 publicationId) external view returns (Publication memory) {
        return _existing(publicationId);
    }

    function creditOf(address account) external view returns (uint256) {
        return _credits[account];
    }

    function totalLiabilities() public view returns (uint256) {
        return totalCredits + totalLockedDeposits;
    }

    function liabilitiesCovered() external view returns (bool) {
        return address(this).balance >= totalLiabilities();
    }

    function isQuoteNonceUsed(uint256 nonce) external view returns (bool) {
        return _quoteNonceUsed[nonce];
    }

    function isCertificateNonceUsed(uint256 nonce) external view returns (bool) {
        return _certificateNonceUsed[nonce];
    }

    function isJobIdUsed(bytes32 jobId) external view returns (bool) {
        return _jobIdUsed[jobId];
    }

    function isRequestIdUsed(bytes32 requestId) external view returns (bool) {
        return _requestIdUsed[requestId];
    }

    /// @notice True when `wallet` bought `publicationId`. Entitlements are never revoked,
    /// so this stays true after delisting. Authors read their own work via the backend's
    /// author check unless they buy a copy.
    function hasReadingAccess(uint256 publicationId, address wallet) external view returns (bool) {
        return _entitled[publicationId][wallet];
    }

    /// @notice f(P) = max(minFee, floor(P * feeBps / 10000)) under a policy.
    function saleFee(uint256 policyId, uint256 price) external view returns (uint256) {
        if (policyId == 0 || policyId > policyCount) revert UnknownPolicy(policyId);
        return _saleFee(_policies[policyId], price);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /// @dev Emits from storage to keep createPublication's stack shallow without viaIR.
    function _emitPublicationCreated(uint256 publicationId, Publication storage p) private {
        emit PublicationCreated(
            publicationId,
            p.author,
            p.policyId,
            p.manifestHash,
            p.previewManifestHash,
            p.arweaveBundleTxId,
            p.arweavePreviewTxId,
            p.pageCount,
            p.price,
            p.deposit,
            p.aiCap
        );
    }

    /// @dev Checks and consumes a single-use certificate for msg.sender and `action`.
    function _consumeCertificate(
        PersonhoodCertificate calldata certificate,
        bytes calldata signature,
        PersonhoodAction action
    ) internal {
        if (certificate.wallet != msg.sender) revert CertificateWalletMismatch(certificate.wallet, msg.sender);
        if (certificate.action != action) revert CertificateActionMismatch(action, certificate.action);
        if (block.timestamp > certificate.expiresAt) revert CertificateExpired(certificate.expiresAt);
        if (_certificateNonceUsed[certificate.nonce]) revert CertificateNonceUsed(certificate.nonce);
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(PERSONHOOD_CERTIFICATE_TYPEHASH, certificate)));
        if (!_hasRoleSignature(QUOTE_SIGNER_ROLE, digest, signature)) revert InvalidCertificateSignature();
        _certificateNonceUsed[certificate.nonce] = true;
    }

    /// @dev True when `signature` over `digest` recovers to a current holder of `role`.
    /// Malformed signatures return false instead of bubbling an ECDSA error.
    function _hasRoleSignature(bytes32 role, bytes32 digest, bytes calldata signature) internal view returns (bool) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        return err == ECDSA.RecoverError.NoError && hasRole(role, signer);
    }

    /// @dev f(P) <= P for every listed price, because feeBps <= 10000 and price >= minPrice > minFee.
    function _saleFee(Policy storage policy, uint256 price) private view returns (uint256) {
        uint256 proportional = (price * policy.feeBps) / MAX_BPS;
        return proportional > policy.minFee ? proportional : policy.minFee;
    }

    function _existing(uint256 publicationId) private view returns (Publication storage) {
        if (publicationId == 0 || publicationId > publicationCount) revert UnknownPublication(publicationId);
        return _publications[publicationId];
    }

    function _requireState(uint256 publicationId, Publication storage p, PublicationState expected) private view {
        if (p.state != expected) revert InvalidPublicationState(publicationId, p.state);
    }

    function _setState(uint256 publicationId, Publication storage p, PublicationState next) private {
        emit ReviewStatusChanged(publicationId, p.state, next);
        p.state = next;
    }

    function _approve(uint256 publicationId, Publication storage p, ApprovalPath path) private {
        p.decidedAt = uint64(block.timestamp);
        _setState(publicationId, p, PublicationState.Approved);
        emit PublicationApproved(publicationId, path);
    }

    /// @dev Final rejection. Rejected: F = 0, O = S - A. AppealTimeout: F = S - A, O = 0.
    function _reject(uint256 publicationId, Publication storage p, SettlementReason reason) private {
        p.decidedAt = uint64(block.timestamp);
        _setState(publicationId, p, PublicationState.Rejected);
        emit PublicationRejected(publicationId, reason);

        uint256 remainder = p.deposit - p.aiCost;
        if (reason == SettlementReason.AppealTimeout) {
            _settle(publicationId, p, reason, remainder, 0);
        } else {
            _settle(publicationId, p, reason, 0, remainder);
        }
    }

    /// @dev Settles the deposit exactly once. Requires F + O == S - A (A already credited).
    function _settle(
        uint256 publicationId,
        Publication storage p,
        SettlementReason reason,
        uint256 authorRefund,
        uint256 ownerAllocation
    ) private {
        if (p.settlementReason != SettlementReason.None) revert DepositAlreadySettled(publicationId, p.settlementReason);
        assert(p.aiCost + authorRefund + ownerAllocation == p.deposit);

        p.settlementReason = reason;
        p.authorRefund = authorRefund;
        p.ownerAllocation = ownerAllocation;
        p.settledAt = uint64(block.timestamp);
        totalLockedDeposits -= authorRefund + ownerAllocation;

        _credit(p.author, publicationId, CreditKind.DepositRefund, authorRefund);
        _credit(ownerRecipient, publicationId, CreditKind.OwnerAllocation, ownerAllocation);
        emit DepositSettled(publicationId, reason, p.deposit, p.aiCost, authorRefund, ownerAllocation, p.grossSales);
    }

    /// @dev Adds a withdrawable credit. Zero amounts are skipped and emit nothing.
    function _credit(address account, uint256 publicationId, CreditKind kind, uint256 amount) private {
        if (amount == 0) return;
        _credits[account] += amount;
        totalCredits += amount;
        emit Credited(account, publicationId, kind, amount);
    }
}
