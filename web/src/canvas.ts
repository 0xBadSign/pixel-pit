// <canvas> renderer for the 32x32 pit (SPEC §6.4 PLAY): image-rendering pixelated, 1x/2x/4x zoom + pan,
// hover cell lookup, crew region tint overlay, genesis dotted frame (default ON), pending hatch,
// fresh thin border. Pure view: it draws whatever frame it is given and reports hover/click cells.
import { WIDTH, HEIGHT, CELLS, PALETTE, CREW_COLORS } from './config';
import { decodeCell } from './frame';

export type Zoom = 1 | 2 | 4;

export type CanvasOptions = {
  /** base cell size in CSS px at zoom 1 (default: fit container width / 32, min 8) */
  baseCellPx?: number;
  showGenesisFrame?: boolean; // default true
  showCrewTint?: boolean; // default false
};

export type HoverInfo = { cell: number; x: number; y: number; clientX: number; clientY: number };

export class PitCanvas {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private frame: Uint32Array = new Uint32Array(CELLS);
  private pending = new Map<number, number>(); // cell -> colour (not sent / sent-not-mined)
  private fresh = new Set<number>(); // cells painted in blocks > safe
  private zoom: Zoom = 1;
  private panX = 0;
  private panY = 0;
  private baseCellPx: number;
  private cellPx: number;
  showGenesisFrame: boolean;
  showCrewTint: boolean;
  private hoverCell: number | null = null;
  private onHover: ((h: HoverInfo | null) => void) | null = null;
  private onCell: ((cell: number, ev: PointerEvent) => void) | null = null;
  private onDrag: ((cell: number, ev: PointerEvent) => void) | null = null;
  private dragging = false;
  private panning: { startX: number; startY: number; panX: number; panY: number } | null = null;
  private raf: number | null = null;
  private ro: ResizeObserver | null = null;
  private dpr = 1;

