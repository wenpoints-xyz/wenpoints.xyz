// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Guestbook} from "../src/Guestbook.sol";

/// upgrade target used to prove state survives an upgrade
contract GuestbookV2 is Guestbook {
    function version() external pure returns (string memory) {
        return "v2";
    }
}

/// Standard ERC20 mock (returns bool). Underflow on missing balance/allowance => reverts like a real token.
contract MockERC20 {
    string public symbol = "MOCK";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

/// USDT-style token: transferFrom returns NOTHING. SafeERC20 must still accept it.
contract MockERC20NoBool {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; }
    function transferFrom(address f, address t, uint256 a) external {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a;
    }
}

/// Malicious token that re-enters tip() during transferFrom — must be stopped by nonReentrant.
contract ReentrantToken {
    Guestbook public gb;
    uint256 public idx;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function arm(Guestbook _gb, uint256 _idx) external { gb = _gb; idx = _idx; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        gb.tip(idx, address(this), a); // re-enter — should revert
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

/// Faithful copy of the PRE-tip storage layout, to prove the real mainnet old->new upgrade preserves state.
contract GuestbookLegacy is Initializable, UUPSUpgradeable {
    struct Post { address author; uint64 timestamp; string message; }
    Post[] private _posts;
    mapping(address => bool) public isAdmin;
    uint256 public adminCount;
    mapping(uint256 => bool) public deleted;
    error NotAdmin();
    modifier onlyAdmin() { if (!isAdmin[msg.sender]) revert NotAdmin(); _; }
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }
    function initialize() external initializer { __UUPSUpgradeable_init(); isAdmin[msg.sender] = true; adminCount = 1; }
    function post(string calldata m) external { _posts.push(Post(msg.sender, uint64(block.timestamp), m)); }
    function count() external view returns (uint256) { return _posts.length; }
    function deletePost(uint256 i) external onlyAdmin { deleted[i] = true; }
    function _authorizeUpgrade(address) internal override onlyAdmin {}
    uint256[46] private __gap;
}

contract GuestbookTest is Test {
    Guestbook internal gb; // the proxy, typed as Guestbook
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    MockERC20 internal usdc;  // allowlisted tip token
    MockERC20 internal other; // NOT allowlisted

    event PostCreated(address indexed author, uint256 indexed index, string message);
    event PostDeleted(uint256 indexed index, address indexed by);
    event AdminAdded(address indexed admin, address indexed by);
    event Tipped(uint256 indexed index, address indexed from, address indexed token, uint256 amount);
    event TipTokenSet(address indexed token, bool allowed);

    function setUp() public {
        Guestbook impl = new Guestbook();
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), abi.encodeCall(Guestbook.initialize, ()));
        gb = Guestbook(address(proxy)); // initialize() ran with msg.sender = this test contract
        usdc = new MockERC20();
        other = new MockERC20();
        address[] memory toks = new address[](1);
        toks[0] = address(usdc);
        gb.initializeV2(toks); // enable tipping (this contract is admin)
    }

    function _fundApprove(MockERC20 tok, address who, uint256 amt) internal {
        tok.mint(who, amt);
        vm.prank(who);
        tok.approve(address(gb), amt);
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

    // ---- tipping ----
    function test_tip_transfersToAuthor_andEmits() public {
        vm.prank(bob); gb.post("tip me");
        _fundApprove(usdc, alice, 100);
        vm.expectEmit(true, true, true, true);
        emit Tipped(0, alice, address(usdc), 100);
        vm.prank(alice); gb.tip(0, address(usdc), 100);
        assertEq(usdc.balanceOf(bob), 100);          // straight to author
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(address(gb)), 0);    // non-custodial
    }

    function test_tip_disallowedToken_reverts() public {
        vm.prank(bob); gb.post("x");
        _fundApprove(other, alice, 100);
        vm.prank(alice);
        vm.expectRevert(Guestbook.TipTokenNotAllowed.selector);
        gb.tip(0, address(other), 100);
    }

    function test_tip_deletedPost_reverts() public {
        vm.prank(bob); gb.post("x");
        gb.deletePost(0);
        _fundApprove(usdc, alice, 100);
        vm.prank(alice);
        vm.expectRevert(Guestbook.AlreadyDeleted.selector);
        gb.tip(0, address(usdc), 100);
    }

    function test_tip_zeroAmount_reverts() public {
        vm.prank(bob); gb.post("x");
        vm.prank(alice);
        vm.expectRevert(Guestbook.ZeroAmount.selector);
        gb.tip(0, address(usdc), 0);
    }

    function test_tip_badIndex_reverts() public {
        vm.prank(alice);
        vm.expectRevert(Guestbook.NoSuchPost.selector);
        gb.tip(0, address(usdc), 100);
    }

    function test_tip_noAllowance_reverts() public {
        vm.prank(bob); gb.post("x");
        usdc.mint(alice, 100); // funded but NOT approved
        vm.prank(alice);
        vm.expectRevert(); // allowance underflow in transferFrom
        gb.tip(0, address(usdc), 100);
    }

    function test_tip_safeERC20_noBoolToken_ok() public {
        MockERC20NoBool usdt = new MockERC20NoBool();
        gb.setTipToken(address(usdt), true);
        vm.prank(bob); gb.post("x");
        usdt.mint(alice, 100);
        vm.prank(alice); usdt.approve(address(gb), 100);
        vm.prank(alice); gb.tip(0, address(usdt), 100);
        assertEq(usdt.balanceOf(bob), 100); // SafeERC20 accepted the no-return token
    }

    function test_tip_reentrantToken_blocked() public {
        ReentrantToken evil = new ReentrantToken();
        gb.setTipToken(address(evil), true);
        vm.prank(bob); gb.post("x");
        evil.arm(gb, 0);
        evil.mint(alice, 100);
        vm.prank(alice); evil.approve(address(gb), 100);
        vm.prank(alice);
        vm.expectRevert(); // ReentrancyGuardReentrantCall bubbles up
        gb.tip(0, address(evil), 100);
    }

    function test_setTipToken_byAdmin_and_event() public {
        vm.expectEmit(true, false, false, true);
        emit TipTokenSet(address(other), true);
        gb.setTipToken(address(other), true);
        assertTrue(gb.tipTokenAllowed(address(other)));
    }

    function test_setTipToken_notAdmin_reverts() public {
        vm.prank(bob);
        vm.expectRevert(Guestbook.NotAdmin.selector);
        gb.setTipToken(address(other), true);
    }

    function test_setTipToken_zero_reverts() public {
        vm.expectRevert(Guestbook.ZeroAddress.selector);
        gb.setTipToken(address(0), true);
    }

    function test_initializeV2_cannotRerun() public {
        address[] memory toks = new address[](1);
        toks[0] = address(other);
        vm.expectRevert(); // reinitializer(2) already consumed in setUp
        gb.initializeV2(toks);
    }

    // ---- CRITICAL: the real mainnet old->new upgrade preserves posts/admins/deleted, then tipping works ----
    function test_upgrade_fromLegacy_preservesState_andEnablesTipping() public {
        GuestbookLegacy legacyImpl = new GuestbookLegacy();
        ERC1967Proxy p = new ERC1967Proxy(address(legacyImpl), abi.encodeCall(GuestbookLegacy.initialize, ()));
        GuestbookLegacy legacy = GuestbookLegacy(address(p));
        vm.prank(bob); legacy.post("a");
        vm.prank(bob); legacy.post("b");
        legacy.deletePost(1); // admin = this contract

        Guestbook newImpl = new Guestbook();
        MockERC20 tok = new MockERC20();
        address[] memory toks = new address[](1);
        toks[0] = address(tok);
        legacy.upgradeToAndCall(address(newImpl), abi.encodeCall(Guestbook.initializeV2, (toks)));

        Guestbook g = Guestbook(address(p));
        assertEq(g.count(), 2);           // old state intact
        assertTrue(g.deleted(1));
        assertFalse(g.deleted(0));
        assertTrue(g.isAdmin(address(this)));
        assertEq(g.adminCount(), 1);
        assertTrue(g.tipTokenAllowed(address(tok)));
        tok.mint(alice, 50);
        vm.prank(alice); tok.approve(address(g), 50);
        vm.prank(alice); g.tip(0, address(tok), 50); // post 0 author = bob
        assertEq(tok.balanceOf(bob), 50);
    }

    // ---- V3 state reads ----
    function test_tip_updatesTipTotal_andGetTips() public {
        vm.prank(bob); gb.post("tip me");
        _fundApprove(usdc, alice, 100);
        vm.prank(alice); gb.tip(0, address(usdc), 100);
        assertEq(gb.tipTotal(0, address(usdc)), 100);
        uint256[] memory idx = new uint256[](1); idx[0] = 0;
        address[] memory toks = new address[](2); toks[0] = address(usdc); toks[1] = address(other);
        uint256[] memory out = gb.getTips(idx, toks);
        assertEq(out.length, 2);
        assertEq(out[0], 100); // usdc tipped
        assertEq(out[1], 0);   // other never tipped
    }

    function test_getPostsBlob_packsIndexDeletedAndClamps() public {
        vm.prank(bob); gb.post("hello");        // 5-byte message
        gb.deletePost(0);                        // admin = this contract
        bytes memory blob = gb.getPostsBlob(0, 10);
        assertEq(blob.length, 165);              // 160 header + 5 msg
        uint256 idx0; uint256 del;
        assembly { idx0 := mload(add(blob, 0x20)) del := mload(add(blob, add(0x20, 96))) }
        assertEq(idx0, 0);
        assertEq(del, 1);                        // deleted flag = 4th word
        assertEq(gb.getPostsBlob(5, 10).length, 0); // offset past end -> empty
    }

    function _repeat(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; i++) b[i] = "x";
        return string(b);
    }
}
