// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Base64} from "../lib/Base64.sol";
import {IdentityRegistry} from "../identity/IdentityRegistry.sol";
import {EnforcementRegistry} from "../enforcement/EnforcementRegistry.sol";

/**
 * @title CSBCollectible
 * @notice A KYC-gated NFT anyone verified can mint for themselves.
 *
 * This exists to be tried, not read about. Someone with a wallet on CSB can mint
 * one in seconds and watch it appear — and in doing so sees the two things that
 * make this chain different, without anyone explaining them:
 *
 *  - Minting works if the identity layer knows you, and is refused if it does
 *    not. The refusal is the demonstration.
 *  - The result is an ordinary ERC-721 that a frozen account cannot move,
 *    because compliance lives in the token rather than in the app around it.
 *
 * The artwork is generated ON CHAIN as an SVG. No IPFS, no metadata server, no
 * link to rot: the image derives from the token id and the minter's address, so
 * it lasts exactly as long as the chain does. For a demonstration whose point is
 * that you can check things yourself, metadata behind somebody's web host would
 * undercut the argument.
 *
 * ERC-721 is implemented here rather than inherited. OpenZeppelin 5.6's ERC721
 * reaches Strings -> Bytes, which uses the `mcopy` opcode from Cancun; this
 * project compiles for `paris` deliberately so its bytecode stays deployable on
 * the Subnet-EVM versions CSB runs. Raising the EVM target for the whole
 * repository to inherit one base contract would change the bytecode of every
 * contract already deployed, to gain a dependency whose opcode support on this
 * chain is unverified. The standard is small; the assumption was not worth it.
 *
 * PLACEHOLDER: a demonstration collectible on a test network. It represents
 * nothing, confers nothing, and is worth nothing.
 */
