// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Guestbook} from "../src/Guestbook.sol";

/// Deploy with:
///   forge script script/Deploy.s.sol:Deploy --rpc-url <injective-evm-rpc> --private-key <key> --broadcast
/// Testnet RPC: https://k8s.testnet.json-rpc.injective.network/   (chainId 1439)
/// Mainnet RPC: https://sentry.evm-rpc.injective.network/         (chainId 1776)
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        Guestbook gb = new Guestbook();
        vm.stopBroadcast();
        console2.log("Guestbook deployed at:", address(gb));
        console2.log("Record this address AND the deploy block for the frontend config.");
    }
}
