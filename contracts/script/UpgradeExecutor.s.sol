// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {OrderBook} from "../src/OrderBook.sol";
import {AgentExecutor} from "../src/AgentExecutor.sol";

/// @notice Put a new AgentExecutor in front of the existing stack.
///
/// The executor is the only contract that changed when the vault learned to
/// hold money for a resting order, and the two intent typehashes moved with it,
/// so this is a redeploy rather than an upgrade. Everything else stays: the
/// router, the ten tokens, the forty-five pools and all their liquidity, the
/// order book and every order resting in it. Rebuilding that would mean seeding
/// the whole mesh again for a change to one contract.
///
/// Three things happen here. The executor is deployed against the existing
/// router and order book, the ten tokens are registered so trades can still be
/// valued in dollars, and the order book is pointed at the new address so an
/// agent-opened limit order keeps working. The registry file is patched in
/// place, which is what the app and the relayer read.
///
/// What does not come across is per-user state: vault balances, capabilities
/// and spent nonces all live in the old contract's storage. The old withdraw
/// still works and has no notion of a hold, so anybody with a balance there can
/// take it back and redeposit. That is stated in the README rather than papered
/// over, because a migration would need the old contract to have anticipated
/// this one, and it did not.
contract UpgradeExecutor is Script {
    string constant REGISTRY = "deployments/sepolia.json";

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        string memory json = vm.readFile(REGISTRY);
        address router = vm.parseJsonAddress(json, ".router");
        address payable orderBook = payable(vm.parseJsonAddress(json, ".orderBook"));
        address previous = vm.parseJsonAddress(json, ".agentExecutor");

        address[] memory tokens = vm.parseJsonAddressArray(json, ".tokenAddresses");
        uint256[] memory decimals = vm.parseJsonUintArray(json, ".tokenDecimals");
        bool[] memory isStable = vm.parseJsonBoolArray(json, ".tokenIsStable");
        address[] memory feeds = vm.parseJsonAddressArray(json, ".tokenFeeds");

        console.log("Deployer:   ", deployer);
        console.log("Router:     ", router);
        console.log("OrderBook:  ", orderBook);
        console.log("Replacing:  ", previous);
        require(tokens.length == decimals.length, "registry token arrays disagree");
        require(tokens.length == isStable.length, "registry token arrays disagree");
        require(tokens.length == feeds.length, "registry token arrays disagree");

        vm.startBroadcast(pk);

        AgentExecutor executor = new AgentExecutor(router, orderBook);
        for (uint256 i = 0; i < tokens.length; i++) {
            executor.registerToken(tokens[i], uint8(decimals[i]), isStable[i], feeds[i]);
        }
        // Until this lands the new executor cannot open a limit order, because
        // createOrderFor only answers to the address recorded here.
        OrderBook(orderBook).setAgentExecutor(address(executor));

        vm.stopBroadcast();

        vm.writeJson(vm.toString(address(executor)), REGISTRY, ".agentExecutor");

        console.log("AgentExecutor:", address(executor));
        console.log("Tokens registered:", tokens.length);
    }
}
