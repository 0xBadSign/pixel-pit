// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {PixelPit} from "../src/PixelPit.sol";
import {MockCore} from "./mocks/MockCore.sol";

/// @notice Handler: joins, paints and moves the mock height. Tracks ghost state for INV1-INV6.
///         Every paint is checked against budgetOf() on the spot (INV5): n <= ready must succeed,
///         n > ready must revert InsufficientBudget. Mismatches are counted in `violations`.
///
///         Monotonicity (INV2 "never decreases") is tracked HERE, after every join/paint/probe, because
///         Foundry discards storage written inside invariant_* functions (see
///         Audit.t.sol:AuditInvariantPersistenceProbe). Handler storage persists across one run, so a
///         decrease between two consecutive calls lands in `monotoneViolations`.
///
///         In the Backwards suite `drop()`/`freeze()` may also push the height BELOW GENESIS_HEIGHT; the
///         handler then expects budgetOf.coreOk == false and join/paint to revert CoreUnavailable (T15b).
contract PitHandler is Test {
    PixelPit public pit;
    MockCore public mock;
    bool public allowDecrease;
    uint64 public genesis;

    address[] public actors;
    mapping(address => bool) public isJoined;
    mapping(address => uint64) public joinH;
    mapping(address => uint256) public acceptedSum; // sum of accepted paint n per player
    mapping(address => uint64) public prevCredited; // last observed Player.credited
    mapping(address => uint64) public prevLast; // last observed Player.lastHeight
    uint256 public paintedEventSum; // sum of Painted.cells.length over all emitted events
    uint64 public hMax;
    uint256 public violations; // budgetOf/paint/join disagreements (INV5 + frozen path)
    uint256 public monotoneViolations; // credited (or lastHeight, monotone suite) went down
    uint256 public joins;
    uint256 public paints;
    uint256 public paintsAccepted;
    uint256 public frozenCalls; // join/paint attempts made while H < GENESIS_HEIGHT

    bytes32 internal constant PAINTED_SIG = keccak256("Painted(address,uint64,uint32,uint16[],uint8[],uint8)");

    constructor(PixelPit _pit, MockCore _mock, bool _allowDecrease) {
        pit = _pit;
        mock = _mock;
        allowDecrease = _allowDecrease;
        genesis = _pit.GENESIS_HEIGHT();
        hMax = _mock.height();
        for (uint256 i = 0; i < 8; ++i) {
            actors.push(address(uint160(0xA11CE000 + i)));
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _frozen() internal view returns (bool) {
        return mock.height() < genesis;
    }

    /// @dev budgetOf view + consistency: the mock never fails in this handler, so coreOk must be exactly
    ///      "height >= GENESIS_HEIGHT" (T15b as a running check), and coreHeight must be the mock height.
    function _ready(address a) internal returns (uint8 ready, bool coreOk) {
        uint64 h;
        (, coreOk, h, ready,,,,) = pit.budgetOf(a);
        if (coreOk == _frozen()) violations++;
        if (coreOk && h != mock.height()) violations++;
        if (!coreOk && (h != 0 || ready != 0)) violations++;
    }

    function _stroke(uint256 n, uint256 seed) internal pure returns (uint16[] memory c, uint8[] memory k) {
        c = new uint16[](n);
        k = new uint8[](n);
        for (uint256 i = 0; i < n; ++i) {
            bytes32 r = keccak256(abi.encode(seed, i));
            c[i] = uint16(uint256(r) % 1024);
            k[i] = uint8(uint256(r >> 32) % 16);
        }
    }

    function _collectPainted() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(pit) && logs[i].topics[0] == PAINTED_SIG) {
                (uint16[] memory c,,) = abi.decode(logs[i].data, (uint16[], uint8[], uint8));
                paintedEventSum += c.length;
            }
        }
    }

    /// @dev INV2 ghost: compare the player heights with the previous observation.
    function _track(address a) internal {
        PixelPit.Player memory p = pit.players(a);
        if (!p.joined) return;
        if (p.credited < prevCredited[a]) monotoneViolations++;
        if (!allowDecrease && p.lastHeight < prevLast[a]) monotoneViolations++;
        prevCredited[a] = p.credited;
        prevLast[a] = p.lastHeight;
    }

    /// @dev try paint(n); returns true when accepted. Checks consistency with budgetOf (INV5) and, when
    ///      the height is below genesis, that paint reverts CoreUnavailable.
    function _tryPaint(address a, uint256 n, uint256 seed) internal returns (bool accepted) {
        (uint8 ready, bool coreOk) = _ready(a);
        (uint16[] memory c, uint8[] memory k) = _stroke(n, seed);
        if (!coreOk) frozenCalls++;
        vm.recordLogs();
        vm.prank(a);
        try pit.paint(c, k) {
            accepted = true;
            if (!coreOk) violations++; // painted while the season is frozen
            if (n > ready) violations++; // accepted more than budgetOf promised
            acceptedSum[a] += n;
            paintsAccepted++;
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            if (!coreOk) {
                if (sel != PixelPit.CoreUnavailable.selector) violations++;
            } else {
                if (n <= ready) violations++; // refused what budgetOf promised
                if (sel != PixelPit.InsufficientBudget.selector) violations++;
                else {
                    (uint8 have, uint256 need) = abi.decode(_slice(err), (uint8, uint256));
                    if (have != ready || need != n) violations++;
                }
            }
        }
        _collectPainted();
        _track(a);
    }

    function _slice(bytes memory err) internal pure returns (bytes memory out) {
        out = new bytes(err.length - 4);
        for (uint256 i = 4; i < err.length; ++i) out[i - 4] = err[i];
    }

    // ---------------- actions ----------------

    function join(uint256 seed, uint8 crew) external {
        address a = _actor(seed);
        if (isJoined[a]) return;
        bool frozen = _frozen();
        if (frozen) frozenCalls++;
        vm.prank(a);
        try pit.join(crew % 4) {
            if (frozen) violations++; // joined while the season is frozen
            isJoined[a] = true;
            joinH[a] = mock.height();
            joins++;
            _track(a);
        } catch (bytes memory err) {
            // the mock never fails here: the only legal revert is CoreUnavailable below genesis
            if (!frozen || bytes4(err) != PixelPit.CoreUnavailable.selector) violations++;
        }
    }

    function paint(uint256 seed, uint8 nRaw) external {
        address a = _actor(seed);
        if (!isJoined[a]) return;
        uint256 n = bound(nRaw, 1, 40);
        paints++;
        _tryPaint(a, n, seed);
    }

    /// @dev INV5 probe: paint(ready+1) must fail, paint(ready) must pass; frozen => paint(1) reverts.
    function probeBudget(uint256 seed) external {
        address a = _actor(seed);
        if (!isJoined[a]) return;
        (uint8 ready, bool coreOk) = _ready(a);
        if (!coreOk) {
            if (_tryPaint(a, 1, seed)) violations++;
            return;
        }
        if (ready < 40) {
            if (_tryPaint(a, uint256(ready) + 1, seed)) violations++;
        }
        if (ready > 0) {
            if (!_tryPaint(a, ready, seed ^ 1)) violations++;
        }
    }

    function bump(uint64 d) external {
        d = uint64(bound(d, 0, 400));
        mock.bump(d);
        if (mock.height() > hMax) hMax = mock.height();
    }

    /// @dev Backwards suite only: move the height down by up to 60, allowed to cross GENESIS_HEIGHT.
    function drop(uint64 d) external {
        if (!allowDecrease) return;
        d = uint64(bound(d, 0, 60));
        uint64 h = mock.height();
        mock.setHeight(h > d ? h - d : 0);
    }

    /// @dev Backwards suite only: park the height just below GENESIS_HEIGHT (frozen season, T15b).
    function freeze(uint8 k) external {
        if (!allowDecrease) return;
        mock.setHeight(genesis - 1 - (k % 8));
    }
}

