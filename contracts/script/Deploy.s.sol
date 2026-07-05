// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Guestbook} from "../src/Guestbook.sol";

/// Deploys the implementation + a UUPS proxy, initializing the deployer as first admin.
///   forge script script/Deploy.s.sol:Deploy --rpc-url <rpc> --private-key <key> --broadcast
/// Testnet: https://k8s.testnet.json-rpc.injective.network/ (1439) | Mainnet: https://sentry.evm-rpc.injective.network/ (1776)
/// Use the PROXY address in the frontend.
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        Guestbook impl = new Guestbook();
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), abi.encodeCall(Guestbook.initialize, ()));
        vm.stopBroadcast();
        console2.log("implementation:", address(impl));
        console2.log("PROXY (use in frontend):", address(proxy));
    }
}
