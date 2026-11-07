// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Fixed-price, non-transferable reading access. Every contributor must
/// approve the content, license, price and revenue split before publication.
contract ConsentCraftReading is EIP712, ReentrancyGuard {
    struct Permit {
        address author; bytes32 key; bytes32 contentHash; bytes32 manifestHash;
        bytes32 metadataHash; bytes32 uriHash; bytes32 licenseHash;
        bytes32 contributorsHash; uint256 price; uint64 approvalDeadline; uint64 deadline;
    }
    struct Team { address[] people; uint16[] allocations; bytes[] approvals; }
    struct Comic {
        address author; bytes32 key; bytes32 contentHash; bytes32 manifestHash;
        bytes32 metadataHash; bytes32 licenseHash; bytes32 contributorsHash;
        uint256 price; string uri; uint256 readers;
    }
    bytes32 public constant APPROVAL_TYPEHASH = keccak256("TeamApproval(bytes32 key,bytes32 contentHash,bytes32 licenseHash,bytes32 contributorsHash,uint256 price,uint64 approvalDeadline)");
    bytes32 public constant PERMIT_TYPEHASH = keccak256("Permit(address author,bytes32 key,bytes32 contentHash,bytes32 manifestHash,bytes32 metadataHash,bytes32 uriHash,bytes32 licenseHash,bytes32 contributorsHash,uint256 price,uint64 approvalDeadline,uint64 deadline)");
    address public immutable reviewer;
    address public immutable treasury;
    uint256 public constant FEE_BPS = 250;
    uint256 public comicCount;
    uint256 public totalCredits;
    mapping(uint256 => Comic) public comics;
    mapping(bytes32 => uint256) public comicForKey;
    mapping(uint256 => address[]) private contributors;
    mapping(uint256 => uint16[]) private shares;
    mapping(uint256 => mapping(address => bool)) public isContributor;
    mapping(uint256 => mapping(address => bool)) public purchased;
    mapping(address => mapping(bytes32 => bool)) public revokedApprovals;
    mapping(uint256 => bool) public delisted;
    mapping(address => uint256) public credits;
    event ComicPublished(uint256 indexed comicId, bytes32 indexed key, address indexed author, uint256 price, string uri);
    event ReadingPurchased(uint256 indexed comicId, address indexed reader, uint256 price);
    event ApprovalRevoked(address indexed contributor, bytes32 indexed key);
    event Delisted(uint256 indexed comicId, bool value);
    event Withdrawn(address indexed account, address indexed recipient, uint256 amount);
    error Invalid(); error Unauthorized(); error Unavailable(); error AlreadyPurchased(); error WrongValue();

    constructor(address signer, address recipient) EIP712("ConsentCraftReading", "1") {
        if (signer == address(0) || recipient == address(0)) revert Invalid();
        reviewer = signer; treasury = recipient;
    }
    function revokeApproval(bytes32 key) external {
        _onActivity(msg.sender);
        revokedApprovals[msg.sender][key] = true;
        emit ApprovalRevoked(msg.sender, key);
    }
    function publishComic(Permit calldata p, string calldata uri, Team calldata team, bytes calldata reviewSignature) external nonReentrant returns(uint256 id) {
        _onActivity(msg.sender);
        if (msg.sender != p.author || team.people.length == 0 || team.people.length > 64 || team.people[0] != p.author) revert Unauthorized();
        if (team.people.length != team.allocations.length || team.people.length != team.approvals.length || p.price == 0 || p.key == 0 || p.contentHash == 0 || p.manifestHash == 0 || p.metadataHash == 0 || p.licenseHash == 0 || comicForKey[p.key] != 0 || p.deadline < block.timestamp || p.approvalDeadline < block.timestamp || bytes(uri).length < 6 || bytes(uri).length > 240 || keccak256(bytes(uri)) != p.uriHash || keccak256(abi.encode(team.people, team.allocations)) != p.contributorsHash) revert Invalid();
        bytes32 teamDigest = _hashTypedDataV4(keccak256(abi.encode(APPROVAL_TYPEHASH, p.key, p.contentHash, p.licenseHash, p.contributorsHash, p.price, p.approvalDeadline)));
        uint256 total;
        for (uint256 i; i < team.people.length; ++i) {
            if (team.people[i] == address(0) || revokedApprovals[team.people[i]][p.key]) revert Unauthorized();
            for (uint256 j; j < i; ++j) if (team.people[i] == team.people[j]) revert Invalid();
            if (!SignatureChecker.isValidSignatureNow(team.people[i], teamDigest, team.approvals[i])) revert Unauthorized();
            total += team.allocations[i];
        }
        if (total != 10000) revert Invalid();
        bytes32 permitDigest = _hashTypedDataV4(keccak256(abi.encode(PERMIT_TYPEHASH, p)));
        if (!SignatureChecker.isValidSignatureNow(reviewer, permitDigest, reviewSignature)) revert Unauthorized();
        id = ++comicCount;
        comics[id] = Comic(p.author, p.key, p.contentHash, p.manifestHash, p.metadataHash, p.licenseHash, p.contributorsHash, p.price, uri, 0);
        comicForKey[p.key] = id;
        contributors[id] = team.people; shares[id] = team.allocations;
        for (uint256 i; i < team.people.length; ++i) isContributor[id][team.people[i]] = true;
        emit ComicPublished(id, p.key, p.author, p.price, uri);
    }
    function buyReading(uint256 id) external payable nonReentrant {
        _onActivity(msg.sender);
        Comic storage c = comics[id];
        if (c.author == address(0) || delisted[id]) revert Unavailable();
        if (purchased[id][msg.sender] || isContributor[id][msg.sender]) revert AlreadyPurchased();
        if (msg.value != c.price) revert WrongValue();
        purchased[id][msg.sender] = true; ++c.readers;
        // Division before multiplication avoids overflow for arbitrary prices.
        uint256 fee = msg.value / 10000 * FEE_BPS + msg.value % 10000 * FEE_BPS / 10000;
        _credit(treasury, fee);
        uint256 net = msg.value - fee; uint256 distributed;
        for (uint256 i = 1; i < contributors[id].length; ++i) {
            uint256 amount = net / 10000 * shares[id][i] + net % 10000 * shares[id][i] / 10000;
            _credit(contributors[id][i], amount); distributed += amount;
        }
        _credit(contributors[id][0], net - distributed);
        totalCredits += msg.value;
        emit ReadingPurchased(id, msg.sender, msg.value);
    }
    function canRead(uint256 id, address reader) public view virtual returns(bool) {
        return comics[id].author != address(0) && reader != address(0) && (purchased[id][reader] || isContributor[id][reader]);
    }
    function getContributors(uint256 id) external view returns(address[] memory, uint16[] memory) { return (contributors[id], shares[id]); }
    function setDelisted(uint256 id, bool value) external {
        if (msg.sender != reviewer) revert Unauthorized();
        if (comics[id].author == address(0)) revert Invalid();
        delisted[id] = value; emit Delisted(id, value);
    }
    function withdraw(address payable recipient) external nonReentrant {
        _onActivity(msg.sender);
        uint256 amount = credits[msg.sender];
        if (amount == 0 || recipient == address(0)) revert Invalid();
        credits[msg.sender] = 0; totalCredits -= amount;
        (bool ok,) = recipient.call{value: amount}(""); if (!ok) revert Unavailable();
        emit Withdrawn(msg.sender, recipient, amount);
    }
    /// @dev Extension hooks preserve the original marketplace behavior by default.
    function _credit(address account, uint256 amount) internal virtual { credits[account] += amount; }
    function _onActivity(address account) internal virtual {}
}
