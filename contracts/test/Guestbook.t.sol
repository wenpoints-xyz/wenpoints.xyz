// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Guestbook} from "../src/Guestbook.sol";

/// upgrade target used to prove state survives an upgrade
contract GuestbookV2 is Guestbook {
    function version() external pure returns (string memory) {
        return "v2";
    }
}

contract GuestbookTest is Test {
    Guestbook internal gb; // the proxy, typed as Guestbook
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    event PostCreated(address indexed author, uint256 indexed index, string message);
    event PostDeleted(uint256 indexed index, address indexed by);
    event AdminAdded(address indexed admin, address indexed by);

    function setUp() public {
        Guestbook impl = new Guestbook();
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), abi.encodeCall(Guestbook.initialize, ()));
        gb = Guestbook(address(proxy)); // initialize() ran with msg.sender = this test contract
    }

    // ---- init ----
    function test_init_deployerIsFirstAdmin() public view {
        assertTrue(gb.isAdmin(address(this)));
        assertEq(gb.adminCount(), 1);
    }

    function test_cannot_reinitialize() public {
        vm.expectRevert();
        gb.initialize();
    }

    // ---- posts (permissionless) ----
    function test_post_storesAndEmits() public {
        vm.expectEmit(true, true, false, true);
        emit PostCreated(bob, 0, "gm");
        vm.prank(bob);
        gb.post("gm");
        assertEq(gb.count(), 1);
    }

    function test_post_empty_reverts() public {
        vm.expectRevert(Guestbook.EmptyMessage.selector);
        gb.post("");
    }

    function test_post_boundary_1024_ok_1025_reverts() public {
        gb.post(_repeat(1024));
        assertEq(gb.count(), 1);
        vm.expectRevert(Guestbook.MessageTooLong.selector);
        gb.post(_repeat(1025));
    }

    function testFuzz_post_validLengths(uint16 n) public {
        n = uint16(bound(n, 1, 1024));
        gb.post(_repeat(n));
        assertEq(gb.count(), 1);
    }

    // ---- admin management ----
    function test_addAdmin() public {
        vm.expectEmit(true, true, false, false);
        emit AdminAdded(alice, address(this));
        gb.addAdmin(alice);
        assertTrue(gb.isAdmin(alice));
        assertEq(gb.adminCount(), 2);
    }

    function test_addAdmin_notAdmin_reverts() public {
        vm.prank(bob);
        vm.expectRevert(Guestbook.NotAdmin.selector);
        gb.addAdmin(bob);
    }

    function test_addAdmin_zero_reverts() public {
        vm.expectRevert(Guestbook.ZeroAddress.selector);
        gb.addAdmin(address(0));
    }

    function test_addAdmin_already_reverts() public {
        gb.addAdmin(alice);
        vm.expectRevert(Guestbook.AlreadyAdmin.selector);
        gb.addAdmin(alice);
    }

    function test_addedAdmin_canAddMore() public {
        gb.addAdmin(alice);
        vm.prank(alice); // alice is now an admin and can add bob
        gb.addAdmin(bob);
        assertTrue(gb.isAdmin(bob));
        assertEq(gb.adminCount(), 3);
    }

    function test_removeAdmin() public {
        gb.addAdmin(alice);
        gb.removeAdmin(alice);
        assertFalse(gb.isAdmin(alice));
        assertEq(gb.adminCount(), 1);
    }

    function test_removeAdmin_lastAdmin_reverts() public {
        vm.expectRevert(Guestbook.LastAdmin.selector); // must never reach zero admins
        gb.removeAdmin(address(this));
    }

    function test_removeAdmin_notAnAdmin_reverts() public {
        vm.expectRevert(Guestbook.NotAnAdmin.selector);
        gb.removeAdmin(bob);
    }

    // ---- admin delete ----
    function test_deletePost_byAdmin() public {
        vm.prank(bob);
        gb.post("delete me");
        vm.expectEmit(true, true, false, false);
        emit PostDeleted(0, address(this));
        gb.deletePost(0);
        assertTrue(gb.deleted(0));
    }

    function test_deletePost_notAdmin_reverts() public {
        vm.prank(bob);
        gb.post("x");
        vm.prank(bob);
        vm.expectRevert(Guestbook.NotAdmin.selector);
        gb.deletePost(0);
    }

    function test_deletePost_noSuchPost_reverts() public {
        vm.expectRevert(Guestbook.NoSuchPost.selector);
        gb.deletePost(0);
    }

    function test_deletePost_alreadyDeleted_reverts() public {
        gb.post("x");
        gb.deletePost(0);
        vm.expectRevert(Guestbook.AlreadyDeleted.selector);
        gb.deletePost(0);
    }

    // ---- upgrade (UUPS, admin-gated, state-preserving) ----
    function test_upgrade_byAdmin_preservesState() public {
        gb.post("survives upgrade");
        assertEq(gb.count(), 1);
        GuestbookV2 v2 = new GuestbookV2();
        gb.upgradeToAndCall(address(v2), "");
        assertEq(GuestbookV2(address(gb)).version(), "v2"); // new logic
        assertEq(gb.count(), 1); // old state intact
        assertTrue(gb.isAdmin(address(this)));
    }

    function test_upgrade_notAdmin_reverts() public {
        GuestbookV2 v2 = new GuestbookV2();
        vm.prank(bob);
        vm.expectRevert(Guestbook.NotAdmin.selector);
        gb.upgradeToAndCall(address(v2), "");
    }

    function _repeat(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; i++) b[i] = "x";
        return string(b);
    }
}
