// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Fixed supply editions. A signed review permit binds the exact content,
/// metadata, license and supply. No publishing deposit or AI forfeiture is required.
contract ConsentCraftEditions is ERC721, ERC2981, EIP712, ReentrancyGuard {
    struct Permit { address author; bytes32 key; bytes32 manifestHash; bytes32 metadataHash; bytes32 uriHash; bytes32 licenseHash; bytes32 auctionHash; uint16 supply; uint64 deadline; }
    struct Comic { address author; bytes32 key; bytes32 manifestHash; bytes32 metadataHash; bytes32 licenseHash; uint16 supply; string uri; bytes32 auctionHash; }
    struct Sale { uint256 firstPrice; uint256 latestPrice; uint256 auctionPrice; uint64 firstAt; uint64 latestAt; }
    struct Auction { address seller; address bidder; uint256 reserve; uint256 bid; uint64 end; uint64 hardEnd; bool active; }
    struct Ask { address seller; uint256 price; uint64 end; }
    struct Deal { address maker; uint256 token; uint256 value; uint64 end; bool active; }
    struct Offer { address maker; uint256 deal; uint256 token; uint256 topUp; bool active; }
    bytes32 public constant PERMIT_TYPEHASH = keccak256("Permit(address author,bytes32 key,bytes32 manifestHash,bytes32 metadataHash,bytes32 uriHash,bytes32 licenseHash,bytes32 auctionHash,uint16 supply,uint64 deadline)");
    address public immutable reviewer;
    address public immutable treasury;
    uint256 public constant FEE_BPS = 250;
    uint96 public constant ROYALTY_BPS = 500;
    uint256 public comicCount;
    uint256 public tokenCount;
    uint256 public dealCount;
    uint256 public offerCount;
    uint256 public lockedEth;
    uint256 public totalCredits;
    mapping(bytes32 => uint256) public comicForKey;
    mapping(uint256 => Comic) public comics;
    mapping(uint256 => uint256) public tokenComic;
    mapping(uint256 => Sale) public sales;
    mapping(uint256 => Auction) public auctions;
    mapping(uint256 => Ask) public asks;
    mapping(uint256 => Deal) public deals;
    mapping(uint256 => Offer) public offers;
    mapping(uint256 => address) public depositor;
    mapping(uint256 => bool) public delisted;
    mapping(address => uint256) public credits;
    // Completed-sale editions beneficially held, including auction/swap escrow.
    mapping(address => uint256) public qualifyingBalance;
    event ComicCreated(uint256 indexed comicId, bytes32 indexed key, address indexed author, uint16 supply, bytes32 manifestHash, bytes32 metadataHash, bytes32 licenseHash, string uri);
    event AuctionOpened(uint256 indexed tokenId, address indexed seller, uint256 reserve, uint64 end);
    event Bid(uint256 indexed tokenId, address indexed bidder, uint256 amount, uint64 end);
    event AuctionClosed(uint256 indexed tokenId);
    event Sold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 fee, uint256 royalty, bool primary, bool auction, uint64 at);
    event Asked(uint256 indexed tokenId, address indexed seller, uint256 price, uint64 end);
    event DealOpened(uint256 indexed dealId, uint256 indexed tokenId, address indexed maker, uint256 value, uint64 end);
    event Offered(uint256 indexed offerId, uint256 indexed dealId, uint256 indexed tokenId, address maker, uint256 topUp);
    event DealClosed(uint256 indexed dealId);
    event OfferClosed(uint256 indexed offerId);
    event Swapped(uint256 indexed offerId, uint256 indexed dealId);
    event Delisted(uint256 indexed comicId, bool value);
    event Withdrawn(address indexed owner, address indexed recipient, uint256 amount);
    error Invalid(); error Unauthorized(); error Unavailable(); error TooLow(uint256 minimum); error WrongValue(uint256 expected); error TradeLocked();
    constructor(address signer, address recipient) ERC721("ConsentCraft Editions", "COMIC") EIP712("ConsentCraftEditions", "1") {
        if (signer == address(0) || recipient == address(0)) revert Invalid(); reviewer = signer; treasury = recipient;
    }
    function createComic(Permit calldata p, string calldata uri, bytes calldata signature) external nonReentrant returns(uint256 id) {
        if (p.author != msg.sender) revert Unauthorized();
        if (p.supply == 0 || p.supply > 25 || p.deadline < block.timestamp || p.key == 0 || p.manifestHash == 0 || p.metadataHash == 0 || p.licenseHash == 0 || bytes(uri).length > 240 || bytes(uri).length < 6 || keccak256(bytes(uri)) != p.uriHash || comicForKey[p.key] != 0) revert Invalid();
        if (!SignatureChecker.isValidSignatureNow(reviewer, _hashTypedDataV4(keccak256(abi.encode(PERMIT_TYPEHASH, p))), signature)) revert Unauthorized();
        id = ++comicCount; comicForKey[p.key] = id;
        comics[id] = Comic(msg.sender, p.key, p.manifestHash, p.metadataHash, p.licenseHash, p.supply, uri, p.auctionHash);
        for (uint256 i; i < p.supply; ++i) { uint256 token = ++tokenCount; tokenComic[token] = id; _mint(msg.sender, token); _setTokenRoyalty(token, msg.sender, ROYALTY_BPS); }
        emit ComicCreated(id, p.key, msg.sender, p.supply, p.manifestHash, p.metadataHash, p.licenseHash, uri);
    }
    function tokenURI(uint256 token) public view override returns(string memory) { _requireOwned(token); return comics[tokenComic[token]].uri; }
    function supportsInterface(bytes4 id) public view override(ERC721, ERC2981) returns(bool) { return super.supportsInterface(id); }
    function _end(uint64 duration) private view returns(uint64) { if (duration < 1 hours || duration > 30 days) revert Invalid(); return uint64(block.timestamp) + duration; }
    function _deposit(uint256 token) private { if (ownerOf(token) != msg.sender) revert Unauthorized(); depositor[token] = msg.sender; _transfer(msg.sender, address(this), token); }
    function _release(uint256 token, address to) private { _transfer(address(this), to, token); delete depositor[token]; }
    function canTrade(address wallet) public view returns(bool) { return wallet != address(0) && qualifyingBalance[wallet] > 0; }
    function openAuction(uint256 token, uint256 reserve, uint64 duration) external nonReentrant {
        if (reserve == 0 || delisted[tokenComic[token]]) revert Invalid();
        bytes32 approved = comics[tokenComic[token]].auctionHash;
        if (sales[token].firstPrice == 0 && approved != 0 && keccak256(abi.encode(reserve, duration)) != approved) revert Invalid();
        uint64 end = _end(duration); _deposit(token); auctions[token] = Auction(msg.sender, address(0), reserve, 0, end, end + 1 hours, true);
        emit AuctionOpened(token, msg.sender, reserve, end);
    }
    function minimumBid(uint256 token) public view returns(uint256) { Auction memory a = auctions[token]; uint256 step = a.bid / 20; return a.bid == 0 ? a.reserve : a.bid + (step == 0 ? 1 : step); }
    function bid(uint256 token) external payable nonReentrant {
        if (sales[token].firstPrice != 0 && !canTrade(msg.sender)) revert TradeLocked();
        Auction storage a = auctions[token]; if (!a.active || block.timestamp >= a.end || msg.sender == a.seller || delisted[tokenComic[token]]) revert Unavailable();
        uint256 minimum = minimumBid(token); if (msg.value < minimum) revert TooLow(minimum);
        if (a.bid != 0) { lockedEth -= a.bid; _credit(a.bidder, a.bid); }
        a.bidder = msg.sender; a.bid = msg.value; lockedEth += msg.value;
        if (a.end - block.timestamp < 2 minutes && a.end < a.hardEnd) { uint64 next = uint64(block.timestamp) + 2 minutes; a.end = next > a.hardEnd ? a.hardEnd : next; }
        emit Bid(token, msg.sender, msg.value, a.end);
    }
    function settleAuction(uint256 token) external nonReentrant {
        Auction storage a = auctions[token]; if (!a.active || block.timestamp < a.end) revert Unavailable(); a.active = false;
        if (a.bidder == address(0)) _release(token, a.seller);
        else { lockedEth -= a.bid; _sale(token, a.seller, a.bidder, a.bid, true); _release(token, a.bidder); }
        emit AuctionClosed(token);
    }
    function cancelAuction(uint256 token) external nonReentrant { Auction storage a = auctions[token]; if (a.seller != msg.sender) revert Unauthorized(); if (!a.active || a.bid != 0) revert Unavailable(); a.active = false; _release(token, msg.sender); emit AuctionClosed(token); }
    function setAsk(uint256 token, uint256 price, uint64 duration) external {
        if (ownerOf(token) != msg.sender) revert Unauthorized(); if (sales[token].firstPrice == 0 || price == 0 || delisted[tokenComic[token]]) revert Invalid();
        asks[token] = Ask(msg.sender, price, _end(duration)); emit Asked(token, msg.sender, price, asks[token].end);
    }
    function cancelAsk(uint256 token) external { if (asks[token].seller != msg.sender) revert Unauthorized(); delete asks[token]; emit Asked(token, msg.sender, 0, 0); }
    function buy(uint256 token, uint256 expectedPrice) external payable nonReentrant {
        if (!canTrade(msg.sender)) revert TradeLocked();
        Ask memory a = asks[token]; if (a.seller == address(0) || a.seller != ownerOf(token) || a.seller == msg.sender || block.timestamp >= a.end || delisted[tokenComic[token]]) revert Unavailable();
        if (msg.value != a.price || expectedPrice != a.price) revert WrongValue(a.price);
        _sale(token, a.seller, msg.sender, a.price, false); _transfer(a.seller, msg.sender, token);
    }
    function _sale(uint256 token, address seller, address buyer, uint256 amount, bool isAuction) private {
        Sale storage s = sales[token]; bool primary = s.firstPrice == 0;
        uint256 fee = amount * FEE_BPS / 10000; uint256 royalty = primary ? 0 : amount * ROYALTY_BPS / 10000;
        _credit(treasury, fee); _credit(comics[tokenComic[token]].author, royalty); _credit(seller, amount - fee - royalty);
        if (primary) { s.firstPrice = amount; s.firstAt = uint64(block.timestamp); ++qualifyingBalance[seller]; }
        s.latestPrice = amount; s.latestAt = uint64(block.timestamp); if (isAuction) s.auctionPrice = amount;
        emit Sold(token, seller, buyer, amount, fee, royalty, primary, isAuction, uint64(block.timestamp));
    }
    function openDeal(uint256 token, uint64 duration) external nonReentrant returns(uint256 id) {
        uint256 value = sales[token].auctionPrice; if (value == 0 || delisted[tokenComic[token]]) revert Invalid(); _deposit(token);
        id = ++dealCount; deals[id] = Deal(msg.sender, token, value, _end(duration), true); emit DealOpened(id, token, msg.sender, value, deals[id].end);
    }
    function offer(uint256 deal, uint256 token) external payable nonReentrant returns(uint256 id) {
        Deal memory d = deals[deal]; uint256 value = sales[token].auctionPrice;
        if (!d.active || block.timestamp >= d.end || d.maker == msg.sender || value == 0 || value > d.value || delisted[tokenComic[token]]) revert Unavailable();
        if (msg.value != d.value - value) revert WrongValue(d.value - value); _deposit(token);
        id = ++offerCount; offers[id] = Offer(msg.sender, deal, token, msg.value, true); lockedEth += msg.value; emit Offered(id, deal, token, msg.sender, msg.value);
    }
    function accept(uint256 id) external nonReentrant {
        Offer storage o = offers[id]; Deal storage d = deals[o.deal]; if (d.maker != msg.sender) revert Unauthorized();
        if (!o.active || !d.active || block.timestamp >= d.end || delisted[tokenComic[d.token]] || delisted[tokenComic[o.token]]) revert Unavailable();
        o.active = false; d.active = false; lockedEth -= o.topUp; _credit(d.maker, o.topUp); _release(d.token, o.maker); _release(o.token, d.maker);
        // A barter swap has no unambiguous ETH sale price. Preserve sale history.
        emit Swapped(id, o.deal); emit DealClosed(o.deal); emit OfferClosed(id);
    }
    function closeDeal(uint256 id) external nonReentrant { Deal storage d = deals[id]; if (!d.active) revert Unavailable(); if (d.maker != msg.sender && block.timestamp < d.end) revert Unauthorized(); d.active = false; _release(d.token, d.maker); emit DealClosed(id); }
    function closeOffer(uint256 id) external nonReentrant { Offer storage o = offers[id]; Deal memory d = deals[o.deal]; if (!o.active) revert Unavailable(); if (o.maker != msg.sender && d.active && block.timestamp < d.end) revert Unauthorized(); o.active = false; lockedEth -= o.topUp; _credit(o.maker, o.topUp); _release(o.token, o.maker); emit OfferClosed(id); }
    function setDelisted(uint256 id, bool value) external { if (comics[id].author != msg.sender && reviewer != msg.sender) revert Unauthorized(); delisted[id] = value; emit Delisted(id, value); }
    function canRead(uint256 token, address wallet) external view returns(bool) { if (sales[token].firstPrice == 0 || wallet == address(0)) return false; address holder = ownerOf(token); return (holder == address(this) ? depositor[token] : holder) == wallet; }
    function _credit(address to, uint256 amount) private { credits[to] += amount; totalCredits += amount; }
    function withdraw(address payable recipient) external nonReentrant { uint256 amount = credits[msg.sender]; if (amount == 0 || recipient == address(0) || recipient == address(this)) revert Invalid(); credits[msg.sender] = 0; totalCredits -= amount; (bool ok,) = recipient.call{value:amount}(""); if (!ok) revert Unavailable(); emit Withdrawn(msg.sender, recipient, amount); }
    function transferFrom(address from, address to, uint256 token) public override { if (to == address(this) || sales[token].firstPrice == 0) revert Invalid(); super.transferFrom(from, to, token); }
    function _update(address to, uint256 token, address auth) internal override returns(address) {
        address from = _ownerOf(token);
        if (sales[token].firstPrice != 0) {
            address previousHolder = from == address(this) ? depositor[token] : from;
            address nextHolder = to == address(this) ? depositor[token] : to;
            if (previousHolder != nextHolder) {
                if (previousHolder != address(0)) --qualifyingBalance[previousHolder];
                if (nextHolder != address(0)) ++qualifyingBalance[nextHolder];
            }
        }
        delete asks[token]; return super._update(to, token, auth);
    }
}
