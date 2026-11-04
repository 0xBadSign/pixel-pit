// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Test double for SqueekCore. `state()` has the exact selector (0xc19d93fb) and ABI shape of the
///         real Core (8 static words, blockHeight at word index 3).
///
///         Failure modes (§5.11). Every mode is a STICKY boolean, not a one-shot: `state()` is a view
///         function and cannot clear its own flag, so tests set a mode, exercise, then clear it
///         (`setXxx(false)` or `clearModes()`). Modes are checked in the order revert > gasBomb >
///         returnBomb > malformed > eoa.
///         - revertNext:     state() reverts with a reason string.
///         - gasBombNext:    state() burns all forwarded gas (the Pit's 60k cap makes this cheap).
///         - returnBombNext: state() tries to RETURN 1 MB. Under the Pit's 60k cap the memory expansion
///                           alone exceeds the gas, so the call fails with out-of-gas before any data is
///                           returned; with a large gas budget it returns 1 MB and the Pit's
///                           `returndatasize() == 256` check rejects it. Either way coreOk=false.
///         - malformedNext:  state() returns 255 bytes (ABI shape broken).
///         - eoaMode:        state() returns 0 bytes with success, which is exactly what a STATICCALL to a
///                           code-less address (EOA / selfdestructed Core) looks like to the Pit. A real
///                           code-less Core is additionally tested with `vm.etch(address(mock), "")` (T14).
///         `bump(n)` is public so the same mock can be deployed to Sepolia for daytime dev-Pit tests.
///         Derived fields are computed unchecked so heights up to uint64 max can be modelled (C-9).
contract MockCore {
    struct State {
        uint64 settledThroughRound;
        uint64 cumulativeWork;
        uint96 cumulativeBlockUnits;
        uint64 blockHeight;
        uint96 blockProgress;
        uint32 workPerThousandBlocks;
        uint256 authorizationNonce;
        bool paused;
    }

    uint64 public height;
    uint64 public settledThroughRound;
    bool public paused;

    /// @dev failure modes (sticky until cleared)
    bool public revertNext;      // state() reverts
    bool public malformedNext;   // state() returns 255 bytes
    bool public gasBombNext;     // state() burns all forwarded gas
    bool public returnBombNext;  // state() returns 1 MB (OOG under the 60k cap)
    bool public eoaMode;         // state() returns 0 bytes, like a code-less address

    event HeightSet(uint64 oldHeight, uint64 newHeight);

    constructor(uint64 initialHeight) {
        height = initialHeight;
    }

    // ---------- controls ----------

    /// @notice Sets the height to any value, decreasing included.
    function setHeight(uint64 h) external {
        emit HeightSet(height, h);
        height = h;
    }

    /// @notice Adds `n` blocks; public on purpose (dev Pit on Sepolia).
    function bump(uint64 n) public {
        uint64 old = height;
        height = old + n;
        settledThroughRound += 1;
        emit HeightSet(old, height);
    }

    /// @notice Alias of bump(): jump(+1 / +43 / +318).
    function jump(uint64 n) external {
        bump(n);
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setRevertNext(bool v) external {
        revertNext = v;
    }

    function setMalformedNext(bool v) external {
        malformedNext = v;
    }

    function setGasBombNext(bool v) external {
        gasBombNext = v;
    }

    function setReturnBombNext(bool v) external {
        returnBombNext = v;
    }

    function setEoaMode(bool v) external {
        eoaMode = v;
    }

    /// @notice Clears every failure flag.
    function clearModes() external {
        revertNext = false;
        malformedNext = false;
        gasBombNext = false;
        returnBombNext = false;
        eoaMode = false;
    }

    // ---------- Core-shaped read ----------

    /// @notice Mirrors SqueekCore.state(): selector 0xc19d93fb, returns 8 words, blockHeight = word 3.
    function state() external view returns (State memory s) {
        if (revertNext) revert("MockCore: revertNext");
        if (gasBombNext) {
            assembly {
                for {} 1 {} { pop(keccak256(0, 0x20)) }
            }
        }
        if (returnBombNext) {
            assembly {
                return(0, 0x100000) // 1 MB
            }
        }
        if (malformedNext) {
            assembly {
                let p := mload(0x40)
                mstore(p, 0xdead)
                return(p, 255)
            }
        }
        if (eoaMode) {
            assembly {
                return(0, 0) // success, returndatasize 0: what a call to a code-less address returns
            }
        }
        uint64 h = height;
        s.settledThroughRound = settledThroughRound;
        unchecked {
            // derived display fields only; wrap on purpose so height near uint64 max still returns (C-9)
            s.cumulativeWork = h * 1000;
            s.cumulativeBlockUnits = uint96(h) * 1e9;
        }
        s.blockHeight = h;
        s.blockProgress = 0;
        s.workPerThousandBlocks = 1000;
        s.authorizationNonce = settledThroughRound;
        s.paused = paused;
    }
}
