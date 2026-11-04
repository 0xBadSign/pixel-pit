// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {PixelPit} from "../src/PixelPit.sol";
import {MockCore} from "./mocks/MockCore.sol";

// =====================================================================
//                       hostile Core doubles
// =====================================================================

/// Reverts with exactly 256 bytes of revert data (returndatasize == 0x100 but call failed).
contract Revert256Core {
    function state() external pure {
        assembly {
            mstore(0x60, 9999)
            revert(0, 0x100)
        }
    }
}

/// Returns 257 bytes with a valid-looking height in word 3.
contract Return257Core {
    function state() external pure {
        assembly {
            mstore(0x60, 9999)
            return(0, 0x101)
        }
    }
}

/// Returns 256 bytes with dirty upper bits in word 3 (height > uint64 max).
contract DirtyHeightCore {
    uint256 public w3 = (uint256(1) << 64) | 9999;

    function set(uint256 v) external {
        w3 = v;
    }

    function state() external view {
        uint256 v = w3;
        assembly {
            mstore(0x60, v)
            return(0, 0x100)
        }
    }
}

/// Returns as much returndata as the 60k cap allows (~96 KB) — cheap for the callee, never copied by the Pit.
contract BigReturnCore {
    uint256 public size = 96 * 1024;

    function setSize(uint256 s) external {
        size = s;
    }

    function state() external view {
        uint256 s = size;
        assembly {
            return(0, s)
        }
    }
}

/// Burns a configurable amount of gas, then returns a valid 256-byte state.
contract HungryCore {
    uint256 public burn;
    uint64 public height = 9000;

    function setBurn(uint256 b) external {
        burn = b;
    }

    function setHeight(uint64 h) external {
        height = h;
    }

    function state() external view {
        uint256 start = gasleft();
        while (start - gasleft() < burn) {}
        uint64 h = height;
        assembly {
            mstore(0x00, 0)
            mstore(0x20, 0)
            mstore(0x40, 0)
            mstore(0x60, h)
            mstore(0x80, 0)
            mstore(0xa0, 0)
            mstore(0xc0, 0)
            mstore(0xe0, 0)
            return(0, 0x100)
        }
    }
}

/// During state(), tries to re-enter the Pit with writes (swallowing the failure) and still returns a valid height.
contract ReentrantCore {
    PixelPit public pit;
    uint64 public height = 9000;
    bool public armed;

    function setPit(PixelPit p) external {
        pit = p;
    }

    function setHeight(uint64 h) external {
        height = h;
    }

    function arm(bool a) external {
        armed = a;
    }

    function state() external view {
        if (armed && address(pit) != address(0)) {
            uint16[] memory c = new uint16[](1);
            uint8[] memory col = new uint8[](1);
            // static context: these must fail; swallow them
            (bool s1,) = address(pit).staticcall{gas: 8000}(abi.encodeCall(PixelPit.join, (0)));
            (bool s2,) = address(pit).staticcall{gas: 8000}(abi.encodeCall(PixelPit.paint, (c, col)));
            s1;
            s2;
        }
        uint64 h = height;
        assembly {
            let p := mload(0x40)
            mstore(p, 0)
            mstore(add(p, 0x20), 0)
            mstore(add(p, 0x40), 0)
            mstore(add(p, 0x60), h)
            mstore(add(p, 0x80), 0)
            mstore(add(p, 0xa0), 0)
            mstore(add(p, 0xc0), 0)
            mstore(add(p, 0xe0), 0)
            return(p, 0x100)
        }
    }
}

// =====================================================================
//                              audit suite
// =====================================================================

