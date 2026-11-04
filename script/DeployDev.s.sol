// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PixelPit} from "../src/PixelPit.sol";
import {MockCore} from "../test/mocks/MockCore.sol";
import {Deploy} from "./Deploy.s.sol";

/// @notice Dev deployment: a MockCore (public bump(n)) plus a Pit bound to it. VITE_ENV=dev only;
///         never goes into the production config. $DEV_HEIGHT sets the mock's starting height (default 8430).
contract DeployDev is Script {
    function run() external returns (MockCore core, PixelPit pit) {
        uint64 startHeight = uint64(vm.envOr("DEV_HEIGHT", uint256(8430)));
        string memory path = vm.envOr("GENESIS_JSON", string("test/fixtures/genesis.json"));
        (uint16[] memory cells, uint8[] memory colors) = new Deploy().loadGenesis(path);

        vm.startBroadcast();
        core = new MockCore(startHeight);
        pit = new PixelPit(address(core), cells, colors);
        vm.stopBroadcast();

        console.log("MockCore      ", address(core));
        console.log("dev PixelPit  ", address(pit));
        console.log("GENESIS_HEIGHT", pit.GENESIS_HEIGHT());
        console.log("DEPLOY_BLOCK  ", pit.DEPLOY_BLOCK());
    }
}
