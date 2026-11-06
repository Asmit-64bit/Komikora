// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title ComicRatingRegistry
/// @notice Stores comic pointers and immutable AI jury ratings.
/// @dev A trusted relayer posts attested off-chain results; this contract does not verify TEE attestations.
contract ComicRatingRegistry is AccessControl, Pausable {
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    uint8 public constant MAX_JURORS = 9;

    struct Comic { bytes32 comicHash; bytes32 arkivKey; string arweaveId; }
    struct Rating {
        address relayer;
        uint64 timestamp;
        uint8 finalScore;
        uint8 spread;
        bytes32 evidenceHash;
        string evidenceURI;
        bytes32[] jurorModelIds;
        uint8[] jurorScores;
    }

    uint256 public comicCount;
    uint8 public minimumPanelSize;
    mapping(uint256 => Comic) private _comics;
    mapping(uint256 => mapping(uint256 => Rating)) private _ratings;
    mapping(uint256 => uint256) private _latestVersion;
    mapping(uint256 => bool) private _hasRating;

    error ZeroAddress();
    error InvalidPanelSize();
    error ComicNotFound();
    error RatingNotFound();
    error RatingAlreadyExists();
    error ArrayLengthMismatch();
    error InvalidScore();
    error DuplicateJuror();

    event ComicSubmitted(uint256 indexed comicId, bytes32 comicHash, string arweaveId, bytes32 arkivKey, address indexed submitter);
    event RatingPosted(uint256 indexed comicId, uint256 indexed rubricVersion, uint8 finalScore, uint8 spread, address indexed relayer);
    event MinimumPanelSizeUpdated(uint8 previousSize, uint8 newSize);

    constructor(address admin, address relayer, uint8 minimumPanelSize_) {
        if (admin == address(0) || relayer == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RELAYER_ROLE, relayer);
        _setMinimumPanelSize(minimumPanelSize_);
    }

    function setMinimumPanelSize(uint8 size) external onlyRole(DEFAULT_ADMIN_ROLE) { _setMinimumPanelSize(size); }
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    function _setMinimumPanelSize(uint8 size) private {
        if (size == 0 || size > MAX_JURORS) revert InvalidPanelSize();
        emit MinimumPanelSizeUpdated(minimumPanelSize, size);
        minimumPanelSize = size;
    }

    function submitComic(bytes32 comicHash, string calldata arweaveId, bytes32 arkivKey)
        external whenNotPaused returns (uint256 comicId)
    {
        comicId = ++comicCount;
        _comics[comicId] = Comic(comicHash, arkivKey, arweaveId);
        emit ComicSubmitted(comicId, comicHash, arweaveId, arkivKey, msg.sender);
    }

    /// @dev Even-sized panels use the arithmetic mean of the two middle scores, rounded down.
    /// Latest means most recently posted, independent of the numeric rubric version.
    function postRating(uint256 comicId, uint256 rubricVersion, bytes32[] calldata jurorModelIds,
        uint8[] calldata jurorScores, bytes32 evidenceHash, string calldata evidenceURI)
        external onlyRole(RELAYER_ROLE) whenNotPaused
    {
        if (comicId == 0 || comicId > comicCount) revert ComicNotFound();
        Rating storage rating = _ratings[comicId][rubricVersion];
        if (rating.relayer != address(0)) revert RatingAlreadyExists();
        (uint8 median, uint8 spread) = _calculate(jurorModelIds, jurorScores);
        rating.relayer = msg.sender;
        rating.timestamp = uint64(block.timestamp);
        rating.finalScore = median;
        rating.spread = spread;
        rating.evidenceHash = evidenceHash;
        rating.evidenceURI = evidenceURI;
        rating.jurorModelIds = jurorModelIds;
        rating.jurorScores = jurorScores;
        _latestVersion[comicId] = rubricVersion;
        _hasRating[comicId] = true;
        emit RatingPosted(comicId, rubricVersion, median, spread, msg.sender);
    }

    function _calculate(bytes32[] calldata jurorModelIds, uint8[] calldata jurorScores)
        private view returns (uint8 median, uint8 spread)
    {
        uint256 n = jurorModelIds.length;
        if (n != jurorScores.length) revert ArrayLengthMismatch();
        if (n < minimumPanelSize || n > MAX_JURORS) revert InvalidPanelSize();
        uint8[] memory sorted = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            if (jurorScores[i] > 100) revert InvalidScore();
            for (uint256 j; j < i; ++j) if (jurorModelIds[i] == jurorModelIds[j]) revert DuplicateJuror();
            uint256 k = i;
            while (k > 0 && sorted[k - 1] > jurorScores[i]) { sorted[k] = sorted[k - 1]; --k; }
            sorted[k] = jurorScores[i];
        }
        median = n % 2 == 1 ? sorted[n / 2] : uint8((uint16(sorted[n / 2 - 1]) + sorted[n / 2]) / 2);
        spread = sorted[n - 1] - sorted[0];
    }

    function getComic(uint256 comicId) external view returns (Comic memory) {
        if (comicId == 0 || comicId > comicCount) revert ComicNotFound();
        return _comics[comicId];
    }

    function getRating(uint256 comicId, uint256 rubricVersion) public view returns (Rating memory) {
        Rating storage rating = _ratings[comicId][rubricVersion];
        if (rating.relayer == address(0)) revert RatingNotFound();
        return rating;
    }

    function getLatestRating(uint256 comicId) external view returns (uint256 rubricVersion, Rating memory rating) {
        if (!_hasRating[comicId]) revert RatingNotFound();
        rubricVersion = _latestVersion[comicId];
        return (rubricVersion, getRating(comicId, rubricVersion));
    }
}
