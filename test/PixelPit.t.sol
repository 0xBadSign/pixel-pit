// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {PixelPit} from "../src/PixelPit.sol";
import {MockCore} from "./mocks/MockCore.sol";

/// @notice Unit tests for the §5.11 matrix (T1-T24). Invariants live in PixelPit.invariant.t.sol,
///         the Sepolia fork test in PixelPit.fork.t.sol, LAYOUT in script/check-layout.sh.
contract PixelPitTest is Test {
    uint64 internal constant H0 = 8430;
    uint8 internal constant CAP = 40;

    MockCore internal mock;
    PixelPit internal pit;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    // small genesis for the unit tests: 3 cells (word 0 twice, word 127 once)
    uint16[] internal gCells;
    uint8[] internal gColors;

    event GenesisSeeded(uint16 cellCount, uint64 coreHeight);
    event Joined(address indexed player, uint32 indexed playerId, uint8 crew, uint64 coreHeight);
    event Painted(
        address indexed player,
        uint64 indexed coreHeight,
        uint32 indexed playerId,
        uint16[] cells,
        uint8[] colors,
        uint8 budgetLeft
    );

    function setUp() public virtual {
        mock = new MockCore(H0);
        gCells.push(0);
        gColors.push(13);
        gCells.push(1);
        gColors.push(1);
        gCells.push(1023);
        gColors.push(4);
        pit = new PixelPit(address(mock), gCells, gColors);
        vm.deal(alice, 10 ether);
    }

    // =====================================================================
    //                                helpers
    // =====================================================================

    struct Budget {
        bool joined;
        bool coreOk;
        uint64 h;
        uint8 ready;
        uint8 banked;
        uint8 fresh;
        uint64 arrived;
        uint64 forfeited;
    }

    function _budget(address p) internal view returns (Budget memory b) {
        (b.joined, b.coreOk, b.h, b.ready, b.banked, b.fresh, b.arrived, b.forfeited) = pit.budgetOf(p);
    }

    function _join(address who, uint8 crew) internal {
        vm.prank(who);
        pit.join(crew);
    }

    /// @dev n cells starting at `start` with `stride`, all colour `color`.
    function _stroke(uint256 n, uint16 start, uint16 stride, uint8 color)
        internal
        pure
        returns (uint16[] memory cells, uint8[] memory colors)
    {
        cells = new uint16[](n);
        colors = new uint8[](n);
        for (uint256 i = 0; i < n; ++i) {
            cells[i] = uint16(start + i * stride);
            colors[i] = color;
        }
    }

    function _paint(address who, uint256 n, uint16 start, uint16 stride, uint8 color) internal {
        (uint16[] memory c, uint8[] memory k) = _stroke(n, start, stride, color);
        vm.prank(who);
        pit.paint(c, k);
    }

    function _expectInsufficient(uint8 have, uint256 need) internal {
        vm.expectRevert(abi.encodeWithSelector(PixelPit.InsufficientBudget.selector, have, need));
    }

    function _rawEq(uint256[128] memory a, uint256[128] memory b) internal pure returns (bool) {
        for (uint256 i = 0; i < 128; ++i) {
            if (a[i] != b[i]) return false;
        }
        return true;
    }

    /// @dev crewScores + genesis + empty == 1024 (T20)
    function _assertCanvasAccounting() internal view {
        uint16[4] memory held = pit.crewScores();
        uint256 genesis;
        uint256 empty;
        for (uint16 i = 0; i < 1024; ++i) {
            (, , uint32 pid, bool g) = pit.cell(i);
            if (g) genesis++;
            else if (pid == 0) empty++;
        }
        assertEq(uint256(held[0]) + held[1] + held[2] + held[3] + genesis + empty, 1024, "canvas accounting");
    }

    // =====================================================================
    //                          constructor / immutables
    // =====================================================================

    function test_immutables() public view {
        assertEq(pit.CORE(), address(mock));
        assertEq(pit.GENESIS_HEIGHT(), H0);
        assertEq(pit.DEPLOY_BLOCK(), uint64(block.number));
        assertEq(pit.seasonId(), 1);
        assertEq(pit.CAP(), 40);
        assertEq(pit.CELLS(), 1024);
        assertEq(pit.MAX_PLAYERS(), 0xFFFFFF);
    }

    function test_constructor_revertsOnUnreadableCore() public {
        mock.setRevertNext(true);
        vm.expectRevert(PixelPit.CoreUnavailable.selector);
        new PixelPit(address(mock), gCells, gColors);
        mock.setRevertNext(false);

        // EOA core (contract-less address)
        vm.expectRevert(PixelPit.CoreUnavailable.selector);
        new PixelPit(makeAddr("eoaCore"), gCells, gColors);
    }

    // =====================================================================
    //                                T1 - T4
    // =====================================================================

    function test_T1_joinGate() public {
        vm.expectEmit(true, true, true, true, address(pit));
        emit Joined(alice, 1, 3, H0);
        _join(alice, 3);

        Budget memory b = _budget(alice);
        assertTrue(b.joined);
        assertTrue(b.coreOk);
        assertEq(b.h, H0);
        assertEq(b.ready, 0);
        assertEq(b.banked, 0);
        assertEq(b.fresh, 0);
        assertEq(b.arrived, 0);
        assertEq(b.forfeited, 0);

        PixelPit.Player memory p = pit.players(alice);
        assertEq(p.credited, H0);
        assertEq(p.lastHeight, H0);
        assertEq(p.id, 1);
        assertEq(p.crew, 3);
        assertEq(p.strokes, 0);
        assertTrue(p.joined);

        // join gate: opening 50 wallets with no new blocks earns nothing
        for (uint256 i = 0; i < 50; ++i) {
            address w = address(uint160(0x1000 + i));
            _join(w, uint8(i % 4));
            assertEq(_budget(w).ready, 0);
        }
    }

    function test_T2_doubleJoin() public {
        _join(alice, 0);
        vm.expectRevert(PixelPit.AlreadyJoined.selector);
        _join(alice, 1);
    }

    function test_T3_badCrew() public {
        vm.expectRevert(abi.encodeWithSelector(PixelPit.BadCrew.selector, uint8(4)));
        _join(alice, 4);
        vm.expectRevert(abi.encodeWithSelector(PixelPit.BadCrew.selector, uint8(255)));
        _join(alice, 255);
    }

    function test_T4_notJoinedPaint() public {
        mock.bump(43);
        vm.expectRevert(PixelPit.NotJoined.selector);
        _paint(alice, 1, 100, 1, 5);
    }

    // =====================================================================
    //                          T5 - T10 budget maths
    // =====================================================================

    function test_T5_plus43FillsEmptyBrush() public {
        _join(alice, 3);
        mock.jump(43);
        Budget memory b = _budget(alice);
        assertEq(b.h, 8473);
        assertEq(b.ready, 40);
        assertEq(b.banked, 0);
        assertEq(b.fresh, 40);
        assertEq(b.arrived, 43);
        assertEq(b.forfeited, 3);
    }

    function test_T6_plus12() public {
        _join(alice, 0);
        mock.jump(12);
        Budget memory b = _budget(alice);
        assertEq(b.ready, 12);
        assertEq(b.fresh, 12);
        assertEq(b.arrived, 12);
        assertEq(b.forfeited, 0);
    }

    function test_T7_plus318CatchUp() public {
        _join(alice, 0);
        mock.jump(318);
        Budget memory b = _budget(alice);
        assertEq(b.ready, 40);
        assertEq(b.forfeited, 278);
        assertEq(b.arrived, 318);
    }

    /// @dev Worked example §3.5, row by row.
    function test_T8_workedExample() public {
        _join(alice, 3); // 14:00 join(Moon) H 8430
        mock.jump(43); // 21:42 +43 -> 8473
        _paint(alice, 30, 64, 1, 9); // 21:43 paint(30)

        PixelPit.Player memory p = pit.players(alice);
        assertEq(p.credited, 8463);
        assertEq(p.lastHeight, 8473);
        Budget memory b = _budget(alice);
        assertEq(b.ready, 10);
        assertEq(b.banked, 10);
        assertEq(b.fresh, 0);
        assertEq(b.arrived, 0);
        assertEq(b.forfeited, 0);

        mock.jump(57); // 21:52 +57 -> 8530
        b = _budget(alice);
        assertEq(b.h, 8530);
        assertEq(b.ready, 40);
        assertEq(b.banked, 10);
        assertEq(b.fresh, 30);
        assertEq(b.arrived, 57);
        assertEq(b.forfeited, 27);

        mock.setHeight(9322); // 07:10 night over, never painted
        b = _budget(alice);
        assertEq(b.ready, 40);
        assertEq(b.banked, 10);
        assertEq(b.fresh, 30);
        assertEq(b.arrived, 849);
        assertEq(b.forfeited, 819);
        p = pit.players(alice);
        assertEq(p.credited, 8463);
        assertEq(p.lastHeight, 8473);
    }

    function test_T9_twoPaintsSameTick() public {
        _join(alice, 1);
        mock.jump(43);
        _paint(alice, 10, 0, 1, 2);
        _paint(alice, 10, 32, 1, 2);
        assertEq(_budget(alice).ready, 20);
        _expectInsufficient(20, 21);
        _paint(alice, 21, 64, 1, 2);
    }

    function test_T10_spendBankedWithoutNewBlocks() public {
        _join(alice, 2);
        mock.jump(43);
        _paint(alice, 10, 0, 1, 7);
        Budget memory b = _budget(alice);
        assertEq(b.ready, 30);
        assertEq(b.banked, 30);
        assertEq(b.fresh, 0);
        assertEq(b.arrived, 0);
        _paint(alice, 30, 100, 1, 7);
        b = _budget(alice);
        assertEq(b.ready, 0);
        assertEq(b.fresh, 0);
        assertEq(b.arrived, 0);
        PixelPit.Player memory p = pit.players(alice);
        assertEq(p.credited, p.lastHeight);
        assertEq(p.strokes, 40);
    }

    // =====================================================================
    //                          T11 - T13 stroke validation
    // =====================================================================

    function test_T11_emptyTooManyMismatch() public {
        _join(alice, 0);
        mock.jump(43);

        uint16[] memory none = new uint16[](0);
        uint8[] memory noneC = new uint8[](0);
        vm.prank(alice);
        vm.expectRevert(PixelPit.EmptyStroke.selector);
        pit.paint(none, noneC);

        (uint16[] memory c41, uint8[] memory k41) = _stroke(41, 0, 1, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PixelPit.TooManyCells.selector, uint256(41)));
        pit.paint(c41, k41);

        (uint16[] memory c2,) = _stroke(2, 0, 1, 1);
        uint8[] memory k1 = new uint8[](1);
        vm.prank(alice);
        vm.expectRevert(PixelPit.LengthMismatch.selector);
        pit.paint(c2, k1);
    }

    function test_T12_badCellBadColorMidArray_noStateChange() public {
        _join(alice, 0);
        mock.jump(43);
        _paint(alice, 3, 200, 1, 5); // make sure some state exists
        uint256[128] memory before = pit.rawCells();
        PixelPit.Player memory pBefore = pit.players(alice);
        uint64 strokesBefore = pit.totalStrokes();

        (uint16[] memory c, uint8[] memory k) = _stroke(5, 300, 1, 2);
        c[2] = 1024;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PixelPit.BadCell.selector, uint16(1024)));
        pit.paint(c, k);

        (c, k) = _stroke(5, 300, 1, 2);
        k[3] = 16;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PixelPit.BadColor.selector, uint8(16)));
        pit.paint(c, k);

        assertTrue(_rawEq(before, pit.rawCells()), "canvas changed");
        PixelPit.Player memory pAfter = pit.players(alice);
        assertEq(pAfter.credited, pBefore.credited);
        assertEq(pAfter.lastHeight, pBefore.lastHeight);
        assertEq(pAfter.strokes, pBefore.strokes);
        assertEq(pit.totalStrokes(), strokesBefore);

        vm.expectRevert(abi.encodeWithSelector(PixelPit.BadCell.selector, uint16(1024)));
        pit.cell(1024);
    }

    function test_T13_duplicateCellsBurnEach_lastColorWins() public {
        _join(alice, 1);
        mock.jump(43);
        uint16[] memory c = new uint16[](3);
        uint8[] memory k = new uint8[](3);
        c[0] = 77;
        c[1] = 77;
        c[2] = 77;
        k[0] = 1;
        k[1] = 2;
        k[2] = 3;
        vm.prank(alice);
        pit.paint(c, k);
        assertEq(_budget(alice).ready, 37);
        (uint8 color, uint8 crew, uint32 pid, bool g) = pit.cell(77);
        assertEq(color, 3);
        assertEq(crew, 1);
        assertEq(pid, 1);
        assertFalse(g);
        assertEq(pit.players(alice).strokes, 3);
        assertEq(pit.totalStrokes(), 3);

        // repainting the same colour also burns
        (c, k) = _stroke(1, 77, 1, 3);
        vm.prank(alice);
        pit.paint(c, k);
        assertEq(_budget(alice).ready, 36);
    }

    // =====================================================================
    //                          T14 / T14b Core failure modes
    // =====================================================================

    function _assertCoreDown(address joinedPlayer, address freshPlayer) internal {
        Budget memory b = _budget(joinedPlayer);
        assertTrue(b.joined);
        assertFalse(b.coreOk, "coreOk should be false");
        assertEq(b.h, 0);
        assertEq(b.ready, 0);
        assertEq(b.arrived, 0);

        vm.expectRevert(PixelPit.CoreUnavailable.selector);
        pit.coreHeight();

        vm.prank(freshPlayer);
        vm.expectRevert(PixelPit.CoreUnavailable.selector);
        pit.join(0);

        (uint16[] memory c, uint8[] memory k) = _stroke(1, 5, 1, 1);
        vm.prank(joinedPlayer);
        vm.expectRevert(PixelPit.CoreUnavailable.selector);
        pit.paint(c, k);
    }

    function test_T14_coreRevert() public {
        _join(alice, 0);
        mock.jump(43);
        mock.setRevertNext(true);
        _assertCoreDown(alice, bob);
        mock.setRevertNext(false);
        assertEq(_budget(alice).ready, 40, "recovers");
    }

    function test_T14_coreMalformed() public {
        _join(alice, 0);
        mock.jump(43);
        mock.setMalformedNext(true);
        _assertCoreDown(alice, bob);
        mock.setMalformedNext(false);
        assertEq(_budget(alice).ready, 40, "recovers");
    }

    function test_T14_coreEOA() public {
        _join(alice, 0);
        mock.jump(43);
        bytes memory code = address(mock).code;
        vm.etch(address(mock), "");
        assertEq(address(mock).code.length, 0, "mock should have no code");
        _assertCoreDown(alice, bob);
        vm.etch(address(mock), code);
        assertEq(_budget(alice).ready, 40, "recovers");
    }

    /// @dev §5.11 `eoaMode`: the mock keeps its code but state() returns 0 bytes with success, which is
    ///      what the Pit sees from a code-less address. Same expectations as the vm.etch variant above.
    function test_T14_coreEOAMode() public {
        _join(alice, 0);
        mock.jump(43);
        mock.setEoaMode(true);
        _assertCoreDown(alice, bob);
        mock.clearModes();
        assertEq(_budget(alice).ready, 40, "recovers");
    }

    function test_T14b_gasBomb() public {
        _join(alice, 0);
        mock.jump(43);
        mock.setGasBombNext(true);
        uint256 g = gasleft();
        Budget memory b = _budget(alice);
        g -= gasleft();
        assertFalse(b.coreOk);
        assertLt(g, 120_000, "budgetOf gas under gas bomb");
        console.log("budgetOf gas (gas bomb):", g);
        _assertCoreDown(alice, bob);
        mock.setGasBombNext(false);
        assertEq(_budget(alice).ready, 40, "recovers");
    }

    function test_T14b_returnBomb1MB() public {
        _join(alice, 0);
        mock.jump(43);
        mock.setReturnBombNext(true);
        uint256 g = gasleft();
        Budget memory b = _budget(alice);
        g -= gasleft();
        assertFalse(b.coreOk);
        assertLt(g, 120_000, "budgetOf gas under return bomb");
        console.log("budgetOf gas (return bomb):", g);
        _assertCoreDown(alice, bob);
        mock.setReturnBombNext(false);
        assertEq(_budget(alice).ready, 40, "recovers");
    }

    // =====================================================================
    //                          T15a / T15b height moves backwards
    // =====================================================================

    function test_T15a_partialDecrease() public {
        _join(alice, 0);
        mock.jump(43); // 8473
        _paint(alice, 30, 0, 1, 1); // credited 8463, lastHeight 8473, banked 10

        mock.setHeight(8468); // GENESIS <= H < lastHeight
        Budget memory b = _budget(alice);
        assertTrue(b.coreOk);
        assertEq(b.ready, 5);
        assertEq(b.banked, 5);
        assertEq(b.fresh, 0);
        assertEq(b.arrived, 0);
        assertEq(b.forfeited, 0);
        assertEq(pit.players(alice).credited, 8463, "credited unchanged");

        _expectInsufficient(5, 6);
        _paint(alice, 6, 100, 1, 1);
        _paint(alice, 5, 100, 1, 1); // largest accepted n == ready
        assertEq(_budget(alice).ready, 0);

        // height below credited but above genesis: ready 0, no revert
        mock.setHeight(H0 + 1);
        b = _budget(alice);
        assertTrue(b.coreOk);
        assertEq(b.ready, 0);
        _expectInsufficient(0, 1);
        _paint(alice, 1, 100, 1, 1);
    }

    function test_T15b_belowGenesisFreezes() public {
        _join(alice, 0);
        mock.jump(43);
        mock.setHeight(H0 - 1);
        _assertCoreDown(alice, bob);
        mock.setHeight(0);
        _assertCoreDown(alice, bob);
        // exactly GENESIS is fine
        mock.setHeight(H0);
        assertTrue(_budget(alice).coreOk);
        assertEq(pit.coreHeight(), H0);
    }

    function test_T16_paused() public {
        _join(alice, 0);
        mock.jump(43);
        _paint(alice, 10, 0, 1, 1);
        mock.setPaused(true);
        assertEq(pit.coreHeight(), 8473);
        Budget memory b = _budget(alice);
        assertTrue(b.coreOk);
        assertEq(b.ready, 30);
        _paint(alice, 30, 100, 1, 1); // banked still spendable
        assertEq(_budget(alice).ready, 0);
        _join(bob, 1); // joins still work
        mock.setPaused(false);
    }

    // =====================================================================
    //                          T17 + INV4 cell record isolation (fuzz)
    // =====================================================================

    mapping(uint16 => uint32) internal refRec;

    function testFuzz_T17_INV4_cellIsolation(uint256 seed, uint8 nRaw, uint8 crewRaw) public {
        uint256 n = bound(nRaw, 1, 40);
        uint8 crew = crewRaw % 4;
        _join(bob, 1); // id 1 paints a bit of noise first
        _join(alice, crew); // id 2
        mock.jump(43);

        // background noise by bob so the canvas is not blank
        (uint16[] memory nc, uint8[] memory nk) = _stroke(20, uint16(seed % 1000), 1, 5);
        vm.prank(bob);
        pit.paint(nc, nk);

        uint256[128] memory before = pit.rawCells();
        uint16[] memory cells = new uint16[](n);
        uint8[] memory colors = new uint8[](n);
        for (uint256 i = 0; i < n; ++i) {
            bytes32 r = keccak256(abi.encode(seed, i));
            cells[i] = uint16(uint256(r) % 1024);
            colors[i] = uint8(uint256(r >> 16) % 16);
        }

        // reference model: last stroke wins
        for (uint16 i = 0; i < 1024; ++i) {
            refRec[i] = uint32((before[i >> 3] >> ((i & 7) << 5)) & 0xFFFFFFFF);
        }
        for (uint256 i = 0; i < n; ++i) {
            refRec[cells[i]] = (uint32(2) << 8) | (uint32(crew) << 4) | colors[i];
        }

        vm.prank(alice);
        pit.paint(cells, colors);

        uint256[128] memory after_ = pit.rawCells();
        for (uint16 i = 0; i < 1024; ++i) {
            uint32 rec = uint32((after_[i >> 3] >> ((i & 7) << 5)) & 0xFFFFFFFF);
            assertEq(rec, refRec[i], "cell record mismatch");
            assertEq((rec >> 7) & 1, 0, "spare bit 7 must be 0");
            (uint8 color, uint8 cw, uint32 pid, bool g) = pit.cell(i);
            assertEq(color, uint8(rec & 0xF));
            assertEq(cw, uint8((rec >> 4) & 3));
            assertEq(pid, rec >> 8);
            assertEq(g, ((rec >> 6) & 1) == 1);
            assertLe(pid, 0xFFFFFF, "painterId is 24 bits");
        }
        assertEq(pit.players(alice).strokes, uint32(n));
    }

    // =====================================================================
    //                          T18 event content
    // =====================================================================

    function test_T18_paintedEventExact() public {
        _join(alice, 2);
        mock.jump(43);
        (uint16[] memory c, uint8[] memory k) = _stroke(7, 40, 3, 11);
        vm.expectEmit(true, true, true, true, address(pit));
        emit Painted(alice, 8473, 1, c, k, 33);
        vm.prank(alice);
        pit.paint(c, k);
    }

    // =====================================================================
    //                          T19 genesis constructor
    // =====================================================================

    function _loadFixture() internal view returns (uint16[] memory cells, uint8[] memory colors) {
        string memory json = vm.readFile("test/fixtures/genesis.json");
        uint256[] memory rc = abi.decode(vm.parseJson(json, ".cells"), (uint256[]));
        uint256[] memory rk = abi.decode(vm.parseJson(json, ".colors"), (uint256[]));
        cells = new uint16[](rc.length);
        colors = new uint8[](rk.length);
        for (uint256 i = 0; i < rc.length; ++i) cells[i] = uint16(rc[i]);
        for (uint256 i = 0; i < rk.length; ++i) colors[i] = uint8(rk[i]);
    }

    /// @dev §5.7: genesis/hamster.png -> tools/genesis.ts (pngjs, nearest palette colour, cells ascending)
    ///      -> test/fixtures/genesis.json. Solidity cannot inflate a PNG, so the PNG decode step lives in
    ///      the tool and this test consumes its output; the §5.7 picture rules are asserted on the arrays
    ///      (paint-by-numbers: only 13 brown / 1 white / 4 red, no duplicates, roughly 150-220 cells).
    ///      Regenerate the fixture with `npm run genesis` in tools/ whenever hamster.png changes.
    function test_T19_genesisFromFixture() public {
        (uint16[] memory cells, uint8[] memory colors) = _loadFixture();
        assertGt(cells.length, 0);
        assertEq(cells.length, colors.length);
        assertGe(cells.length, 100, "genesis too small for the Season 1 picture (spec 5.7: ~150-220)");
        assertLe(cells.length, 300, "genesis too large for the Season 1 picture (spec 5.7: ~150-220)");
        for (uint256 i = 0; i < cells.length; ++i) {
            assertLt(cells[i], 1024, "fixture cell out of range");
            if (i > 0) assertGt(cells[i], cells[i - 1], "fixture cells must be ascending (tool output)");
            assertTrue(colors[i] == 13 || colors[i] == 1 || colors[i] == 4, "fixture colour outside spec 5.7 set");
        }

        vm.expectEmit(true, true, true, true);
        emit GenesisSeeded(uint16(cells.length), H0);
        PixelPit g = new PixelPit(address(mock), cells, colors);

        // every genesis cell matches, painterId 0, crew 0, genesis bit set
        bool[1024] memory isGenesis;
        for (uint256 i = 0; i < cells.length; ++i) {
            (uint8 color, uint8 crew, uint32 pid, bool gen) = g.cell(cells[i]);
            assertEq(color, colors[i], "genesis colour");
            assertEq(crew, 0);
            assertEq(pid, 0);
            assertTrue(gen, "genesis bit");
            isGenesis[cells[i]] = true;
        }
        // everything else is pit black / untouched
        uint256 genesisCount;
        for (uint16 i = 0; i < 1024; ++i) {
            (uint8 color,, uint32 pid, bool gen) = g.cell(i);
            if (isGenesis[i]) {
                genesisCount++;
            } else {
                assertEq(color, 0);
                assertEq(pid, 0);
                assertFalse(gen);
            }
        }
        assertEq(genesisCount, cells.length, "fixture has duplicate cells");

        uint16[4] memory held = g.crewScores();
        assertEq(uint256(held[0]) + held[1] + held[2] + held[3], 0, "genesis excluded from crewScores");
        assertEq(g.playerAt(0), address(0));
        assertEq(g.playerCount(), 0);
        assertEq(g.totalStrokes(), 0);

        // anyone can overpaint genesis
        vm.prank(alice);
        g.join(3);
        mock.jump(43);
        (uint16[] memory c, uint8[] memory k) = _stroke(1, cells[0], 1, 9);
        vm.prank(alice);
        g.paint(c, k);
        (uint8 col2, uint8 crew2, uint32 pid2, bool gen2) = g.cell(cells[0]);
        assertEq(col2, 9);
        assertEq(crew2, 3);
        assertEq(pid2, 1);
        assertFalse(gen2, "genesis bit cleared when overpainted");
    }

    function test_T19_genesisBadInputsRevert() public {
        uint16[] memory c = new uint16[](2);
        uint8[] memory k = new uint8[](2);
        c[0] = 5;
        c[1] = 1024;
        k[0] = 1;
        k[1] = 1;
        vm.expectRevert(abi.encodeWithSelector(PixelPit.BadCell.selector, uint16(1024)));
        new PixelPit(address(mock), c, k);

        c[1] = 6;
        k[1] = 16;
        vm.expectRevert(abi.encodeWithSelector(PixelPit.BadColor.selector, uint8(16)));
        new PixelPit(address(mock), c, k);

        uint8[] memory k1 = new uint8[](1);
        vm.expectRevert(PixelPit.LengthMismatch.selector);
        new PixelPit(address(mock), c, k1);

        // empty genesis is allowed
        PixelPit e = new PixelPit(address(mock), new uint16[](0), new uint8[](0));
        assertEq(e.GENESIS_HEIGHT(), H0);
    }

    // =====================================================================
    //                          T20 canvas accounting
    // =====================================================================

    function test_T20_crewScoresPlusGenesisPlusEmpty() public {
        _assertCanvasAccounting();
        _join(alice, 0);
        _join(bob, 2);
        mock.jump(43);
        _paint(alice, 40, 0, 1, 1); // overwrites genesis cells 0 and 1
        _assertCanvasAccounting();
        _paint(bob, 20, 20, 1, 7); // overlaps alice
        _assertCanvasAccounting();
        uint16[4] memory held = pit.crewScores();
        assertEq(held[0], 20);
        assertEq(held[2], 20);
        assertEq(held[1], 0);
        assertEq(held[3], 0);
        _paint(bob, 20, 1000, 1, 7); // overwrites genesis 1023
        _assertCanvasAccounting();
        held = pit.crewScores();
        assertEq(held[2], 40);
    }

    // =====================================================================
    //                          T22 / T23 / T24
    // =====================================================================

    function test_T22_playerAtCountStrokes() public {
        assertEq(pit.playerAt(0), address(0));
        assertEq(pit.playerCount(), 0);
        assertEq(pit.totalStrokes(), 0);
        _join(alice, 0);
        assertEq(pit.players(alice).id, 1);
        assertEq(pit.playerAt(1), alice);
        assertEq(pit.playerCount(), 1);
        _join(bob, 1);
        _join(carol, 2);
        assertEq(pit.playerAt(2), bob);
        assertEq(pit.playerAt(3), carol);
        assertEq(pit.playerCount(), 3);
        vm.expectRevert();
        pit.playerAt(4);

        mock.jump(43);
        _paint(alice, 7, 0, 1, 1);
        _paint(bob, 9, 50, 1, 1);
        assertEq(pit.totalStrokes(), 16);
        assertEq(uint256(pit.players(alice).strokes) + pit.players(bob).strokes + pit.players(carol).strokes, 16);
    }

    function test_T23_ethRejected() public {
        vm.prank(alice);
        (bool ok,) = address(pit).call{value: 1 ether}("");
        assertFalse(ok, "plain transfer must revert");
        vm.prank(alice);
        (ok,) = address(pit).call{value: 1 wei}(abi.encodeWithSignature("join(uint8)", 0));
        assertFalse(ok, "non-payable join must revert on value");
        vm.prank(alice);
        (ok,) = address(pit).call(abi.encodeWithSignature("doesNotExist()"));
        assertFalse(ok, "no fallback");
        assertEq(address(pit).balance, 0);
    }

    function test_T24_idWidthBeyond16Bits() public {
        // _playerById is slot 129; its length lives in that slot
        vm.store(address(pit), bytes32(uint256(129)), bytes32(uint256(65_535)));
        assertEq(pit.playerCount(), 65_534);

        vm.expectEmit(true, true, true, true, address(pit));
        emit Joined(alice, 65_535, 1, H0);
        _join(alice, 1);
        assertEq(pit.players(alice).id, 65_535);
        assertEq(pit.playerAt(65_535), alice);

        vm.expectEmit(true, true, true, true, address(pit));
        emit Joined(bob, 65_536, 2, H0);
        _join(bob, 2);
        assertEq(pit.players(bob).id, 65_536);
        assertEq(pit.playerAt(65_536), bob);
        assertEq(pit.playerCount(), 65_536);

        mock.jump(43);
        (uint16[] memory c, uint8[] memory k) = _stroke(3, 500, 1, 6);
        vm.expectEmit(true, true, true, true, address(pit));
        emit Painted(bob, 8473, 65_536, c, k, 37);
        vm.prank(bob);
        pit.paint(c, k);
        (uint8 color, uint8 crew, uint32 pid, bool g) = pit.cell(501);
        assertEq(color, 6);
        assertEq(crew, 2);
        assertEq(pid, 65_536, "painterId decodes beyond 16 bits");
        assertFalse(g);

        // at MAX_PLAYERS + 1 entries the next id would be 0x1000000 -> PlayerLimit
        vm.store(address(pit), bytes32(uint256(129)), bytes32(uint256(0xFFFFFF) + 1));
        vm.prank(carol);
        vm.expectRevert(PixelPit.PlayerLimit.selector);
        pit.join(0);

        // exactly MAX_PLAYERS entries: id MAX_PLAYERS still allowed
        vm.store(address(pit), bytes32(uint256(129)), bytes32(uint256(0xFFFFFF)));
        _join(carol, 0);
        assertEq(pit.players(carol).id, 0xFFFFFF);
        mock.jump(1);
        (c, k) = _stroke(1, 600, 1, 1);
        vm.prank(carol);
        pit.paint(c, k);
        (,, pid,) = pit.cell(600);
        assertEq(pid, 0xFFFFFF);
    }

    // =====================================================================
    //                          gas measurements (§5.10)
    // =====================================================================

    function _measure(address who, uint16[] memory c, uint8[] memory k) internal returns (uint256 g) {
        vm.prank(who);
        g = gasleft();
        pit.paint(c, k);
        g -= gasleft();
    }

    function test_gas_join() public {
        vm.prank(alice);
        uint256 g = gasleft();
        pit.join(0);
        g -= gasleft();
        console.log("gas join (call only, +21k intrinsic):", g);
    }

    function test_gas_paint1_writtenWord() public {
        _join(alice, 0);
        mock.jump(43);
        _paint(alice, 1, 64, 1, 1); // word 8 now non-zero
        (uint16[] memory c, uint8[] memory k) = _stroke(1, 65, 1, 2);
        console.log("gas paint(1) written word (call only):", _measure(alice, c, k));
    }

    function test_gas_paint40_sameRow() public {
        _join(alice, 0);
        mock.jump(43);
        _paint(alice, 32, 64, 1, 1); // row 2 (words 8..11) written
        _paint(alice, 8, 96, 1, 1); // word 12 written
        mock.jump(43);
        // 40 cells: row 2 (32) + first 8 of row 3 = 5 consecutive words
        (uint16[] memory c, uint8[] memory k) = _stroke(40, 64, 1, 2);
        console.log("gas paint(40) same row / 5 words (call only):", _measure(alice, c, k));
    }

    function test_gas_paint40_40words_written() public {
        _join(alice, 0);
        mock.jump(43);
        _paint(alice, 40, 0, 8, 1); // one cell in each of words 0..39
        mock.jump(43);
        (uint16[] memory c, uint8[] memory k) = _stroke(40, 1, 8, 2);
        console.log("gas paint(40) 40 words, all written (call only):", _measure(alice, c, k));
    }

    function test_gas_paint40_40words_fresh() public {
        _join(alice, 0);
        mock.jump(43);
        // words 40..79 are untouched (genesis is in words 0 and 127)
        (uint16[] memory c, uint8[] memory k) = _stroke(40, 320, 8, 2);
        console.log("gas paint(40) 40 words, none written (call only):", _measure(alice, c, k));
    }

    function test_gas_budgetOf() public {
        _join(alice, 0);
        mock.jump(43);
        uint256 g = gasleft();
        pit.budgetOf(alice);
        g -= gasleft();
        console.log("gas budgetOf (call only):", g);
    }

    function test_gas_crewScores() public {
        _join(alice, 0);
        mock.jump(43);
        _paint(alice, 40, 0, 8, 1);
        uint256 g = gasleft();
        pit.crewScores();
        g -= gasleft();
        console.log("gas crewScores (call only):", g);
    }
}
