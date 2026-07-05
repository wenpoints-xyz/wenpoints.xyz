// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Guestbook} from "../src/Guestbook.sol";

contract GuestbookTest is Test {
    Guestbook internal gb;

    event PostCreated(address indexed author, uint256 indexed index, string message);

    function setUp() public {
        gb = new Guestbook();
    }

    function test_post_storesAndEmits() public {
        vm.expectEmit(true, true, false, true);
        emit PostCreated(address(this), 0, "gm. wen points");
        gb.post("gm. wen points");
        assertEq(gb.count(), 1);
    }

    function test_post_empty_reverts() public {
        vm.expectRevert(Guestbook.EmptyMessage.selector);
        gb.post("");
    }

    function test_post_tooLong_reverts() public {
        vm.expectRevert(Guestbook.MessageTooLong.selector);
        gb.post(_repeat(1025));
    }

    function test_post_boundary_1024_ok_1025_reverts() public {
        gb.post(_repeat(1024)); // exactly at the cap: allowed
        assertEq(gb.count(), 1);
        vm.expectRevert(Guestbook.MessageTooLong.selector);
        gb.post(_repeat(1025)); // one over: rejected
    }

    function test_count_increments() public {
        assertEq(gb.count(), 0);
        gb.post("a");
        gb.post("b");
        assertEq(gb.count(), 2);
    }

    function test_index_increments_acrossAuthors() public {
        vm.expectEmit(true, true, false, true);
        emit PostCreated(address(0xA11CE), 0, "from alice");
        vm.prank(address(0xA11CE));
        gb.post("from alice");

        vm.expectEmit(true, true, false, true);
        emit PostCreated(address(0xB0B), 1, "from bob");
        vm.prank(address(0xB0B));
        gb.post("from bob");

        assertEq(gb.count(), 2);
    }

    // fuzz: any 1..1024-byte message stores and bumps the count
    function testFuzz_post_validLengths(uint16 n) public {
        n = uint16(bound(n, 1, 1024));
        gb.post(_repeat(n));
        assertEq(gb.count(), 1);
    }

    function _repeat(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; i++) b[i] = "x";
        return string(b);
    }
}
