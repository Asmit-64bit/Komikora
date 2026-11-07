// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ConsentCraftReading} from "./ConsentCraftReading.sol";
import {ComicHeirloom} from "./ComicHeirloom.sol";

/// @title ConsentCraftReadingHeirloom
/// @notice Reading marketplace with optional inactivity-based succession.
/// @dev A new deployment is required. Original credits and contributor allocations
/// stay attributed to their wallet; heirs withdraw only its frozen inheritance split.
contract ConsentCraftReadingHeirloom is ConsentCraftReading, ComicHeirloom {
    mapping(address => uint256) public lifetimeCredits;
    mapping(address => uint256) public inheritanceCreditOffset;
    mapping(address => mapping(address => uint256)) public inheritedWithdrawn;
    mapping(address => mapping(uint256 => mapping(address => bool))) public readingInheritanceClaimed;

    event ReadingInherited(uint256 indexed comicId, address indexed from, address indexed heir);
    event InheritedProceedsWithdrawn(address indexed from, address indexed heir, address indexed recipient, uint256 amount);

    constructor(address signer, address recipient) ConsentCraftReading(signer, recipient) {}

    /// @notice Every positive-share heir may claim the original wallet's reading access.
    /// @dev Access is granted explicitly in bounded batches; authorship is never changed.
    function inheritReading(address from, uint256[] calldata comicIds) external nonReentrant {
        if (!inheritancePlans[from].finalized || heirBps[from][msg.sender] == 0) revert InheritanceUnauthorized();
        if (comicIds.length == 0 || comicIds.length > 50) revert InvalidInheritancePlan();
        _touch(msg.sender);
        for (uint256 i; i < comicIds.length; ++i) {
            uint256 id = comicIds[i];
            if (comics[id].author == address(0) || !(purchased[id][from] || isContributor[id][from]) || readingInheritanceClaimed[from][id][msg.sender]) revert Unavailable();
            readingInheritanceClaimed[from][id][msg.sender] = true;
            purchased[id][msg.sender] = true;
            emit ReadingInherited(id, from, msg.sender);
        }
    }
    function canRead(uint256 id, address reader) public view override returns (bool) {
        return !inheritancePlans[reader].finalized && super.canRead(id, reader);
    }
    /// @notice Includes unwithdrawn proceeds at finalization and all later proceeds.
    /// @dev Cumulative floor rounding prevents double claims; less than one wei per
    /// heir may remain as dust. An heir may withdraw to another recipient if needed.
    function claimableInheritedProceeds(address from, address heir) public view returns (uint256) {
        if (!inheritancePlans[from].finalized || heirBps[from][heir] == 0) return 0;
        uint256 entitled = Math.mulDiv(lifetimeCredits[from] - inheritanceCreditOffset[from], heirBps[from][heir], 10_000);
        return entitled - inheritedWithdrawn[from][heir];
    }
    function withdrawInheritedProceeds(address from, address payable recipient) external nonReentrant {
        if (recipient == address(0)) revert Invalid();
        uint256 amount = claimableInheritedProceeds(from, msg.sender);
        if (amount == 0) revert Unavailable();
        _touch(msg.sender);
        inheritedWithdrawn[from][msg.sender] += amount;
        credits[from] -= amount; totalCredits -= amount;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert Unavailable();
        emit InheritedProceedsWithdrawn(from, msg.sender, recipient, amount);
    }
    function _credit(address account, uint256 amount) internal override {
        lifetimeCredits[account] += amount;
        super._credit(account, amount);
    }
    function _onActivity(address account) internal override { _touch(account); }
    function _onInheritanceFinalized(address owner) internal override {
        inheritanceCreditOffset[owner] = lifetimeCredits[owner] - credits[owner];
    }
}
