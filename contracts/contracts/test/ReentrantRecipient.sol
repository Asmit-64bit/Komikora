// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IWithdrawable {
    function withdraw() external;
}

/// @notice TEST ONLY. A credit holder that tries to re-enter withdraw() from receive().
/// The re-entry failure is caught and recorded so the outer withdrawal can complete,
/// letting tests check that it was attempted, blocked, and paid out exactly once.
contract ReentrantRecipient {
    IWithdrawable public immutable market;
    uint256 public reentryAttempts;
    bytes public lastReentryError;

    constructor(IWithdrawable market_) {
        market = market_;
    }

    function withdrawFromMarket() external {
        market.withdraw();
    }

    receive() external payable {
        reentryAttempts += 1;
        try market.withdraw() {}
        catch (bytes memory reason) {
            lastReentryError = reason;
        }
    }
}
