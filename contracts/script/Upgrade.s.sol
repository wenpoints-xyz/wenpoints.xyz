// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Guestbook} from "../src/Guestbook.sol";

/// Deploys the tip-enabled implementation and upgrades the live UUPS proxy ATOMICALLY, seeding the
/// tip-token allowlist in the same tx (onlyAdmin + reinitializer(2) => no front-run window). Run by an admin.
///   PROXY=0x... forge script script/Upgrade.s.sol:Upgrade --rpc-url <rpc> --private-key <key> --broadcast
/// Mainnet proxy: 0xc71D862cD4E6b35F6aA29Fd908c27d1c4b2406EA (1776). Confirm USDC before broadcasting.
contract Upgrade is Script {
    // Injective EVM mainnet MTS tokens
    address constant USDC = 0xa00C59fF5a080D2b954d0c75e46E22a0c371235a; // VERIFY canonical MTS USDC before mainnet
    address constant USDT = 0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13; // verified on-chain (symbol USDT, 6dp)
    address constant WINJ = 0x0000000088827d2d103ee2d9A6b781773AE03FfB; // verified on-chain (symbol WINJ, 18dp)

    function run() external {
        address proxy = vm.envAddress("PROXY");
        vm.startBroadcast();
        Guestbook newImpl = new Guestbook();
        address[] memory toks = new address[](3);
        toks[0] = USDC;
        toks[1] = USDT;
        toks[2] = WINJ;
        Guestbook(proxy).upgradeToAndCall(address(newImpl), abi.encodeCall(Guestbook.initializeV2, (toks)));
        vm.stopBroadcast();
        console2.log("new implementation:", address(newImpl));
        console2.log("proxy upgraded + tipping enabled:", proxy);
    }
}
