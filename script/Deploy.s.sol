// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PixelPit} from "../src/PixelPit.sol";

/// @notice Deploys PixelPit bound to the live SqueekCore proxy (or $CORE) with the genesis picture
///         from $GENESIS_JSON (default test/fixtures/genesis.json, format {cells:number[],colors:number[]}).
///         Season 0 throwaway: GENESIS_JSON=script/genesis-season0.json.
///         Signer comes from the forge CLI (--private-key / --account / --ledger); nothing is read here.
contract Deploy is Script {
    address internal constant LIVE_CORE = 0x980B4424c007CAf7a1f3670B48c8EaEf7EbC3d44;

    function run() external returns (PixelPit pit) {
        address core = vm.envOr("CORE", LIVE_CORE);
        string memory path = vm.envOr("GENESIS_JSON", string("test/fixtures/genesis.json"));
        (uint16[] memory cells, uint8[] memory colors) = loadGenesis(path);

        console.log("CORE          ", core);
        console.log("genesis file  ", path);
        console.log("genesis cells ", cells.length);

        vm.startBroadcast();
        pit = new PixelPit(core, cells, colors);
        vm.stopBroadcast();

        console.log("PixelPit      ", address(pit));
        console.log("GENESIS_HEIGHT", pit.GENESIS_HEIGHT());
        console.log("DEPLOY_BLOCK  ", pit.DEPLOY_BLOCK());
    }

    /// @dev Shared by Deploy, DeployDev and the T19 genesis test.
    function loadGenesis(string memory path) public view returns (uint16[] memory cells, uint8[] memory colors) {
        string memory json = vm.readFile(path);
        uint256[] memory rawCells = abi.decode(vm.parseJson(json, ".cells"), (uint256[]));
        uint256[] memory rawColors = abi.decode(vm.parseJson(json, ".colors"), (uint256[]));
        cells = new uint16[](rawCells.length);
        colors = new uint8[](rawColors.length);
        for (uint256 i = 0; i < rawCells.length; ++i) cells[i] = uint16(rawCells[i]);
        for (uint256 i = 0; i < rawColors.length; ++i) colors[i] = uint8(rawColors[i]);
    }
}