contract PixelPitAuditTest is Test {
    uint64 internal constant H0 = 8430;
    uint8 internal constant CAP = 40;

    MockCore internal mock;
    PixelPit internal pit;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    event Painted(
        address indexed player,
        uint64 indexed coreHeight,
        uint32 indexed playerId,
        uint16[] cells,
        uint8[] colors,
        uint8 budgetLeft
    );
    event GenesisSeeded(uint16 cellCount, uint64 coreHeight);

    function setUp() public {
        mock = new MockCore(H0);
        uint16[] memory gc = new uint16[](0);
        uint8[] memory gk = new uint8[](0);
        pit = new PixelPit(address(mock), gc, gk);
    }

    // ---------------- helpers ----------------

    function _one(uint16 c, uint8 col) internal pure returns (uint16[] memory cs, uint8[] memory ks) {
        cs = new uint16[](1);
        ks = new uint8[](1);
        cs[0] = c;
        ks[0] = col;
    }

    function _n(uint256 n, uint16 start) internal pure returns (uint16[] memory cs, uint8[] memory ks) {
        cs = new uint16[](n);
        ks = new uint8[](n);
        for (uint256 i = 0; i < n; ++i) {
            cs[i] = uint16((start + i) % 1024);
            ks[i] = uint8(i % 16);
        }
    }

    function _ready(address p) internal view returns (uint8 r) {
        (,,, r,,,,) = pit.budgetOf(p);
    }

    function _coreOk(address p) internal view returns (bool ok) {
        (, ok,,,,,,) = pit.budgetOf(p);
    }

    /// Independent re-implementation of the §3.3 formula.
    function _refBudget(uint64 c, uint64 l, uint64 H)
        internal
        pure
        returns (uint8 ready, uint8 banked, uint8 fresh, uint64 arrived, uint64 forfeited)
    {
        uint64 raw = H > c ? H - c : 0;
        uint64 r = raw > 40 ? 40 : raw;
        uint64 b = (l - c) < r ? (l - c) : r; // credited <= lastHeight is an invariant
        ready = uint8(r);
        banked = uint8(b);
        fresh = uint8(r - b);
        arrived = H > l ? H - l : 0;
        forfeited = raw - r;
    }

    // =====================================================================
    // A. Core read hardening
    // =====================================================================

    function test_A1_revertWithExactly256Bytes_isUnavailable() public {
        Revert256Core c = new Revert256Core();
        uint16[] memory e = new uint16[](0);
        uint8[] memory k = new uint8[](0);
        vm.expectRevert(PixelPit.CoreUnavailable.selector);
        new PixelPit(address(c), e, k);
    }

    function test_A2_return257_isUnavailable() public {
        Return257Core c = new Return257Core();
        uint16[] memory e = new uint16[](0);
        uint8[] memory k = new uint8[](0);
        vm.expectRevert(PixelPit.CoreUnavailable.selector);
        new PixelPit(address(c), e, k);
    }

    function test_A3_dirtyUpperBits_isUnavailable_afterDeploy() public {
        DirtyHeightCore c = new DirtyHeightCore();
        uint16[] memory e = new uint16[](0);
        uint8[] memory k = new uint8[](0);
        vm.expectRevert(PixelPit.CoreUnavailable.selector);
        new PixelPit(address(c), e, k);

        c.set(9000);
        PixelPit p = new PixelPit(address(c), e, k);
        assertEq(p.GENESIS_HEIGHT(), 9000);
        vm.prank(alice);
        p.join(1);
        c.set((uint256(1) << 64) | 9100); // looks like 9100 if truncated
        (, bool ok,,,,,,) = p.budgetOf(alice);
        assertFalse(ok, "dirty word must not be truncated into a height");
        vm.expectRevert(PixelPit.CoreUnavailable.selector);
        p.coreHeight();
        c.set(type(uint64).max); // max uint64 is accepted (documented C-9: no upper bound)
        assertEq(p.coreHeight(), type(uint64).max);
        assertEq(_readyOf(p, alice), 40, "C-9: one-off refill of at most CAP");
    }

    function _readyOf(PixelPit p, address a) internal view returns (uint8 r) {
        (,,, r,,,,) = p.budgetOf(a);
    }

    function test_A4_bigCheapReturn_notCopied_budgetOfCheap() public {
        BigReturnCore c = new BigReturnCore();
        c.setSize(0x100);
        uint16[] memory e = new uint16[](0);
        uint8[] memory k = new uint8[](0);
        PixelPit p = new PixelPit(address(c), e, k); // height 0 (zeroed memory)
        assertEq(p.GENESIS_HEIGHT(), 0);
        c.setSize(96 * 1024);
        uint256 g = gasleft();
        (, bool ok,,,,,,) = p.budgetOf(alice);
        uint256 used = g - gasleft();
        console.log("budgetOf gas with ~96KB returndata:", used);
        assertFalse(ok);
        assertLt(used, 120_000);
    }

    function test_A5_hungryCore_underCap_ok_overCap_unavailable() public {
        HungryCore c = new HungryCore();
        uint16[] memory e = new uint16[](0);
        uint8[] memory k = new uint8[](0);
        PixelPit p = new PixelPit(address(c), e, k);
        vm.prank(alice);
        p.join(2);
        c.setBurn(50_000);
        assertTrue(_coreOkOf(p, alice), "50k burn fits in the 60k cap");
        c.setBurn(70_000);
        assertFalse(_coreOkOf(p, alice), "70k burn exceeds the cap");
        c.setHeight(9100);
        (uint16[] memory cs, uint8[] memory ks) = _one(5, 5);
        vm.prank(alice);
        vm.expectRevert(PixelPit.CoreUnavailable.selector);
        p.paint(cs, ks);
    }

    function _coreOkOf(PixelPit p, address a) internal view returns (bool ok) {
        (, ok,,,,,,) = p.budgetOf(a);
    }

    function test_A6_gasBomb_budgetOf_with150kGasCap_doesNotRevert() public {
        vm.prank(alice);
        pit.join(0);
        mock.setGasBombNext(true);
        (bool success, bytes memory ret) =
            address(pit).staticcall{gas: 150_000}(abi.encodeCall(PixelPit.budgetOf, (alice)));
        assertTrue(success, "budgetOf must not revert under gas bomb with 150k gas");
        (, bool ok,,,,,,) = abi.decode(ret, (bool, bool, uint64, uint8, uint8, uint8, uint64, uint64));
        assertFalse(ok);
    }

    function test_A7_reentrantCore_cannotWrite() public {
        ReentrantCore c = new ReentrantCore();
        uint16[] memory e = new uint16[](0);
        uint8[] memory k = new uint8[](0);
        PixelPit p = new PixelPit(address(c), e, k);
        c.setPit(p);
        c.arm(true);
        vm.prank(alice);
        p.join(3);
        c.setHeight(9040);
        (uint16[] memory cs, uint8[] memory ks) = _n(40, 0);
        vm.prank(alice);
        p.paint(cs, ks);
        assertEq(p.playerCount(), 1, "core could not join itself");
        assertEq(p.totalStrokes(), 40);
        assertEq(p.players(address(c)).joined, false);
    }

    function test_A8_heightExactlyGenesis_ok_minusOne_frozen() public {
        vm.prank(alice);
        pit.join(0);
        mock.setHeight(H0);
        assertTrue(_coreOk(alice));
        mock.setHeight(H0 - 1);
        assertFalse(_coreOk(alice));
        vm.prank(bob);
        vm.expectRevert(PixelPit.CoreUnavailable.selector);
        pit.join(0);
    }

    function test_A9_genesisHeightZero_and_max() public {
        MockCore z = new MockCore(0);
        uint16[] memory e = new uint16[](0);
        uint8[] memory k = new uint8[](0);
        PixelPit p0 = new PixelPit(address(z), e, k);
        assertEq(p0.GENESIS_HEIGHT(), 0);
        vm.prank(alice);
        p0.join(0);
        z.setHeight(100);
        assertEq(_readyOf(p0, alice), 40);

        DirtyHeightCore m = new DirtyHeightCore(); // MockCore(max) overflows its own uint96 maths
        m.set(type(uint64).max);
        PixelPit pm = new PixelPit(address(m), e, k);
        assertEq(pm.GENESIS_HEIGHT(), type(uint64).max);
        vm.prank(alice);
        pm.join(0);
        assertEq(_readyOf(pm, alice), 0);
        (uint16[] memory cs, uint8[] memory ks) = _one(1, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PixelPit.InsufficientBudget.selector, uint8(0), uint256(1)));
        pm.paint(cs, ks);
    }

    // =====================================================================
    // B. Budget math: differential fuzz vs independent reference + inflation bound
    // =====================================================================

    struct Ref {
        uint64 c;
        uint64 l;
        uint64 joinH;
        uint256 painted;
    }

    /// Random walk of the Core height (up, down, below genesis) with paints at random n.
    /// Checks: budgetOf == reference formula; ready == largest n paint accepts; identities;
    /// credited monotone; lastHeight - credited <= CAP; sum(n) <= Hmax - joinH.
    function testFuzz_B1_budgetDifferential(uint256 seed) public {
        vm.prank(alice);
        pit.join(1);
        Ref memory r = Ref({c: H0, l: H0, joinH: H0, painted: 0});
        uint64 h = H0;
        uint64 hmax = H0;
        for (uint256 step = 0; step < 24; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 op = seed % 5;
            if (op == 0) {
                h += uint64((seed >> 8) % 60);
            } else if (op == 1) {
                uint64 d = uint64((seed >> 8) % 50);
                h = h - d < H0 - 5 ? H0 - 5 : h - d; // may dip below genesis
            } else if (op == 2) {
                h += uint64((seed >> 8) % 400);
            }
            mock.setHeight(h);
            if (h > hmax) hmax = h;

            if (h < H0) {
                assertFalse(_coreOk(alice));
                assertEq(_ready(alice), 0);
                (uint16[] memory cs1, uint8[] memory ks1) = _one(3, 3);
                vm.prank(alice);
                vm.expectRevert(PixelPit.CoreUnavailable.selector);
                pit.paint(cs1, ks1);
                continue;
            }
            uint8 ready = _checkAgainstRef(r, h);

            // ready + 1 must fail with exact data (if ready < CAP; at CAP, 41 is TooManyCells)
            if (ready < CAP) {
                (uint16[] memory cs2, uint8[] memory ks2) = _n(uint256(ready) + 1, uint16(seed % 1024));
                vm.prank(alice);
                vm.expectRevert(
                    abi.encodeWithSelector(PixelPit.InsufficientBudget.selector, ready, uint256(ready) + 1)
                );
                pit.paint(cs2, ks2);
            }
            if (ready == 0) continue;
            uint256 n = 1 + ((seed >> 40) % ready);
            if ((seed >> 80) % 3 == 0) n = ready; // often spend all
            (uint16[] memory cs, uint8[] memory ks) = _n(n, uint16((seed >> 100) % 1024));
            vm.prank(alice);
            pit.paint(cs, ks);
            uint64 left = uint64(ready - n);
            uint64 newC = h - left;
            assertGe(newC, r.c, "credited never decreases");
            r.c = newC;
            r.l = h;
            r.painted += n;
            PixelPit.Player memory pl = pit.players(alice);
            assertEq(pl.credited, r.c);
            assertEq(pl.lastHeight, r.l);
            assertLe(pl.lastHeight - pl.credited, CAP);
            assertLe(r.painted, hmax - r.joinH, "INV6 vs Hmax");
            assertLe(r.painted, pl.credited - r.joinH, "painted <= credited - joinH");
        }
        assertEq(pit.totalStrokes(), r.painted);
    }

    function _checkAgainstRef(Ref memory r, uint64 h) internal view returns (uint8) {
        B memory got;
        (got.j, got.ok, got.h, got.ready, got.banked, got.fresh, got.arrived, got.forf) = pit.budgetOf(alice);
        assertTrue(got.j);
        assertTrue(got.ok);
        assertEq(got.h, h);
        B memory want;
        (want.ready, want.banked, want.fresh, want.arrived, want.forf) = _refBudget(r.c, r.l, h);
        assertEq(got.ready, want.ready, "ready");
        assertEq(got.banked, want.banked, "banked");
        assertEq(got.fresh, want.fresh, "fresh");
        assertEq(got.arrived, want.arrived, "arrived");
        assertEq(got.forf, want.forf, "forfeited");
        assertEq(uint256(got.ready), uint256(got.banked) + got.fresh, "ready = banked + fresh");
        return got.ready;
    }

    struct B {
        bool j;
        bool ok;
        uint64 h;
        uint8 ready;
        uint8 banked;
        uint8 fresh;
        uint64 arrived;
        uint64 forf;
    }

    /// 40 x paint(1) in one block = exactly 40; the 41st fails.
    function test_B2_manySmallPaintsSameBlock_noRounding() public {
        vm.prank(alice);
        pit.join(0);
        mock.bump(43);
        for (uint256 i = 0; i < 40; ++i) {
            (uint16[] memory cs, uint8[] memory ks) = _one(uint16(i), 1);
            vm.prank(alice);
            pit.paint(cs, ks);
        }
        (uint16[] memory c2, uint8[] memory k2) = _one(100, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PixelPit.InsufficientBudget.selector, uint8(0), uint256(1)));
        pit.paint(c2, k2);
    }

    /// Dip-and-recover: player that paints during a partial drop gets no more than without the drop.
    function test_B3_dipAndRecover_noInflation() public {
        vm.prank(alice);
        pit.join(0);
        mock.setHeight(H0 + 40);
        (uint16[] memory c1, uint8[] memory k1) = _one(0, 1);
        vm.prank(alice);
        pit.paint(c1, k1); // left 39, credited H0+1, last H0+40
        mock.setHeight(H0 + 20); // dip
        assertEq(_ready(alice), 19);
        (uint16[] memory c2, uint8[] memory k2) = _n(19, 10);
        vm.prank(alice);
        pit.paint(c2, k2);
        mock.setHeight(H0 + 40); // recover
        assertEq(_ready(alice), 20);
        (uint16[] memory c3, uint8[] memory k3) = _n(20, 40);
        vm.prank(alice);
        pit.paint(c3, k3);
        assertEq(pit.players(alice).strokes, 40, "= Hmax - joinH");
        assertEq(_ready(alice), 0);
    }

    // =====================================================================
    // C. Word cache
    // =====================================================================

    /// Differential fuzz of the word cache against a cell-by-cell reference. Cells are drawn from a small
    /// set of words so the sequence alternates words, revisits flushed words, and repeats cells.
    function testFuzz_C1_wordCacheDifferential(uint256 seed) public {
        vm.prank(alice);
        pit.join(2);
        vm.prank(bob);
        pit.join(1);
        uint32[1024] memory refRec;
        for (uint256 round = 0; round < 6; ++round) {
            mock.bump(40);
            address who = round % 2 == 0 ? alice : bob;
            uint32 id = round % 2 == 0 ? 1 : 2;
            uint32 crew = round % 2 == 0 ? 2 : 1;
            uint256 n = 1 + uint256(keccak256(abi.encode(seed, round, "n"))) % 40;
            uint16[] memory cs = new uint16[](n);
            uint8[] memory ks = new uint8[](n);
            for (uint256 i = 0; i < n; ++i) {
                uint256 rnd = uint256(keccak256(abi.encode(seed, round, i)));
                uint256 w = [uint256(0), 1, 2, 127][rnd % 4];
                cs[i] = uint16(w * 8 + ((rnd >> 8) % 8));
                ks[i] = uint8((rnd >> 16) % 16);
                refRec[cs[i]] = (id << 8) | (crew << 4) | ks[i];
            }
            vm.prank(who);
            pit.paint(cs, ks);
            uint256[128] memory raw = pit.rawCells();
            for (uint256 c = 0; c < 1024; ++c) {
                uint32 got = uint32(raw[c >> 3] >> ((c & 7) << 5));
                assertEq(got, refRec[c], "cell record mismatch");
                assertEq(got & 0x80, 0, "spare bit");
            }
        }
    }

    function test_C2_alternatingWords_lastWordFlushed() public {
        vm.prank(alice);
        pit.join(3);
        mock.bump(40);
        uint16[] memory cs = new uint16[](6);
        uint8[] memory ks = new uint8[](6);
        // A, B, A, B, A(dup), C
        cs[0] = 0; ks[0] = 1;
        cs[1] = 8; ks[1] = 2;
        cs[2] = 1; ks[2] = 3;
        cs[3] = 9; ks[3] = 4;
        cs[4] = 0; ks[4] = 5;
        cs[5] = 1023; ks[5] = 6;
        vm.prank(alice);
        pit.paint(cs, ks);
        (uint8 col,,,) = pit.cell(0);
        assertEq(col, 5);
        (col,,,) = pit.cell(1);
        assertEq(col, 3);
        (col,,,) = pit.cell(8);
        assertEq(col, 2);
        (col,,,) = pit.cell(9);
        assertEq(col, 4);
        (uint8 c2, uint8 crew, uint32 pid, bool g) = pit.cell(1023);
        assertEq(c2, 6);
        assertEq(crew, 3);
        assertEq(pid, 1);
        assertFalse(g);
        assertEq(_ready(alice), 34);
    }

    function test_C3_badColorAfterFlushedWords_noPartialState() public {
        vm.prank(alice);
        pit.join(0);
        mock.bump(40);
        uint256[128] memory before = pit.rawCells();
        PixelPit.Player memory pb = pit.players(alice);
        uint16[] memory cs = new uint16[](4);
        uint8[] memory ks = new uint8[](4);
        cs[0] = 0; ks[0] = 1;
        cs[1] = 8; ks[1] = 1; // word 0 flushed to storage here
        cs[2] = 16; ks[2] = 1; // word 1 flushed
        cs[3] = 24; ks[3] = 16; // BadColor
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PixelPit.BadColor.selector, uint8(16)));
        pit.paint(cs, ks);
        uint256[128] memory afterCells = pit.rawCells();
        for (uint256 i = 0; i < 128; ++i) assertEq(afterCells[i], before[i]);
        PixelPit.Player memory pa = pit.players(alice);
        assertEq(pa.credited, pb.credited);
        assertEq(pit.totalStrokes(), 0);
    }

    function test_C4_overpaintGenesis_clearsGenesisBit() public {
        uint16[] memory gc = new uint16[](4);
        uint8[] memory gk = new uint8[](4);
        gc[0] = 0; gk[0] = 13;
        gc[1] = 8; gk[1] = 0; // colour 0 genesis cell
        gc[2] = 1; gk[2] = 1;
        gc[3] = 0; gk[3] = 4; // duplicate, last wins
        vm.expectEmit(false, false, false, true);
        emit GenesisSeeded(4, H0);
        PixelPit p = new PixelPit(address(mock), gc, gk);
        (uint8 col,, uint32 pid, bool g) = p.cell(0);
        assertEq(col, 4);
        assertEq(pid, 0);
        assertTrue(g);
        (col,,, g) = p.cell(8);
        assertEq(col, 0);
        assertTrue(g);
        vm.prank(alice);
        p.join(1);
        mock.bump(1);
        (uint16[] memory cs, uint8[] memory ks) = _one(0, 7);
        vm.prank(alice);
        p.paint(cs, ks);
        (col,, pid, g) = p.cell(0);
        assertFalse(g);
        assertEq(pid, 1);
        uint16[4] memory held = p.crewScores();
        assertEq(held[1], 1);
    }

    // =====================================================================
    // D. id width / layout / events
    // =====================================================================

    function test_D1_maxPlayerId_24bit_and_limit() public {
        vm.store(address(pit), bytes32(uint256(129)), bytes32(uint256(0xFFFFFF)));
        vm.prank(alice);
        pit.join(3);
        assertEq(pit.players(alice).id, 0xFFFFFF);
        assertEq(pit.playerCount(), 0xFFFFFF);
        assertEq(pit.playerAt(0xFFFFFF), alice);
        mock.bump(2);
        uint16[] memory cs = new uint16[](2);
        uint8[] memory ks = new uint8[](2);
        cs[0] = 7; ks[0] = 15; // top slot of word 0 (shift 224)
        cs[1] = 6; ks[1] = 9;
        vm.expectEmit(true, true, true, true);
        emit Painted(alice, H0 + 2, 0xFFFFFF, cs, ks, 0);
        vm.prank(alice);
        pit.paint(cs, ks);
        (uint8 col, uint8 crew, uint32 pid, bool g) = pit.cell(7);
        assertEq(col, 15);
        assertEq(crew, 3);
        assertEq(pid, 0xFFFFFF);
        assertFalse(g);
        uint256 w0 = pit.rawCells()[0];
        assertEq(uint32(w0 >> 224), 0xFFFFFF3F);
        assertEq(uint32(w0 >> 192), 0xFFFFFF39);
        vm.prank(bob);
        vm.expectRevert(PixelPit.PlayerLimit.selector);
        pit.join(0);
    }

    function test_D2_storageSlots_viaVmLoad() public {
        vm.prank(alice);
        pit.join(2);
        mock.bump(10);
        (uint16[] memory cs, uint8[] memory ks) = _n(4, 0);
        vm.prank(alice);
        pit.paint(cs, ks);
        bytes32 slot = keccak256(abi.encode(alice, uint256(128)));
        uint256 v = uint256(vm.load(address(pit), slot));
        assertEq(uint64(v), H0 + 10 - 6, "credited @0");
        assertEq(uint64(v >> 64), H0 + 10, "lastHeight @8");
        assertEq(uint32(v >> 128), 4, "strokes @16");
        assertEq(uint32(v >> 160), 1, "id @20");
        assertEq(uint8(v >> 192), 2, "crew @24");
        assertEq(uint8(v >> 200), 1, "joined @25");
        assertEq(v >> 208, 0, "rest clean");
        assertEq(uint256(vm.load(address(pit), bytes32(uint256(129)))), 2, "_playerById.length");
        assertEq(
            address(uint160(uint256(vm.load(address(pit), bytes32(uint256(keccak256(abi.encode(uint256(129)))) + 1))))),
            alice
        );
        assertEq(uint256(vm.load(address(pit), bytes32(uint256(130)))), 4, "_totalStrokes");
        assertEq(uint256(vm.load(address(pit), bytes32(uint256(0)))), pit.rawCells()[0], "_cells @0");
    }

    function test_D3_budgetOf_unjoined_reportsCoreHeight() public {
        // Spec §6.3(d) compares budgetOf.coreHeight with the last BatchSettled height for the connected
        // wallet, which may not have joined yet. coreHeight_ therefore follows coreOk, not joined;
        // the budget numbers stay 0 until join.
        (bool j, bool ok, uint64 h, uint8 ready, uint8 banked, uint8 fresh, uint64 arrived, uint64 forf) =
            pit.budgetOf(bob);
        assertFalse(j);
        assertTrue(ok);
        assertEq(h, pit.coreHeight(), "unjoined + coreOk => real coreHeight_");
        assertEq(uint256(ready) + banked + fresh + arrived + forf, 0, "unjoined => budget numbers 0");

        // and still 0 when Core is unreadable, joined or not
        mock.setRevertNext(true);
        (j, ok, h, ready,,,,) = pit.budgetOf(bob);
        assertFalse(j);
        assertFalse(ok);
        assertEq(h, 0);
        assertEq(ready, 0);
        mock.setRevertNext(false);
    }

    function test_D4_ethForceAndCall_reverts() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool s,) = address(pit).call{value: 1}("");
        assertFalse(s);
        vm.prank(alice);
        (s,) = address(pit).call{value: 1}(abi.encodeCall(PixelPit.join, (0)));
        assertFalse(s, "join is non-payable");
    }

    function test_D5_constructor_validation_order() public {
        uint16[] memory gc = new uint16[](2);
        uint8[] memory gk = new uint8[](1);
        vm.expectRevert(PixelPit.LengthMismatch.selector);
        new PixelPit(address(mock), gc, gk);
        gk = new uint8[](2);
        gc[1] = 1024;
        vm.expectRevert(abi.encodeWithSelector(PixelPit.BadCell.selector, uint16(1024)));
        new PixelPit(address(mock), gc, gk);
        gc[1] = 1023;
        gk[0] = 16;
        vm.expectRevert(abi.encodeWithSelector(PixelPit.BadColor.selector, uint8(16)));
        new PixelPit(address(mock), gc, gk);
        gk[0] = 0;
        vm.expectRevert(PixelPit.CoreUnavailable.selector);
        new PixelPit(makeAddr("eoa"), gc, gk);
        PixelPit p = new PixelPit(address(mock), gc, gk);
        assertEq(p.playerAt(0), address(0));
        assertEq(p.playerCount(), 0);
        assertEq(p.DEPLOY_BLOCK(), block.number);
    }

    function test_D6_selfPaintGasWorstCase() public {
        vm.prank(alice);
        pit.join(0);
        mock.bump(40);
        uint16[] memory cs = new uint16[](40);
        uint8[] memory ks = new uint8[](40);
        for (uint256 i = 0; i < 40; ++i) {
            cs[i] = uint16(i * 8); // 40 distinct, never-written words
            ks[i] = 15;
        }
        vm.prank(alice);
        uint256 g = gasleft();
        pit.paint(cs, ks);
        console.log("paint(40) fresh words gas:", g - gasleft());
    }
}

/// Probe: does Foundry persist state written by an invariant_* function between checks?
/// If this PASSES, writes inside invariant functions are discarded, so PixelPit.invariant.t.sol's
/// INV2 "credited/lastHeight never decrease" (prevCredited/prevLast updated inside the invariant)
/// always compares against 0 and is vacuous. testFuzz_B1 above checks credited monotonicity directly.
contract ProbeTarget {
    uint256 public x;

    function poke() external {
        ++x;
    }
}

contract AuditInvariantPersistenceProbe is Test {
    ProbeTarget internal t;
    uint256 internal seen;

    function setUp() public {
        t = new ProbeTarget();
        targetContract(address(t));
    }

    function invariant_writesAreNotPersisted() public {
        seen++;
        assertEq(seen, 1, "invariant-function writes ARE persisted");
    }
}