  constructor(
    readonly container: HTMLElement,
    opts: CanvasOptions = {},
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pit-canvas';
    this.canvas.style.imageRendering = 'pixelated';
    this.canvas.style.touchAction = 'none';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Pixel Pit canvas, 32 by 32 cells');
    container.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    this.showGenesisFrame = opts.showGenesisFrame ?? true;
    this.showCrewTint = opts.showCrewTint ?? false;
    this.baseCellPx = opts.baseCellPx ?? this.fitCellPx();
    this.cellPx = this.baseCellPx;
    this.bind();
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => {
        if (opts.baseCellPx === undefined) this.baseCellPx = this.fitCellPx();
        this.resize();
      });
      this.ro.observe(container);
    }
  }

  destroy(): void {
    this.ro?.disconnect();
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }

  private fitCellPx(): number {
    const w = this.container.clientWidth || WIDTH * 12;
    return Math.max(8, Math.floor(w / WIDTH));
  }

  // ---------- data ----------

  setFrame(frame: Uint32Array): void {
    if (frame.length !== CELLS) throw new RangeError('frame must have 1024 cells');
    this.frame = frame;
    this.requestDraw();
  }

  getFrame(): Uint32Array {
    return this.frame;
  }

  setPending(pending: ReadonlyMap<number, number>): void {
    this.pending = new Map(pending);
    this.requestDraw();
  }

  setFresh(fresh: ReadonlySet<number>): void {
    this.fresh = new Set(fresh);
    this.requestDraw();
  }

  setGenesisFrame(on: boolean): void {
    this.showGenesisFrame = on;
    this.requestDraw();
  }

  setCrewTint(on: boolean): void {
    this.showCrewTint = on;
    this.requestDraw();
  }

  // ---------- view ----------

  getZoom(): Zoom {
    return this.zoom;
  }

  setZoom(z: Zoom, anchor?: { x: number; y: number }): void {
    const old = this.cellPx;
    this.zoom = z;
    this.cellPx = this.baseCellPx * z;
    if (anchor) {
      // keep the anchored canvas point under the cursor
      const ax = (anchor.x - this.panX) / old;
      const ay = (anchor.y - this.panY) / old;
      this.panX = anchor.x - ax * this.cellPx;
      this.panY = anchor.y - ay * this.cellPx;
    } else {
      this.panX = 0;
      this.panY = 0;
    }
    this.clampPan();
    this.requestDraw();
  }

  resetView(): void {
    this.setZoom(1);
  }

  private clampPan(): void {
    const vw = this.canvas.width / this.dpr;
    const vh = this.canvas.height / this.dpr;
    const cw = WIDTH * this.cellPx;
    const ch = HEIGHT * this.cellPx;
    if (cw <= vw) this.panX = Math.floor((vw - cw) / 2);
    else this.panX = Math.min(0, Math.max(vw - cw, this.panX));
    if (ch <= vh) this.panY = Math.floor((vh - ch) / 2);
    else this.panY = Math.min(0, Math.max(vh - ch, this.panY));
  }

  private resize(): void {
    this.cellPx = this.baseCellPx * this.zoom;
    this.dpr = Math.max(1, Math.min(3, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1));
    const cssW = WIDTH * this.baseCellPx;
    const cssH = HEIGHT * this.baseCellPx;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.clampPan();
    this.requestDraw();
  }

  /** Cell under a client coordinate, or null. */
  cellAt(clientX: number, clientY: number): { cell: number; x: number; y: number } | null {
    const r = this.canvas.getBoundingClientRect();
    const px = clientX - r.left - this.panX;
    const py = clientY - r.top - this.panY;
    const x = Math.floor(px / this.cellPx);
    const y = Math.floor(py / this.cellPx);
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return null;
    return { cell: (y << 5) | x, x, y };
  }

  onHoverCell(cb: ((h: HoverInfo | null) => void) | null): void {
    this.onHover = cb;
  }

  onCellClick(cb: ((cell: number, ev: PointerEvent) => void) | null): void {
    this.onCell = cb;
  }

  onCellDrag(cb: ((cell: number, ev: PointerEvent) => void) | null): void {
    this.onDrag = cb;
  }

  private bind(): void {
    const c = this.canvas;
    c.addEventListener('pointermove', (ev) => {
      if (this.panning) {
        this.panX = this.panning.panX + (ev.clientX - this.panning.startX);
        this.panY = this.panning.panY + (ev.clientY - this.panning.startY);
        this.clampPan();
        this.requestDraw();
        return;
      }
      const hit = this.cellAt(ev.clientX, ev.clientY);
      const cell = hit ? hit.cell : null;
      if (cell !== this.hoverCell) {
        this.hoverCell = cell;
        this.requestDraw();
      }
      this.onHover?.(hit ? { ...hit, clientX: ev.clientX, clientY: ev.clientY } : null);
      if (this.dragging && hit && this.onDrag) this.onDrag(hit.cell, ev);
    });
    c.addEventListener('pointerleave', () => {
      this.hoverCell = null;
      this.onHover?.(null);
      this.requestDraw();
    });
    c.addEventListener('pointerdown', (ev) => {
      // middle button, space/shift-drag or right button pans; left paints
      if (ev.button === 1 || ev.button === 2 || ev.shiftKey || ev.altKey) {
        this.panning = { startX: ev.clientX, startY: ev.clientY, panX: this.panX, panY: this.panY };
        c.setPointerCapture(ev.pointerId);
        ev.preventDefault();
        return;
      }
      if (ev.button !== 0) return;
      const hit = this.cellAt(ev.clientX, ev.clientY);
      if (!hit) return;
      this.dragging = true;
      c.setPointerCapture(ev.pointerId);
      this.onCell?.(hit.cell, ev);
    });
    const end = (ev: PointerEvent) => {
      this.dragging = false;
      this.panning = null;
      try {
        c.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('contextmenu', (ev) => ev.preventDefault());
    c.addEventListener(
      'wheel',
      (ev) => {
        if (!ev.ctrlKey && !ev.metaKey) return;
        ev.preventDefault();
        const r = c.getBoundingClientRect();
        const anchor = { x: ev.clientX - r.left, y: ev.clientY - r.top };
        const order: Zoom[] = [1, 2, 4];
        const i = order.indexOf(this.zoom);
        const next = ev.deltaY < 0 ? order[Math.min(2, i + 1)]! : order[Math.max(0, i - 1)]!;
        if (next !== this.zoom) this.setZoom(next, anchor);
      },
      { passive: false },
    );
  }

  // ---------- drawing ----------

  requestDraw(): void {
    if (this.raf !== null) return;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number;
    this.raf = raf(() => {
      this.raf = null;
      this.draw();
    });
  }

  draw(): void {
    const ctx = this.ctx;
    const { dpr, cellPx, panX, panY } = this;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);
    ctx.translate(panX, panY);

    // base cells
    for (let i = 0; i < CELLS; i++) {
      const rec = this.frame[i]!;
      const x = (i & 31) * cellPx;
      const y = (i >> 5) * cellPx;
      ctx.fillStyle = PALETTE[rec & 0xf]!.hex;
      ctx.fillRect(x, y, cellPx, cellPx);
    }

    // crew region tint
    if (this.showCrewTint) {
      ctx.globalAlpha = 0.35;
      for (let i = 0; i < CELLS; i++) {
        const c = decodeCell(this.frame[i]!);
        if (c.painterId === 0) continue; // genesis / unpainted: no crew
        ctx.fillStyle = CREW_COLORS[c.crew] ?? '#ffffff';
        ctx.fillRect((i & 31) * cellPx, (i >> 5) * cellPx, cellPx, cellPx);
      }
      ctx.globalAlpha = 1;
    }

    // genesis dotted frame (default ON)
    if (this.showGenesisFrame) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      for (let i = 0; i < CELLS; i++) {
        if (((this.frame[i]! >>> 6) & 1) !== 1) continue;
        ctx.strokeRect((i & 31) * cellPx + 0.5, (i >> 5) * cellPx + 0.5, cellPx - 1, cellPx - 1);
      }
      ctx.restore();
    }

    // fresh thin border (mined, not yet safe)
    if (this.fresh.size) {
      ctx.save();
      ctx.strokeStyle = '#3a86ff';
      ctx.lineWidth = 1;
      for (const i of this.fresh) {
        ctx.strokeRect((i & 31) * cellPx + 0.5, (i >> 5) * cellPx + 0.5, cellPx - 1, cellPx - 1);
      }
      ctx.restore();
    }

    // pending hatch (queued / sent-not-mined)
    if (this.pending.size) {
      ctx.save();
      for (const [i, color] of this.pending) {
        const x = (i & 31) * cellPx;
        const y = (i >> 5) * cellPx;
        ctx.fillStyle = PALETTE[color & 0xf]!.hex;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x, y, cellPx, cellPx);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        const step = Math.max(3, Math.floor(cellPx / 3));
        for (let d = -cellPx; d < cellPx; d += step) {
          ctx.moveTo(x + d, y + cellPx);
          ctx.lineTo(x + d + cellPx, y);
        }
        ctx.rect(x + 0.5, y + 0.5, cellPx - 1, cellPx - 1);
        ctx.stroke();
      }
      ctx.restore();
    }

    // hover
    if (this.hoverCell !== null) {
      const i = this.hoverCell;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect((i & 31) * cellPx + 1, (i >> 5) * cellPx + 1, cellPx - 2, cellPx - 2);
    }
    ctx.restore();
  }
}
