// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {INativeMinter} from "../interfaces/INativeMinter.sol";

/**
 * @title RielConverter
 * @notice 1:1 convertibility between council-approved tokenized-riel stablecoins
 *         (KHRt and others) and the native base coin tRIEL.
 *
 *  Two-tier money model (see docs/architecture.md §6): tRIEL is the riel-pegged
 *  base/settlement coin; tokenized riel are private stablecoins. This contract
 *  makes tRIEL fully collateralized by locked tokenized riel:
 *
 *    wrap:   lock N tokenized riel  ->  MINT N tRIEL to the caller
 *    unwrap: BURN N tRIEL           ->  release N locked tokenized riel
 *
 *  So every tRIEL minted here is backed 1:1 by tokenized riel held in this
 *  contract, and burning tRIEL releases that backing (e.g. a public fund that
 *  received tRIEL fees cashes out to KHRt, then redeems KHRt with its issuer).
 *
 *  Decimals: tRIEL is native (18 decimals); tokenized riel may use fewer
 *  (KHRt uses 2). Amounts are scaled by 10**(18 - tokenDecimals).
 *
 *  Trust: minting tRIEL requires this contract to be on the Native Minter
 *  allow list; it only ever mints against collateral it just locked. Only the
 *  council may approve which tokens are convertible — approving a token that is
 *  not truly 1:1 riel would let it mint unbacked tRIEL, so approval is governed.
 *  Burning sends tRIEL to a dead address (native coins have no burn opcode),
 *  permanently removing it from circulation.
 */
contract RielConverter is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant COUNCIL_ROLE = keccak256("COUNCIL_ROLE");
    address public constant BURN_SINK = 0x000000000000000000000000000000000000dEaD;

    INativeMinter public immutable nativeMinter;

    /// @notice Tokens the council permits to be wrapped into tRIEL.
    mapping(address => bool) public approved;

    event TokenApprovalSet(address indexed token, bool approved);
    event Wrapped(address indexed account, address indexed token, uint256 tokenAmount, uint256 trielAmount);
    event Unwrapped(address indexed account, address indexed token, uint256 tokenAmount, uint256 trielAmount);

    error TokenNotApproved(address token);
    error ZeroAmount();
    error WrongValue(uint256 expected, uint256 sent);
    error BurnFailed();
    error UnsupportedDecimals(uint8 tokenDecimals);

    constructor(address council, address nativeMinter_) {
        _grantRole(DEFAULT_ADMIN_ROLE, council);
        _grantRole(COUNCIL_ROLE, council);
        nativeMinter = INativeMinter(nativeMinter_);
    }

    /// @notice Council approves/removes a tokenized-riel token for conversion.
    function setApproved(address token, bool ok) external onlyRole(COUNCIL_ROLE) {
        approved[token] = ok;
        emit TokenApprovalSet(token, ok);
    }

    /// @notice tRIEL (18dp) per one base unit of `token`.
    function scale(address token) public view returns (uint256) {
        uint8 d = IERC20Metadata(token).decimals();
        if (d > 18) revert UnsupportedDecimals(d);
        return 10 ** (18 - d);
    }

    /**
     * @notice Lock `amount` of an approved tokenized riel and mint the caller
     *         the equivalent native tRIEL.
     */
    function wrap(address token, uint256 amount) external nonReentrant {
        if (!approved[token]) revert TokenNotApproved(token);
        if (amount == 0) revert ZeroAmount();
        uint256 trielOut = amount * scale(token);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        nativeMinter.mintNativeCoin(msg.sender, trielOut);
        emit Wrapped(msg.sender, token, amount, trielOut);
    }

    /**
     * @notice Burn the tRIEL sent with the call and release `amount` of the
     *         locked `token` to the caller. `msg.value` must exactly equal
     *         `amount * scale(token)`. Not gated on approval, so holders can
     *         always exit a token the council has since de-listed.
     */
    function unwrap(address token, uint256 amount) external payable nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 trielIn = amount * scale(token);
        if (msg.value != trielIn) revert WrongValue(trielIn, msg.value);
        (bool ok, ) = BURN_SINK.call{value: msg.value}("");
        if (!ok) revert BurnFailed();
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Unwrapped(msg.sender, token, amount, trielIn);
    }
}
