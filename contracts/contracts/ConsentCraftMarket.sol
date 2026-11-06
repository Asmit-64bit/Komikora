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
/// accounting and publication creation. Review, appeals, publishing, purchases,
/// settlement and withdrawals are not implemented yet; see docs/CONTRACT_SPEC.md.
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
        if (!_isQuoteSigner(_hashTypedDataV4(keccak256(abi.encode(PUBLICATION_QUOTE_TYPEHASH, quote))), quoteSignature))
        {
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
    // Views
    // ---------------------------------------------------------------------

    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        if (policyId == 0 || policyId > policyCount) revert UnknownPolicy(policyId);
        return _policies[policyId];
    }

    function getPublication(uint256 publicationId) external view returns (Publication memory) {
        if (publicationId == 0 || publicationId > publicationCount) revert UnknownPublication(publicationId);
        return _publications[publicationId];
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
        if (!_isQuoteSigner(digest, signature)) revert InvalidCertificateSignature();
        _certificateNonceUsed[certificate.nonce] = true;
    }

    /// @dev True when `signature` over `digest` recovers to a current QUOTE_SIGNER_ROLE holder.
    /// Malformed signatures return false instead of bubbling an ECDSA error.
    function _isQuoteSigner(bytes32 digest, bytes calldata signature) internal view returns (bool) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        return err == ECDSA.RecoverError.NoError && hasRole(QUOTE_SIGNER_ROLE, signer);
    }
}
