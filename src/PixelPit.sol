// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Pixel Pit — Season 1
/// @notice Unofficial fan project, Sepolia testnet, no value.
///         A 32x32 shared canvas whose paint budget is metered by SqueekCore's settled block height.
///         Only external dependency: a gas-capped STATICCALL to SqueekCore.state() (selector 0xc19d93fb).
///         No owner, no admin, no pause, no upgrade, no setters, no receive/fallback.
contract PixelPit {
    // ---------- constants (bytecode, not storage) ----------
    uint16 public constant WIDTH        = 32;
    uint16 public constant HEIGHT       = 32;
    uint16 public constant CELLS        = 1024;      // cell = y * 32 + x
    uint8  public constant PALETTE_SIZE = 16;        // 4 bits, index 0 = pit black
    uint8  public constant CREWS        = 4;         // 0 Wheel, 1 Burrow, 2 Seed, 3 Moon
    uint8  public constant CAP          = 40;        // = Core targetBlocksPerActiveRound
    uint32 public constant MAX_PLAYERS  = 0xFFFFFF;  // 24-bit painterId in the cell record
    uint256 private constant CORE_GAS   = 60_000;    // Core.state() costs ~7.4k; cap stops gas bombs
    bytes4 private constant CORE_STATE  = 0xc19d93fb;

    /// @dev 16 x 3 bytes RGB; index 0 = pit black. Same table as the frontend (§5.2).
    bytes private constant PALETTE =
        hex"0b0d12" hex"ffffff" hex"c9ced6" hex"5c6370" hex"e63946" hex"f4a261" hex"ffd166" hex"8ac926"
        hex"2a9d8f" hex"4cc9f0" hex"3a86ff" hex"7b2cbf" hex"ff70a6" hex"a0522d" hex"f1dcc1" hex"ffbf69";

    // ---------- immutables ----------
    address public immutable CORE;           // 0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44
    uint64  public immutable GENESIS_HEIGHT; // CORE.state().blockHeight at deploy (constructor reverts if Core unreadable)
    uint64  public immutable DEPLOY_BLOCK;   // Ethereum block.number at deploy = frontend log cursor

    // ---------- types ----------
    struct Player {              // packs into ONE slot (8+8+4+4+1+1 = 26 bytes)
        uint64 credited;         // height up to which blocks are consumed; ready = min(CAP, H - credited)
        uint64 lastHeight;       // H at join / last paint; lastHeight - credited <= CAP (invariant)
        uint32 strokes;          // lifetime cells painted
        uint32 id;               // 1..MAX_PLAYERS; 0 = genesis / unpainted
        uint8  crew;             // 0..3
        bool   joined;
    }

    // ---------- storage (layout asserted in CI, §5.2) ----------
    uint256[128] private _cells;                      // slots 0..127: 8 cells / word, 32 bits per cell
    mapping(address => Player) private _players;      // slot 128
    address[] private _playerById;                    // slot 129: index 0 = address(0) placeholder
    uint64 private _totalStrokes;                     // slot 130

    // ---------- events ----------
    event GenesisSeeded(uint16 cellCount, uint64 coreHeight);
    event Joined(address indexed player, uint32 indexed playerId, uint8 crew, uint64 coreHeight);
    event Painted(
        address indexed player,
        uint64  indexed coreHeight,
        uint32  indexed playerId,
        uint16[] cells,
        uint8[]  colors,
        uint8    budgetLeft
    );

    // ---------- errors ----------
    error AlreadyJoined();
    error NotJoined();
    error BadCrew(uint8 crew);
    error PlayerLimit();
    error EmptyStroke();
    error TooManyCells(uint256 n);
    error LengthMismatch();
    error BadCell(uint16 cell);
    error BadColor(uint8 color);
    error InsufficientBudget(uint8 have, uint256 need);
    error CoreUnavailable();

    /// @notice Deploys Season 1 bound to `core` and preseeds the genesis picture.
    /// @dev Pushes address(0) as playerId 0, validates every genesis cell (< 1024) and colour (< 16),
    ///      requires equal lengths, reads GENESIS_HEIGHT through the same gas-capped staticcall
    ///      (reverts CoreUnavailable). Genesis cells are written with painterId 0, genesis bit 1, crew 0.
    ///      GenesisSeeded.cellCount is the number of ENTRIES in `genesisCells` (a repeated cell is counted
    ///      again; the last colour wins), not the number of distinct cells.
    /// @param core          SqueekCore proxy address (immutable forever).
    /// @param genesisCells  Cell indices (y * 32 + x) to preseed.
    /// @param genesisColors Palette index per genesis cell.
    constructor(address core, uint16[] memory genesisCells, uint8[] memory genesisColors) {
        CORE = core;
        DEPLOY_BLOCK = uint64(block.number);

        _playerById.push(address(0));

        uint256 n = genesisCells.length;
        if (n != genesisColors.length) revert LengthMismatch();

        (bool ok, uint256 w) = _readCore();
        if (!ok) revert CoreUnavailable();
        GENESIS_HEIGHT = uint64(w);

        uint256 curW = type(uint256).max;
        uint256 word;
        for (uint256 i = 0; i < n; ++i) {
            uint16 c = genesisCells[i];
            if (c >= CELLS) revert BadCell(c);
            uint8 col = genesisColors[i];
            if (col >= PALETTE_SIZE) revert BadColor(col);
            uint256 wi = c >> 3;
            if (wi != curW) {
                if (curW != type(uint256).max) _cells[curW] = word;
                word = _cells[wi];
                curW = wi;
            }
            uint256 sh = (c & 7) << 5;
            // painterId 0, spare 0, genesis 1, crew 0, colour col
            word = (word & ~(uint256(0xFFFFFFFF) << sh)) | (uint256(0x40 | col) << sh);
        }
        if (curW != type(uint256).max) _cells[curW] = word;

        emit GenesisSeeded(uint16(n), uint64(w));
    }

    // =====================================================================
    //                                writes
    // =====================================================================

    /// @notice Joins the season in `crew` (0 Wheel, 1 Burrow, 2 Seed, 3 Moon). Starts with an empty brush.
    /// @dev credited = lastHeight = current Core height, so budget is 0 until the next settlement.
    /// @param crew Crew index, 0..3, fixed forever for this wallet.
    function join(uint8 crew) external {
        if (_players[msg.sender].joined) revert AlreadyJoined();
        if (crew >= CREWS) revert BadCrew(crew);
        (bool ok, uint64 h) = _coreHeight();
        if (!ok) revert CoreUnavailable();
        uint256 id = _playerById.length; // first real player gets 1 (index 0 is the placeholder)
        if (id > MAX_PLAYERS) revert PlayerLimit();
        _playerById.push(msg.sender);
        _players[msg.sender] =
            Player({credited: h, lastHeight: h, strokes: 0, id: uint32(id), crew: crew, joined: true});
        emit Joined(msg.sender, uint32(id), crew, h);
    }

    /// @notice Paints `cells[i]` with `colors[i]`, burning one budget pixel per entry (duplicates burn again, last colour wins).
    /// @dev All bounds checks finish before the first SSTORE. Consecutive cells in the same word share one SLOAD/SSTORE.
    /// @param cells  Cell indices (y * 32 + x), 1..CAP entries.
    /// @param colors Palette index per cell, same length as `cells`.
    function paint(uint16[] calldata cells, uint8[] calldata colors) external {
        Player memory p = _players[msg.sender];
        if (!p.joined) revert NotJoined();

        uint256 n = cells.length;
        if (n == 0) revert EmptyStroke();
        if (n > CAP) revert TooManyCells(n);
        if (n != colors.length) revert LengthMismatch();

        (bool ok, uint64 h) = _coreHeight();
        if (!ok) revert CoreUnavailable();

        (uint8 have,,,,) = _budget(p, h); // SAME function as budgetOf
        if (n > have) revert InsufficientBudget(have, n);

        // genesis bit = 0, spare bit = 0
        _writeCells(cells, colors, (p.id << 8) | (uint32(p.crew) << 4));

        uint8 left = have - uint8(n);
        p.credited = h - left;
        p.lastHeight = h;
        p.strokes += uint32(n);
        _players[msg.sender] = p;
        _totalStrokes += uint64(n);

        emit Painted(msg.sender, h, p.id, cells, colors, left);
    }

    // =====================================================================
    //                                reads
    // =====================================================================

    /// @notice Brush state of `p`. Never reverts.
    /// @dev coreOk=false => every number is 0 and MUST be rendered as UNKNOWN, not as 0.
    ///      Uses the same _budget() as paint(): ready == the largest n paint() accepts at this block.
    ///      coreHeight_ is reported whenever Core is readable, joined or not, so the frontend's §6.3 (d)
    ///      check (budgetOf.coreHeight vs the last BatchSettled height) works for a connected wallet that
    ///      has not joined yet; the budget numbers stay 0 until join.
    ///      "Never reverts" assumes the caller supplies enough gas (>= ~120k). With much less, EIP-150
    ///      leaves 1/64 of the remainder after the 60k Core call, which may not cover the rest of the
    ///      function; irrelevant for eth_call, which runs with a large gas budget.
    /// @param p Player address.
    /// @return joined     Whether `p` has joined.
    /// @return coreOk     Whether Core was readable and its height >= GENESIS_HEIGHT.
    /// @return coreHeight_ Core height (0 only when !coreOk; reported for unjoined wallets too).
    /// @return ready      Largest n paint() accepts now (<= CAP).
    /// @return banked     Part of `ready` left over from the last paint.
    /// @return fresh      Part of `ready` that settled since the last paint.
    /// @return arrived    Blocks settled since the last paint (display: "+57 arrived").
    /// @return forfeited  Blocks above CAP that burned.
    function budgetOf(address p)
        external
        view
        returns (
            bool joined,
            bool coreOk,
            uint64 coreHeight_,
            uint8 ready,
            uint8 banked,
            uint8 fresh,
            uint64 arrived,
            uint64 forfeited
        )
    {
        Player memory pl = _players[p];
        joined = pl.joined;
        (bool ok, uint64 h) = _coreHeight();
        coreOk = ok;
        if (!ok) return (joined, false, 0, 0, 0, 0, 0, 0);
        coreHeight_ = h; // readable Core => real height, even before join (§6.3 (d))
        if (!joined) return (false, true, h, 0, 0, 0, 0, 0);
        (ready, banked, fresh, arrived, forfeited) = _budget(pl, h);
    }

    /// @notice Current Core height as seen by the Pit.
    /// @dev Reverts CoreUnavailable() when Core is unreadable or below GENESIS_HEIGHT.
    function coreHeight() external view returns (uint64) {
        (bool ok, uint64 h) = _coreHeight();
        if (!ok) revert CoreUnavailable();
        return h;
    }

    /// @notice Full player record for `p` (zeroed struct when not joined).
    function players(address p) external view returns (Player memory) {
        return _players[p];
    }

    /// @notice Number of joined players; ids run 1..count.
    function playerCount() external view returns (uint32) {
        return uint32(_playerById.length - 1);
    }

    /// @notice Address for `id`; id 0 => address(0) (genesis placeholder). Reverts on out-of-range id.
    function playerAt(uint32 id) external view returns (address) {
        return _playerById[id];
    }

    /// @notice Lifetime number of cells painted by all players (genesis excluded).
    function totalStrokes() external view returns (uint64) {
        return _totalStrokes;
    }

    /// @notice Decoded record of one cell.
    /// @dev Reverts BadCell when index >= 1024.
    /// @return color     Palette index 0..15.
    /// @return crew      Crew 0..3 of the painter (0 for genesis / unpainted).
    /// @return painterId Player id (0 = genesis or unpainted).
    /// @return genesis   True when preseeded at deploy and not yet overpainted.
    function cell(uint16 index) external view returns (uint8 color, uint8 crew, uint32 painterId, bool genesis) {
        if (index >= CELLS) revert BadCell(index);
        uint256 rec = (_cells[index >> 3] >> ((index & 7) << 5)) & 0xFFFFFFFF;
        color = uint8(rec & 0xF);
        crew = uint8((rec >> 4) & 3);
        genesis = ((rec >> 6) & 1) == 1;
        painterId = uint32(rec >> 8);
    }

    /// @notice The whole canvas in one eth_call (128 words, 4 KB). Same bit map as cell().
    function rawCells() external view returns (uint256[128] memory) {
        return _cells;
    }

    /// @notice Cells currently held per crew; genesis and unpainted cells are excluded.
    /// @dev Scans 128 words (~300k gas, view only).
    function crewScores() external view returns (uint16[4] memory held) {
        for (uint256 w = 0; w < 128; ++w) {
            uint256 word = _cells[w];
            if (word == 0) continue;
            for (uint256 k = 0; k < 8; ++k) {
                uint256 rec = (word >> (k << 5)) & 0xFFFFFFFF;
                if ((rec >> 8) != 0 && ((rec >> 6) & 1) == 0) {
                    unchecked {
                        ++held[(rec >> 4) & 3];
                    }
                }
            }
        }
    }

    /// @notice Season number of this deployment.
    function seasonId() external pure returns (uint8) {
        return 1;
    }

    // =====================================================================
    //                               internals
    // =====================================================================

    /// @dev §5.5 step 5: bounds-check and write every cell, caching one storage word at a time.
    ///      A BadCell/BadColor revert inside the loop reverts the whole tx, so storage is never left
    ///      half-written. Consecutive cells in the same word share one SLOAD/SSTORE.
    function _writeCells(uint16[] calldata cells, uint8[] calldata colors, uint32 base) private {
        uint256 n = cells.length;
        uint256 curW = type(uint256).max;
        uint256 word;
        for (uint256 i = 0; i < n; ++i) {
            uint16 c = cells[i];
            if (c >= CELLS) revert BadCell(c);
            uint8 col = colors[i];
            if (col >= PALETTE_SIZE) revert BadColor(col);
            uint256 w = c >> 3;
            if (w != curW) {
                if (curW != type(uint256).max) _cells[curW] = word;
                word = _cells[w];
                curW = w;
            }
            uint256 sh = (c & 7) << 5;
            word = (word & ~(uint256(0xFFFFFFFF) << sh)) | (uint256(base | col) << sh);
        }
        _cells[curW] = word; // flush
    }

    /// @dev §3.3 formula. paint() and budgetOf() use ONLY this.
    function _budget(Player memory p, uint64 H)
        internal
        pure
        returns (uint8 ready, uint8 banked, uint8 fresh, uint64 arrived, uint64 forfeited)
    {
        uint64 raw = H > p.credited ? H - p.credited : 0;
        uint64 readyW = raw < CAP ? raw : CAP;
        uint64 bankedRaw = p.lastHeight > p.credited ? p.lastHeight - p.credited : 0;
        uint64 bankedW = bankedRaw < readyW ? bankedRaw : readyW;
        ready = uint8(readyW);
        banked = uint8(bankedW);
        fresh = uint8(readyW - bankedW);
        arrived = H > p.lastHeight ? H - p.lastHeight : 0;
        forfeited = raw - readyW;
    }

    /// @dev Raw read: no dynamic returndata copy, so a Core that burns gas or returns megabytes
    ///      cannot make budgetOf/join/paint run out of gas; they take the CoreUnavailable path instead.
    function _readCore() private view returns (bool ok, uint256 w) {
        address core = CORE;
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0xc19d93fb00000000000000000000000000000000000000000000000000000000)
            ok := staticcall(60000, core, ptr, 4, ptr, 0x100) // CORE_GAS; Core.state() costs ~7.4k
            if iszero(eq(returndatasize(), 0x100)) { ok := 0 } // EOA, selfdestruct, ABI change, return bomb
            w := mload(add(ptr, 0x60)) // word index 3 = blockHeight
            mstore(0x40, add(ptr, 0x100))
        }
        if (ok && w > type(uint64).max) ok = false;
    }

    /// @dev Height gate: Core unreadable or below GENESIS_HEIGHT => (false, 0) (reset / re-init freeze).
    function _coreHeight() internal view returns (bool ok, uint64 h) {
        uint256 w;
        (ok, w) = _readCore();
        if (!ok) return (false, 0);
        if (w < GENESIS_HEIGHT) return (false, 0); // Core reset / re-init behind the proxy => freeze cleanly
        return (true, uint64(w));
    }
}
