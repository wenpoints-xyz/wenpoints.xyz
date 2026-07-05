// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title $HELIXPOINT Guestbook
/// @notice Permissionless, immutable, holds no funds. Anyone can sign; posts are read off `PostCreated` events.
/// @dev No owner, no admin, no upgradeability. Message bytes are capped to bound gas/storage.
///
///  post(msg) ──require(1..1024 bytes)──> _posts.push(Post) ──emit──> PostCreated(author, index, message)
///  reads: clients index PostCreated logs (see /guestbook); count() gives the total.
contract Guestbook {
    struct Post {
        address author;
        uint64 timestamp;
        string message;
    }

    Post[] private _posts;

    event PostCreated(address indexed author, uint256 indexed index, string message);

    error EmptyMessage();
    error MessageTooLong();

    /// @notice Sign the guestbook. Reverts on empty or >1024-byte messages.
    function post(string calldata message) external {
        uint256 len = bytes(message).length;
        if (len == 0) revert EmptyMessage();
        if (len > 1024) revert MessageTooLong();
        _posts.push(Post({author: msg.sender, timestamp: uint64(block.timestamp), message: message}));
        emit PostCreated(msg.sender, _posts.length - 1, message);
    }

    /// @notice Total number of posts.
    function count() external view returns (uint256) {
        return _posts.length;
    }
}