abstract contract PitInvariantBase is Test {
    MockCore internal mock;
    PixelPit internal pit;
    PitHandler internal handler;

    function _allowDecrease() internal pure virtual returns (bool);

    function setUp() public {
        mock = new MockCore(8430);
        uint16[] memory gc = new uint16[](2);
        uint8[] memory gk = new uint8[](2);
        gc[0] = 0;
        gc[1] = 1023;
        gk[0] = 13;
        gk[1] = 4;
        pit = new PixelPit(address(mock), gc, gk);
        handler = new PitHandler(pit, mock, _allowDecrease());

        bytes4[] memory sels = new bytes4[](_allowDecrease() ? 6 : 4);
        sels[0] = PitHandler.join.selector;
        sels[1] = PitHandler.paint.selector;
        sels[2] = PitHandler.probeBudget.selector;
        sels[3] = PitHandler.bump.selector;
        if (_allowDecrease()) {
            sels[4] = PitHandler.drop.selector;
            sels[5] = PitHandler.freeze.selector;
        }
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
        targetContract(address(handler));
    }

    /// INV1: lastHeight - credited <= CAP for every player
    function invariant_INV1_bankedWithinCap() public view {
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            address a = handler.actors(i);
            PixelPit.Player memory p = pit.players(a);
            if (!p.joined) continue;
            assertGe(p.lastHeight, p.credited, "credited > lastHeight");
            assertLe(p.lastHeight - p.credited, 40, "banked > CAP");
        }
    }

    /// INV2: credited <= lastHeight <= Hmax; credited never decreases; lastHeight never decreases
    ///       (the latter only when the handler never moves the height backwards: §5.5 step 6 sets
    ///       lastHeight = h on every paint, so under a partial drop it legitimately goes down).
    ///       The "never decreases" half is observed by the handler after every call (PitHandler._track);
    ///       state written inside this function would not survive between calls.
    function invariant_INV2_monotoneHeights() public view {
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            address a = handler.actors(i);
            PixelPit.Player memory p = pit.players(a);
            if (!p.joined) continue;
            assertLe(p.credited, p.lastHeight, "credited <= lastHeight");
            assertLe(p.lastHeight, handler.hMax(), "lastHeight <= Hmax");
            assertEq(p.credited, handler.prevCredited(a), "handler ghost out of sync (credited)");
            assertEq(p.lastHeight, handler.prevLast(a), "handler ghost out of sync (lastHeight)");
        }
        assertEq(handler.monotoneViolations(), 0, "credited/lastHeight decreased between calls");
    }

    /// INV3: sum(Painted.cells.length) == totalStrokes == sum(players.strokes)
    function invariant_INV3_strokeAccounting() public view {
        uint256 sum;
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            sum += pit.players(handler.actors(i)).strokes;
        }
        assertEq(pit.totalStrokes(), sum, "totalStrokes != sum(strokes)");
        assertEq(handler.paintedEventSum(), sum, "Painted events != sum(strokes)");
    }

    /// INV5: budgetOf.ready == largest n paint() accepts (checked on every paint and probe);
    ///       below GENESIS_HEIGHT: coreOk == false and join/paint revert CoreUnavailable.
    function invariant_INV5_readyMatchesPaint() public view {
        assertEq(handler.violations(), 0, "budgetOf/paint disagreement");
    }

    /// INV6: no inflation: accepted paint total per player <= H_final - joinH
    ///       (<= Hmax - joinH when the handler moves the height backwards)
    function invariant_INV6_noInflation() public view {
        uint64 hRef = _allowDecrease() ? handler.hMax() : mock.height();
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            address a = handler.actors(i);
            if (!handler.isJoined(a)) continue;
            assertLe(handler.acceptedSum(a), uint256(hRef - handler.joinH(a)), "inflation");
            PixelPit.Player memory p = pit.players(a);
            assertLe(handler.acceptedSum(a), uint256(p.credited - handler.joinH(a)), "accepted > credited delta");
        }
    }

    /// Canvas accounting after any sequence (T20 as an invariant).
    function invariant_canvasAccounting() public view {
        uint16[4] memory held = pit.crewScores();
        uint256[128] memory raw = pit.rawCells();
        uint256 genesis;
        uint256 empty;
        for (uint256 i = 0; i < 1024; ++i) {
            uint256 rec = (raw[i >> 3] >> ((i & 7) << 5)) & 0xFFFFFFFF;
            assertEq((rec >> 7) & 1, 0, "spare bit");
            if ((rec >> 6) & 1 == 1) genesis++;
            else if (rec >> 8 == 0) empty++;
        }
        assertEq(uint256(held[0]) + held[1] + held[2] + held[3] + genesis + empty, 1024, "accounting");
    }
}

/// Heights only go up (live Core behaviour): INV1, INV2 strict, INV3, INV5, INV6 with H_final.
contract PixelPitInvariantsMonotone is PitInvariantBase {
    function _allowDecrease() internal pure override returns (bool) {
        return false;
    }
}

/// Handler also moves the height backwards, below GENESIS_HEIGHT included:
/// INV2 credited-monotone, INV5 + frozen path (CoreUnavailable), INV6 vs Hmax.
contract PixelPitInvariantsBackwards is PitInvariantBase {
    function _allowDecrease() internal pure override returns (bool) {
        return true;
    }
}
