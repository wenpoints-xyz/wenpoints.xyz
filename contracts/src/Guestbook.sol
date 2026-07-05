// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @title $HELIXPOINT Guestbook (upgradeable, UUPS)
/// @notice Anyone can post (permissionless writes). An admin set gates contract upgrades and admin
///         management. The deployer is the first admin (set at initialize). Holds no funds.
/// @dev UUPS proxy pattern via OpenZeppelin. Logic lives here; state lives in the ERC1967 proxy.
///      Posts are read off `PostCreated` events (see /guestbook). New state goes ABOVE __gap.
contract Guestbook is Initializable, UUPSUpgradeable {
    struct Post {
        address author;
        uint64 timestamp;
        string message;
    }

    Post[] private _posts;
    mapping(address => bool) public isAdmin;
    uint256 public adminCount;
    mapping(uint256 => bool) public deleted; // index => hidden by an admin

    event PostCreated(address indexed author, uint256 indexed index, string message);
    event PostDeleted(uint256 indexed index, address indexed by);
    event AdminAdded(address indexed admin, address indexed by);
    event AdminRemoved(address indexed admin, address indexed by);

    error EmptyMessage();
    error MessageTooLong();
    error NotAdmin();
    error ZeroAddress();
    error AlreadyAdmin();
    error NotAnAdmin();
    error LastAdmin();
    error NoSuchPost();
    error AlreadyDeleted();

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

    // ---- upgrade authorization: admins only ----
    function _authorizeUpgrade(address) internal override onlyAdmin {}

    /// @dev Storage gap so future versions can add state without clobbering the proxy layout.
    uint256[46] private __gap;
}
