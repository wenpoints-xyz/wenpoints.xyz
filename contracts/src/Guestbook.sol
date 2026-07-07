// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title $HELIXPOINT Guestbook (upgradeable, UUPS)
/// @notice Anyone can post (permissionless writes). An admin set gates contract upgrades and admin
///         management. The deployer is the first admin (set at initialize). Holds no funds.
/// @dev UUPS proxy pattern via OpenZeppelin. Logic lives here; state lives in the ERC1967 proxy.
///      Posts are read off `PostCreated` events (see /guestbook). New state goes ABOVE __gap.
contract Guestbook is Initializable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    struct Post {
        address author;
        uint64 timestamp;
        string message;
    }

    Post[] private _posts;
    mapping(address => bool) public isAdmin;
    uint256 public adminCount;
    mapping(uint256 => bool) public deleted; // index => hidden by an admin
    // ---- V2 (tipping) state: APPEND ONLY, above __gap. OZ v5 keeps ReentrancyGuard/UUPS/Initializable
    //      in ERC-7201 namespaced storage, so this is the only new sequential slot. ----
    mapping(address => bool) public tipTokenAllowed; // admin allowlist of tip tokens (USDC/USDT/wINJ)

    event PostCreated(address indexed author, uint256 indexed index, string message);
    event PostDeleted(uint256 indexed index, address indexed by);
    event AdminAdded(address indexed admin, address indexed by);
    event AdminRemoved(address indexed admin, address indexed by);
    event Tipped(uint256 indexed index, address indexed from, address indexed token, uint256 amount);
    event TipTokenSet(address indexed token, bool allowed);

    error EmptyMessage();
    error MessageTooLong();
    error NotAdmin();
    error ZeroAddress();
    error AlreadyAdmin();
    error NotAnAdmin();
    error LastAdmin();
    error NoSuchPost();
    error AlreadyDeleted();
    error TipTokenNotAllowed();
    error ZeroAmount();

    modifier onlyAdmin() {
        if (!isAdmin[msg.sender]) revert NotAdmin();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy. Caller (the deployer) becomes the first admin.
    function initialize() external initializer {
        __UUPSUpgradeable_init();
        isAdmin[msg.sender] = true;
        adminCount = 1;
        emit AdminAdded(msg.sender, msg.sender);
    }

    // ---- posts (permissionless) ----
    function post(string calldata message) external {
        uint256 len = bytes(message).length;
        if (len == 0) revert EmptyMessage();
        if (len > 1024) revert MessageTooLong();
        _posts.push(Post({author: msg.sender, timestamp: uint64(block.timestamp), message: message}));
        emit PostCreated(msg.sender, _posts.length - 1, message);
    }

    function count() external view returns (uint256) {
        return _posts.length;
    }

    /// @notice Admin-only: hide a post. The PostCreated event stays (immutable log), but a
    ///         PostDeleted event tells clients to hide it.
    function deletePost(uint256 index) external onlyAdmin {
        if (index >= _posts.length) revert NoSuchPost();
        if (deleted[index]) revert AlreadyDeleted();
        deleted[index] = true;
        emit PostDeleted(index, msg.sender);
    }

    // ---- admin management ----
    function addAdmin(address account) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        if (isAdmin[account]) revert AlreadyAdmin();
        isAdmin[account] = true;
        adminCount += 1;
        emit AdminAdded(account, msg.sender);
    }

    function removeAdmin(address account) external onlyAdmin {
        if (!isAdmin[account]) revert NotAnAdmin();
        if (adminCount == 1) revert LastAdmin(); // never leave zero admins (would lock upgrades forever)
        isAdmin[account] = false;
        adminCount -= 1;
        emit AdminRemoved(account, msg.sender);
    }

    // ---- tipping (permissionless; non-custodial; totals aggregated off-chain from Tipped events) ----
    /// @notice Tip a post's author in an allowlisted ERC20 (USDC/USDT/wINJ). Pulls `amount` from the
    ///         caller straight to the author — the contract never holds funds.
    function tip(uint256 index, address token, uint256 amount) external nonReentrant {
        if (index >= _posts.length) revert NoSuchPost();
        if (deleted[index]) revert AlreadyDeleted(); // no tipping hidden posts
        if (amount == 0) revert ZeroAmount();
        if (!tipTokenAllowed[token]) revert TipTokenNotAllowed();
        address author = _posts[index].author;
        IERC20(token).safeTransferFrom(msg.sender, author, amount); // effects are event-only; interaction last
        emit Tipped(index, msg.sender, token, amount);
    }

    /// @notice Admin-only: allow/disallow a token for tipping.
    function setTipToken(address token, bool allowed) external onlyAdmin {
        if (token == address(0)) revert ZeroAddress();
        tipTokenAllowed[token] = allowed;
        emit TipTokenSet(token, allowed);
    }

    /// @notice One-time V2 init, run ATOMICALLY inside upgradeToAndCall by an admin. onlyAdmin +
    ///         reinitializer(2) close any front-run window on the token allowlist.
    function initializeV2(address[] calldata tokens) external reinitializer(2) onlyAdmin {
        __ReentrancyGuard_init();
        for (uint256 i; i < tokens.length; i++) {
            if (tokens[i] == address(0)) revert ZeroAddress();
            tipTokenAllowed[tokens[i]] = true;
            emit TipTokenSet(tokens[i], true);
        }
    }

    // ---- upgrade authorization: admins only ----
    function _authorizeUpgrade(address) internal override onlyAdmin {}

    /// @dev Storage gap so future versions can add state without clobbering the proxy layout.
    ///      Shrunk 46 -> 45 when `tipTokenAllowed` was appended in V2.
    uint256[45] private __gap;
}