contract CSBCollectible is AccessControl {
    /// @notice May mint on someone's behalf (seeding demos, issuing at a stand).
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    string public constant name = "CSB Collectible";
    string public constant symbol = "CSBC";

    IdentityRegistry public immutable identity;
    EnforcementRegistry public immutable enforcement;

    uint256 public totalMinted;
    /// @notice Minimum KYC tier required to hold one. 1 = any verified citizen.
    uint8 public minimumTier = 1;
    /// @notice Cap per address, so one enthusiastic visitor cannot fill the chain.
    uint256 public maxPerAddress = 5;
    bool public paused;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    mapping(uint256 => address) public mintedBy;
    mapping(uint256 => uint64) public mintedAt;
    mapping(address => uint256) public mintedCount;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Minted(uint256 indexed tokenId, address indexed to, address indexed by);
    event MinimumTierSet(uint8 tier);
    event MaxPerAddressSet(uint256 max);
    event Paused(bool paused);

    error NotVerified(address account);
    error TierTooLow(address account, uint8 tier, uint8 required);
    error AccountFrozen(address account);
    error MintLimitReached(address account, uint256 limit);
    error TokenPaused();
    error NonexistentToken(uint256 tokenId);
    error NotAuthorized(address caller, uint256 tokenId);
    error WrongOwner(address from, uint256 tokenId);
    error ZeroAddress();
    error UnsafeRecipient(address to);

    constructor(IdentityRegistry identity_, EnforcementRegistry enforcement_, address admin) {
        identity = identity_;
        enforcement = enforcement_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    // ------------------------------------------------------------------ mint

    /// @notice Mint one to yourself. Requires an active KYC attestation.
    function mint() external returns (uint256) {
        return _mintTo(msg.sender, msg.sender);
    }

    /// @notice Mint on someone's behalf — for seeding a demo or issuing at a stand.
    function mintTo(address to) external onlyRole(MINTER_ROLE) returns (uint256) {
        return _mintTo(to, msg.sender);
    }

    function _mintTo(address to, address by) private returns (uint256 tokenId) {
        if (paused) revert TokenPaused();
        if (to == address(0)) revert ZeroAddress();
        if (mintedCount[to] >= maxPerAddress) revert MintLimitReached(to, maxPerAddress);
        _requireCanHold(to);

        tokenId = ++totalMinted;
        mintedBy[tokenId] = to;
        mintedAt[tokenId] = uint64(block.timestamp);
        mintedCount[to] += 1;
        _owners[tokenId] = to;
        _balances[to] += 1;

        emit Transfer(address(0), to, tokenId);
        emit Minted(tokenId, to, by);
        _checkReceiver(address(0), to, tokenId, "");
    }

    /// @notice Can this address mint right now, and if not, why? Lets the page
    ///         explain a refusal before anyone signs a transaction.
    function canMint(address who) external view returns (bool ok, string memory reason) {
        if (paused) return (false, "minting is paused");
        if (enforcement.isFrozen(who)) return (false, "this account is frozen by an enforcement order");
        if (!identity.isActive(who)) return (false, "this address has no active KYC attestation on CSB");
        if (identity.tierOf(who) < minimumTier) return (false, "this address's KYC tier is too low to hold one");
        if (mintedCount[who] >= maxPerAddress) {
            return (false, string.concat("this address already minted the maximum of ", _toString(maxPerAddress)));
        }
        return (true, "");
    }

    // -------------------------------------------------------------- ERC-721

    function balanceOf(address owner) public view returns (uint256) {
        if (owner == address(0)) revert ZeroAddress();
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner = _owners[tokenId];
        if (owner == address(0)) revert NonexistentToken(tokenId);
        return owner;
    }

    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        if (msg.sender != owner && !_operatorApprovals[owner][msg.sender]) {
            revert NotAuthorized(msg.sender, tokenId);
        }
        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        if (_owners[tokenId] == address(0)) revert NonexistentToken(tokenId);
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        _transfer(from, to, tokenId);
        _checkReceiver(from, to, tokenId, data);
    }

    function _transfer(address from, address to, uint256 tokenId) private {
        address owner = ownerOf(tokenId);
        if (owner != from) revert WrongOwner(from, tokenId);
        if (to == address(0)) revert ZeroAddress();
        if (
            msg.sender != owner && _tokenApprovals[tokenId] != msg.sender
                && !_operatorApprovals[owner][msg.sender]
        ) revert NotAuthorized(msg.sender, tokenId);

        // Compliance, checked on the move itself rather than in a caller that
        // could be swapped out.
        if (paused) revert TokenPaused();
        if (enforcement.isFrozen(from)) revert AccountFrozen(from);
        _requireCanHold(to);

        delete _tokenApprovals[tokenId];
        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function _requireCanHold(address account) private view {
        if (enforcement.isFrozen(account)) revert AccountFrozen(account);
        if (!identity.isActive(account)) revert NotVerified(account);
        uint8 tier = identity.tierOf(account);
        if (tier < minimumTier) revert TierTooLow(account, tier, minimumTier);
    }

    function _checkReceiver(address from, address to, uint256 tokenId, bytes memory data) private {
        if (to.code.length == 0) return;
        try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 ret) {
            if (ret != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient(to);
        } catch {
            revert UnsafeRecipient(to);
        }
    }

    /// @notice Would this transfer succeed? Lets a UI warn before signing.
    function canTransfer(address from, address to, uint256 tokenId)
        external
        view
        returns (bool ok, string memory reason)
    {
        if (paused) return (false, "transfers are paused");
        if (_owners[tokenId] == address(0)) return (false, "no such token");
        if (_owners[tokenId] != from) return (false, "sender does not own this token");
        if (enforcement.isFrozen(from)) return (false, "sender is frozen by an enforcement order");
        if (enforcement.isFrozen(to)) return (false, "recipient is frozen by an enforcement order");
        if (!identity.isActive(to)) return (false, "recipient has no active KYC attestation");
        if (identity.tierOf(to) < minimumTier) return (false, "recipient's KYC tier is too low");
        return (true, "");
    }

    // ------------------------------------------------------------- governance

    function setMinimumTier(uint8 tier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minimumTier = tier;
        emit MinimumTierSet(tier);
    }

    function setMaxPerAddress(uint256 max) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxPerAddress = max;
        emit MaxPerAddressSet(max);
    }

    function setPaused(bool paused_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        paused = paused_;
        emit Paused(paused_);
    }

    // ---------------------------------------------------------------- artwork

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_owners[tokenId] == address(0)) revert NonexistentToken(tokenId);
        string memory image = Base64.encode(bytes(_svg(tokenId)));
        string memory json = string.concat(
            '{"name":"CSB Collectible #', _toString(tokenId),
            '","description":"A demonstration collectible on the Cambodia Sovereign Blockchain testnet. ',
            "Minted by a KYC-verified address; the artwork is generated on chain. ",
            'It represents nothing and is worth nothing.","attributes":[',
            '{"trait_type":"Token","value":"', _toString(tokenId), '"},',
            '{"trait_type":"Minted at","value":"', _toString(mintedAt[tokenId]), '"},',
            '{"trait_type":"Chain","value":"CSB testnet"}',
            '],"image":"data:image/svg+xml;base64,', image, '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _svg(uint256 tokenId) private view returns (string memory) {
        uint256 h = uint256(keccak256(abi.encodePacked(tokenId, mintedBy[tokenId])));
        uint256 hue = h % 360;
        uint256 hue2 = (hue + 40 + ((h >> 8) % 80)) % 360;
        uint256 rings = 3 + ((h >> 16) % 5);

        string memory circles;
        for (uint256 i = 0; i < rings; i++) {
            circles = string.concat(
                circles,
                '<circle cx="200" cy="200" r="', _toString(40 + i * 26),
                '" fill="none" stroke="#fff" stroke-opacity="0.', _toString(70 - i * 8),
                '" stroke-width="', _toString(2 + ((h >> (i + 3)) % 4)), '"/>'
            );
        }

        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">',
            '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
            '<stop offset="0%" stop-color="hsl(', _toString(hue), ',72%,42%)"/>',
            '<stop offset="100%" stop-color="hsl(', _toString(hue2), ',68%,26%)"/>',
            "</linearGradient></defs>",
            '<rect width="400" height="400" fill="url(#g)"/>',
            circles,
            '<text x="200" y="352" font-family="monospace" font-size="26" fill="#fff" ',
            'text-anchor="middle" opacity="0.92">CSB #', _toString(tokenId), "</text>",
            '<text x="200" y="378" font-family="monospace" font-size="12" fill="#fff" ',
            'text-anchor="middle" opacity="0.6">testnet demonstration</text>',
            "</svg>"
        );
    }

    /// @dev Local uint-to-string: OZ's Strings pulls in the Cancun dependency
    ///      this contract exists to avoid.
    function _toString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 digits;
        for (uint256 t = v; t != 0; t /= 10) digits++;
        bytes memory buf = new bytes(digits);
        while (v != 0) {
            digits--;
            buf[digits] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buf);
    }

    // ----------------------------------------------------------------- ERC165

    function supportsInterface(bytes4 id) public view override returns (bool) {
        return id == 0x80ac58cd // ERC-721
            || id == 0x5b5e139f // ERC-721 Metadata
            || super.supportsInterface(id); // ERC-165, AccessControl
    }
}
