// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IWithdrawable {
    function withdraw() external;
}

/// @notice TEST ONLY. A credit holder whose receive() reverts while `accepting` is false.
contract RejectingRecipient {
    IWithdrawable public immutable market;
    bool public accepting;

    constructor(IWithdrawable market_) {
        market = market_;
    }

    function setAccepting(bool value) external {
        accepting = value;
    }

    function withdrawFromMarket() external {
        market.withdraw();
    }

    receive() external payable {
        require(accepting, "RejectingRecipient: rejected");
    }
}
