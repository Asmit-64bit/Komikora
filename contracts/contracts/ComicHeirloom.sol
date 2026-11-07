// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ComicHeirloom
/// @notice Wallet-selected heirs may claim after inactivity and a challenge period.
/// @dev Adapts the timer, challenge and guardian pattern from the user-supplied
/// HeirloomVault. Inactivity is not proof of death. No custody or external calls here.
abstract contract ComicHeirloom {
    uint8 public constant MAX_HEIRS = 8;
    uint8 public constant MAX_GUARDIAN_VETOES = 2;
    uint64 public constant MIN_INACTIVITY = 30 days;
    uint64 public constant MAX_INACTIVITY = 10 * 365 days;
    uint64 public constant MIN_CHALLENGE = 7 days;
    uint64 public constant MAX_CHALLENGE = 90 days;

    struct InheritancePlan {
        uint64 lastActivity;
        uint64 inactivityPeriod;
        uint64 challengePeriod;
        uint64 claimStartedAt;
        address guardian;
        uint8 vetoesUsed;
        bool configured;
        bool finalized;
    }
    mapping(address owner => InheritancePlan) public inheritancePlans;
    mapping(address owner => address[]) private _heirs;
    mapping(address owner => mapping(address heir => uint16)) public heirBps;

    error InvalidInheritancePlan();
    error InheritanceUnauthorized();
    error InheritanceNotReady();
    error InheritanceFinalized();
    event InheritanceConfigured(address indexed owner, address[] heirs, uint16[] allocations, address guardian, uint64 inactivityPeriod, uint64 challengePeriod);
    event InheritanceDisabled(address indexed owner);
    event InheritanceCheckIn(address indexed owner, uint64 at);
    event InheritanceClaimStarted(address indexed owner, address indexed heir, uint64 at);
    event InheritanceClaimCancelled(address indexed owner, address indexed actor);
    event InheritanceVetoed(address indexed owner, address indexed guardian, uint8 vetoesUsed);
    event InheritanceActivated(address indexed owner);

    function heirloomVersion() external pure returns (uint256) { return 1; }
    function getHeirs(address owner) external view returns (address[] memory heirs, uint16[] memory allocations) {
        heirs = _heirs[owner]; allocations = new uint16[](heirs.length);
        for (uint256 i; i < heirs.length; ++i) allocations[i] = heirBps[owner][heirs[i]];
    }

    /// @notice Opt in using a wallet transaction; shares must total 10,000 basis points.
    function configureInheritance(address[] calldata heirs, uint16[] calldata allocations, address guardian, uint64 inactivityPeriod, uint64 challengePeriod) external {
        if (inheritancePlans[msg.sender].finalized) revert InheritanceFinalized();
        if (heirs.length == 0 || heirs.length > MAX_HEIRS || heirs.length != allocations.length || guardian == msg.sender || inactivityPeriod < MIN_INACTIVITY || inactivityPeriod > MAX_INACTIVITY || challengePeriod < MIN_CHALLENGE || challengePeriod > MAX_CHALLENGE) revert InvalidInheritancePlan();
        // Validate before replacing the existing plan, including duplicate heirs.
        uint256 total;
        for (uint256 i; i < heirs.length; ++i) {
            if (heirs[i] == address(0) || heirs[i] == msg.sender || allocations[i] == 0) revert InvalidInheritancePlan();
            for (uint256 j; j < i; ++j) if (heirs[i] == heirs[j]) revert InvalidInheritancePlan();
            total += allocations[i];
        }
        if (total != 10_000) revert InvalidInheritancePlan();
        _clearHeirs(msg.sender);
        for (uint256 i; i < heirs.length; ++i) { _heirs[msg.sender].push(heirs[i]); heirBps[msg.sender][heirs[i]] = allocations[i]; }
        if (inheritancePlans[msg.sender].claimStartedAt != 0) emit InheritanceClaimCancelled(msg.sender, msg.sender);
        inheritancePlans[msg.sender] = InheritancePlan(uint64(block.timestamp), inactivityPeriod, challengePeriod, 0, guardian, 0, true, false);
        emit InheritanceConfigured(msg.sender, heirs, allocations, guardian, inactivityPeriod, challengePeriod);
    }
    function disableInheritance() external {
        InheritancePlan storage p = inheritancePlans[msg.sender];
        if (p.finalized) revert InheritanceFinalized();
        if (!p.configured) revert InvalidInheritancePlan();
        if (p.claimStartedAt != 0) emit InheritanceClaimCancelled(msg.sender, msg.sender);
        _clearHeirs(msg.sender); delete inheritancePlans[msg.sender];
        emit InheritanceDisabled(msg.sender);
    }
    function checkIn() external {
        if (!inheritancePlans[msg.sender].configured) revert InvalidInheritancePlan();
        _touch(msg.sender);
    }
    function startInheritanceClaim(address owner) external {
        InheritancePlan storage p = inheritancePlans[owner];
        if (heirBps[owner][msg.sender] == 0) revert InheritanceUnauthorized();
        if (!p.configured || p.finalized || p.claimStartedAt != 0 || block.timestamp < uint256(p.lastActivity) + p.inactivityPeriod) revert InheritanceNotReady();
        p.claimStartedAt = uint64(block.timestamp);
        emit InheritanceClaimStarted(owner, msg.sender, p.claimStartedAt);
    }
    /// @notice A guardian may cancel and restart the timer twice per configured plan.
    function vetoInheritanceClaim(address owner) external {
        InheritancePlan storage p = inheritancePlans[owner];
        if (!p.configured || p.finalized || msg.sender != p.guardian || p.vetoesUsed >= MAX_GUARDIAN_VETOES) revert InheritanceUnauthorized();
        ++p.vetoesUsed; _touch(owner);
        emit InheritanceVetoed(owner, msg.sender, p.vetoesUsed);
    }
    function finalizeInheritance(address owner) external {
        InheritancePlan storage p = inheritancePlans[owner];
        if (heirBps[owner][msg.sender] == 0) revert InheritanceUnauthorized();
        if (!p.configured || p.finalized || p.claimStartedAt == 0 || block.timestamp < uint256(p.claimStartedAt) + p.challengePeriod) revert InheritanceNotReady();
        p.finalized = true;
        _onInheritanceFinalized(owner);
        emit InheritanceActivated(owner);
    }
    function _touch(address owner) internal {
        InheritancePlan storage p = inheritancePlans[owner];
        if (p.finalized) revert InheritanceFinalized();
        if (!p.configured) return;
        p.lastActivity = uint64(block.timestamp);
        if (p.claimStartedAt != 0) { p.claimStartedAt = 0; emit InheritanceClaimCancelled(owner, owner); }
        emit InheritanceCheckIn(owner, p.lastActivity);
    }
    function _clearHeirs(address owner) private {
        address[] storage heirs = _heirs[owner];
        for (uint256 i; i < heirs.length; ++i) delete heirBps[owner][heirs[i]];
        delete _heirs[owner];
    }
    function _onInheritanceFinalized(address owner) internal virtual;
}
