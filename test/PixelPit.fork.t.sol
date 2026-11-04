// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {PixelPit} from "../src/PixelPit.sol";

/// @notice FORK test (§5.11): Sepolia fork against the real SqueekCore proxy.
///         Skipped cleanly unless SEPOLIA_RPC_URL is set. Optional SEPOLIA_FORK_BLOCK pins the block.
///         Run: SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com forge test --match-contract Fork -vv
contract PixelPitForkTest is Test {
    address internal constant CORE = 0x980B4424c007CAf7a1f3670B48c8EaEf7EbC3d44;
    bool internal enabled;
    PixelPit internal pit;
    address internal alice = makeAddr("alice");

    function setUp() public {
        string memory url = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        enabled = true;
        uint256 pin = vm.envOr("SEPOLIA_FORK_BLOCK", uint256(0));
        if (pin == 0) {
            // load-balanced public RPCs may not agree on the very latest block: fork 32 blocks behind head
            vm.createSelectFork(url);
            vm.rollFork(block.number - 32);
        } else {
            vm.createSelectFork(url, pin);
        }

        uint16[] memory gc = new uint16[](2);
        uint8[] memory gk = new uint8[](2);
        gc[0] = 0;
        gc[1] = 1;
        gk[0] = 13;
        gk[1] = 1;
        pit = new PixelPit(CORE, gc, gk);
    }

    modifier onlyFork() {
        if (!enabled) {
            vm.skip(true);
            return;
        }
        _;
    }

    function test_FORK_genesisAndCoreRead() public onlyFork {
        console.log("fork block     ", block.number);
        console.log("GENESIS_HEIGHT ", pit.GENESIS_HEIGHT());
        assertGe(pit.GENESIS_HEIGHT(), 8430, "GENESIS_HEIGHT >= 8430");
        assertEq(pit.CORE(), CORE);

        // raw selector check against the live proxy: 8 words, word 3 == GENESIS_HEIGHT
        (bool ok, bytes memory ret) = CORE.staticcall(abi.encodeWithSelector(0xc19d93fb));
        assertTrue(ok);
        assertEq(ret.length, 256, "state() returns 8 words");
        uint256 w3;
        assembly {
            w3 := mload(add(ret, 0x80))
        }
        assertEq(w3, pit.GENESIS_HEIGHT(), "word 3 is blockHeight");

        uint64 h = pit.coreHeight();
        assertEq(h, pit.GENESIS_HEIGHT());
    }

    /// @dev The Core read itself (cold account + state() behind the proxy), measured with the exact
    ///      gas-capped staticcall PixelPit uses (§5.3). Must stay < 20k so the 60k cap keeps a 3x margin.
    function test_FORK_coreReadUnder20kGas() public onlyFork {
        address core = CORE;
        uint256 g;
        bool ok;
        uint256 w;
        uint256 rds;
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0xc19d93fb00000000000000000000000000000000000000000000000000000000)
            g := gas()
            ok := staticcall(60000, core, ptr, 4, ptr, 0x100)
            g := sub(g, gas())
            rds := returndatasize()
            w := mload(add(ptr, 0x60))
        }
        assertTrue(ok, "staticcall ok");
        assertEq(rds, 256, "8 words");
        assertEq(w, pit.GENESIS_HEIGHT(), "blockHeight");
        console.log("raw Core.state() staticcall gas (cold):", g);
        assertLt(g, 20_000, "Core read must stay < 20k gas");

        // for the record: full pit.coreHeight() round trip, cold and warm
        uint256 g2 = gasleft();
        pit.coreHeight();
        g2 -= gasleft();
        console.log("pit.coreHeight() gas (pit cold, core warm):", g2);
        g2 = gasleft();
        pit.coreHeight();
        g2 -= gasleft();
        console.log("pit.coreHeight() gas (all warm):", g2);
    }

    function test_FORK_joinThenPaintRevertsZeroBudget() public onlyFork {
        vm.prank(alice);
        pit.join(3);
        (bool joined, bool coreOk, uint64 h, uint8 ready,,,,) = pit.budgetOf(alice);
        assertTrue(joined);
        assertTrue(coreOk);
        assertEq(h, pit.GENESIS_HEIGHT());
        assertEq(ready, 0);

        uint16[] memory c = new uint16[](1);
        uint8[] memory k = new uint8[](1);
        c[0] = 5;
        k[0] = 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PixelPit.InsufficientBudget.selector, uint8(0), uint256(1)));
        pit.paint(c, k);
    }
}
