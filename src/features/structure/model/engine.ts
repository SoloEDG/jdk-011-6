import type { FallingBlock, Workspace } from "../../../shared/document";
import { key } from "../../../shared/document";
import { overlapsPlayer } from "../../world/lib/queries";
import {
  cellsOf,
  dangerColumnsOf,
  supportSteps,
  type SupportPass,
  type SupportStep,
} from "../lib/analyze";

/** How long the red warning stays before unsupported blocks let go. */
export const WARNING_SECONDS = 2.6;
/**
 * Work slices the analyser may consume per frame. Each slice covers 400 cells,
 * so a full 32×32×20 world (20k cells) is scanned in roughly 35 frames while
 * costing only a few milliseconds per frame.
 */
const SLICES_PER_FRAME = 2;
const GRAVITY = 26;
const TERMINAL = 36;
const WORLD_TOP = 20;

interface Round {
  generation: number;
  iterator: Generator<SupportStep, SupportPass, void>;
}

const engines = new WeakMap<Workspace, StructureEngine>();

/**
 * Drives the structural simulation for one workspace.
 *
 * Scheduling rules:
 * - ANALYSIS runs in slices driven by the render loop. A large structure is
 *   scanned over several frames, so the page stays responsive and the player
 *   can keep building while the check is in progress.
 * - INVALIDATION: every edit bumps a generation counter and aborts the running
 *   scan and any pending collapse. A result is only installed when its
 *   generation is still current, so a reinforcement made while an older
 *   collapse calculation is running can never be overwritten by that older
 *   answer. This is the "reinforce during analysis" case.
 * - WARNING: when a completed pass finds unsupported blocks, nothing falls
 *   immediately. A visible countdown starts, the affected columns are
 *   highlighted, and the player has time to leave. Edits during the countdown
 *   trigger a fresh scan, but the original deadline is carried over: an edit
 *   may repair the structure or change which blocks are doomed, it may not buy
 *   extra time.
 * - COLLAPSE: unsupported blocks leave the grid and become continuously
 *   falling bodies, so they are no longer part of the stable structure. They
 *   are never credited to the inventory — only a deliberate dismantle refunds.
 * - SETTLING: each falling block lands on the highest solid surface in its
 *   column (or the ground) and is written back to the grid. A new analysis
 *   then runs, so a landed block can overload what it fell onto and trigger a
 *   genuine second collapse.
 * - RELOAD: the document stores blocks and in-flight blocks only. On load the
 *   engine recomputes support from scratch, so a half-fallen structure resumes
 *   moving instead of being preserved as a frozen sculpture.
 */
export class StructureEngine {
  private round: Round | null = null;
  private generation = 0;
  private pending: SupportPass | null = null;
  private warningUntil = 0;
  /**
   * Deadline carried over when an edit interrupts a warning. Recomputation
   * decides *which* blocks are unstable, but it may not buy the player more
   * time: otherwise placing an unrelated block would postpone a collapse
   * indefinitely.
   */
  private carriedDeadline: number | null = null;
  private needsReanalysis = true;
  private lastDoc: Workspace["doc"];
  private nextId = 1;
  private stopped = false;
  private frame = 0;
  private lastNow = 0;
  private nextReport = 0;
  /** Highest at-risk block per (x,z) column, recomputed once per analysis. */
  private dangerTop = new Map<string, number>();
  /**
   * Landed blocks write into the grid immediately, but the renderer rebuilds
   * its instanced meshes from `revision`. During a large collapse thousands of
   * blocks land within a few frames; refreshing the whole scene on every one of
   * them would dominate the frame. Flushes are therefore throttled to ~10/s.
   */
  private revisionPending = false;
  private lastFlush = 0;

  constructor(
    private s: Workspace,
    private warningSeconds = WARNING_SECONDS,
  ) {
    this.lastDoc = s.doc;
    this.seedIds();
  }

  private seedIds() {
    this.nextId = 1;
    for (const f of this.s.doc.falling)
      this.nextId = Math.max(this.nextId, f.id + 1);
  }

  start() {
    this.stopped = false;
    this.invalidate("正在分析结构支撑…");
    this.lastNow = performance.now();
    this.nextReport = this.lastNow;
    this.frame = requestAnimationFrame(this.loop);
  }

  dispose() {
    this.stopped = true;
    cancelAnimationFrame(this.frame);
    engines.delete(this.s);
  }

  /**
   * Called after any block edit. Cancels the running scan and any pending
   * collapse. `reason` is shown only when the edit actually unsettles the
   * structure; until the new scan finishes the state reads as "analysing".
   */
  invalidate(reason = "") {
    // Preserve an in-progress countdown across the recalculation.
    if (this.s.structure.phase === "warning" && this.pending)
      this.carriedDeadline =
        this.carriedDeadline === null
          ? this.warningUntil
          : Math.min(this.carriedDeadline, this.warningUntil);
    this.generation++;
    this.round = null;
    this.pending = null;
    this.warningUntil = 0;
    this.needsReanalysis = true;
    const st = this.s.structure;
    const blockCount = Object.keys(this.s.doc.blocks).length;
    st.phase = this.s.doc.falling.length ? "collapsing" : "analyzing";
    st.analyzed = 0;
    st.total = blockCount;
    st.stable = blockCount;
    st.unstable = 0;
    st.maxLoadRatio = 0;
    st.unstableKeys = [];
    st.dangerColumns = [];
    st.danger = false;
    st.warningLeft = 0;
    this.dangerTop.clear();
    st.falling = this.s.doc.falling.length;
    st.message = reason || "正在分析结构支撑…";
    st.resultId++;
    this.revisionPending = false;
  }

  private loop = (now: number) => {
    if (this.stopped) return;
    const elapsed = Math.min((now - this.lastNow) / 1000, 0.25);
    this.lastNow = now;
    this.syncRevision();
    this.advanceAnalysis(now);
    this.tickWarning(now);
    /**
     * Fixed physics substeps. Frames can be long (a big collapse or a slow
     * machine), but a single large dt would let blocks tunnel through thin
     * floors. Advancing in fixed 1/60 steps keeps the fall identical at any
     * frame rate; the 0.25s cap prevents a huge catch-up burst after a tab
     * switch.
     */
    let remaining = elapsed;
    let steps = 0;
    while (remaining > 1e-4 && steps++ < 8) {
      const dt = Math.min(remaining, 1 / 60);
      this.stepFalling(dt, now);
      remaining -= dt;
      if (!this.s.doc.falling.length) break;
    }
    this.flushLandings(now, !this.s.doc.falling.length);
    this.updateDanger(now);
    this.frame = requestAnimationFrame(this.loop);
  };

  /**
   * Detects document swaps (loading a save, importing a file). The engine and
   * the editing commands mutate the same document object in place, so only a
   * real replacement of `doc` reaches here. Player movement therefore never
   * cancels an active collapse warning.
   */
  private syncRevision() {
    if (this.s.doc === this.lastDoc) return;
    this.lastDoc = this.s.doc;
    this.seedIds();
    // A new document must not inherit the previous world's countdown.
    this.carriedDeadline = null;
    this.invalidate("世界已载入，重新检查结构支撑");
  }

  private beginRound() {
    this.needsReanalysis = false;
    const cells = cellsOf(this.s.doc.blocks);
    const st = this.s.structure;
    st.phase = this.s.doc.falling.length ? "collapsing" : "analyzing";
    st.total = cells.size;
    st.analyzed = 0;
    const keepNotice = /碎裂|顶端|未能落稳/.test(this.s.message);
    st.message = keepNotice ? this.s.message : "正在分析结构支撑…";
    this.round = {
      generation: this.generation,
      // 400 cells per pull, a few pulls per frame: big worlds are scanned over
      // several frames instead of blocking one long task.
      iterator: supportSteps(cells, 400),
    };
  }

  private advanceAnalysis(now: number) {
    // Wait for in-flight blocks to settle; their landing changes the geometry.
    if (this.s.doc.falling.length) return;
    const st = this.s.structure;
    if (st.phase === "warning" || st.phase === "collapsing") return;
    if (!this.round) {
      if (!this.needsReanalysis) return;
      this.beginRound();
    }
    const round = this.round!;
    if (round.generation !== this.generation) {
      this.round = null;
      return;
    }
    // A fixed number of work slices per frame. This is deterministic (so the
    // simulation can be tested without a wall clock) and bounded, which keeps
    // the frame budget flat no matter how large the structure is.
    for (let slice = 0; slice < SLICES_PER_FRAME; slice++) {
      const step = round.iterator.next();
      if (step.done) {
        this.round = null;
        if (round.generation === this.generation) this.install(step.value);
        return;
      }
      st.analyzed = step.value.scanned;
      st.total = step.value.total;
    }
    // Routine scan progress should never hide a notice the player must read
    // (a shatter or a block lost at the world ceiling).
    if (!/碎裂|顶端|未能落稳/.test(st.message))
      st.message = `正在分析结构支撑… ${Math.min(
        99,
        Math.round((st.analyzed / Math.max(1, st.total)) * 100),
      )}%`;
    void now;
  }

  private install(result: SupportPass) {
    const st = this.s.structure;
    st.total = result.total;
    st.stable = result.stable;
    st.unstable = result.unstable;
    st.analyzed = result.total;
    st.maxLoadRatio = Math.round(result.maxLoadRatio * 100) / 100;
    st.unstableKeys = result.unstableKeys;
    st.dangerColumns = dangerColumnsOf(result.unstableKeys);
    this.indexDanger();
    st.resultId++;
    if (result.unstable === 0) {
      this.pending = null;
      this.carriedDeadline = null;
      st.phase = "idle";
      st.warningLeft = 0;
      st.danger = false;
      st.message = `结构稳定 · ${result.stable} 个方块承重正常`;
      // Routine structural progress may replace a stale status line, but a
      // player-facing notice (a shatter, a block lost at the ceiling) stays
      // visible until they do something else.
      if (!/碎裂|顶端|未能落稳/.test(this.s.message)) this.s.message = st.message;
      return;
    }
    // Any edit since this scan started would have bumped the generation, so a
    // result reaching here always matches the current geometry.
    this.pending = result;
    const now = performance.now();
    const fresh = now + this.warningSeconds * 1000;
    // Re-analysis may only shorten the warning, never extend it. If the
    // original deadline has already passed while the scan ran, the collapse
    // proceeds immediately on the next tick instead of granting a new grace
    // period — otherwise repeated edits would postpone it forever.
    this.warningUntil =
      this.carriedDeadline === null
        ? fresh
        : Math.min(fresh, this.carriedDeadline);
    this.carriedDeadline = null;
    st.phase = "warning";
    st.warningLeft = Math.max(0, (this.warningUntil - now) / 1000);
    if (st.warningLeft <= 0) {
      // The carried deadline elapsed during the scan: let go right away.
      st.message = `结构失稳：${result.unstable} 个方块失去支撑`;
      this.s.message = st.message;
      this.collapse();
      return;
    }
    st.message = `结构失稳：${result.unstable} 个方块即将坠落`;
    this.s.message = st.message;
  }

  private tickWarning(now: number) {
    const st = this.s.structure;
    if (st.phase !== "warning" || !this.pending) return;
    const left = Math.max(0, (this.warningUntil - now) / 1000);
    st.warningLeft = Math.ceil(left * 10) / 10;
    if (left > 0) return;
    this.collapse();
  }

  private collapse() {
    const result = this.pending;
    if (!result) return;
    this.pending = null;
    const s = this.s;
    const falling: FallingBlock[] = [];
    for (const k of result.unstableKeys) {
      const b = s.doc.blocks[k];
      // A block that was dismantled during the countdown is simply gone.
      if (!b) continue;
      const [x, y, z] = k.split(",").map(Number);
      delete s.doc.blocks[k];
      falling.push({
        id: this.nextId++,
        material: b.material,
        x,
        z,
        y: y + 0.5,
        vy: 0,
      });
    }
    const st = s.structure;
    st.phase = "collapsing";
    st.warningLeft = 0;
    st.unstable = 0;
    st.unstableKeys = [];
    st.dangerColumns = [];
    st.danger = false;
    if (!falling.length) {
      this.needsReanalysis = true;
      st.phase = "analyzing";
      return;
    }
    // Deliberately no inventory credit: a collapse is not a dismantle.
    s.doc.falling.push(...falling);
    s.doc.revision++;
    s.dirty = true;
    const standing = Object.keys(s.doc.blocks).length;
    st.stable = standing;
    st.total = standing + s.doc.falling.length;
    st.falling = s.doc.falling.length;
    st.message = `结构坍塌：${falling.length} 个方块正在坠落`;
    s.message = st.message;
    this.needsReanalysis = true;
  }

  private stepFalling(dt: number, now: number) {
    const s = this.s;
    const st = s.structure;
    if (!s.doc.falling.length) {
      st.falling = 0;
      if (st.phase === "collapsing" || st.phase === "warning") return;
      if (this.needsReanalysis && !this.round) {
        this.generation++;
        this.beginRound();
      }
      return;
    }
    st.phase = "collapsing";
    st.falling = s.doc.falling.length;
    let touched = false;
    const remaining: FallingBlock[] = [];
    const airborne = s.doc.falling;
    /**
     * Falling blocks in the same column must not pass through each other: a
     * block sees any other block below it as a surface to land on. Grouping by
     * column first keeps this linear, which matters when a large slab comes
     * down at once (a naive any-within-list scan is O(n²) per frame).
     */
    const columns = new Map<string, FallingBlock[]>();
    for (const f of airborne) {
      const ck = `${f.x},${f.z}`;
      const list = columns.get(ck);
      if (list) list.push(f);
      else columns.set(ck, [f]);
    }
    for (const list of columns.values()) list.sort((a, b) => a.y - b.y);

    for (const f of airborne) {
      f.vy = Math.max(f.vy - GRAVITY * dt, -TERMINAL);
      let nextY = f.y + f.vy * dt;
      // Surface is evaluated at the start-of-step bottom. Because the bottom is
      // monotonic while falling, checking each frame cannot tunnel through a
      // block, even at terminal velocity.
      let surface = this.surfaceIn(f.x, f.z, f.y - 0.5);
      let restingOnAirborne = false;
      const stack = columns.get(`${f.x},${f.z}`)!;
      // Ascending order: scan up to the nearest block underneath this one.
      for (const other of stack) {
        if (other.y >= f.y - 1e-4) break;
        const top = other.y + 0.5;
        if (top > surface) {
          surface = top;
          restingOnAirborne = true;
        }
      }
      if (restingOnAirborne && nextY - 0.5 <= surface + 1e-4) {
        // Stacked on another falling block. It stays in flight (so it is not
        // written into the grid as if it had support) but it must not sink
        // through the block below.
        f.y = Math.max(f.y, surface + 0.5);
        f.vy = 0;
        remaining.push(f);
        continue;
      }
      if (nextY - 0.5 <= surface) {
        // Snap onto the surface, or break if the player is standing there.
        const placed = this.land(f, surface);
        touched = true;
        if (!placed) {
          // The block shattered; it is neither recovered nor added to the grid.
        }
        continue;
      }
      if (nextY > f.y && f.vy > 0) {
        f.vy = 0;
        nextY = f.y;
      }
      f.y = nextY;
      remaining.push(f);
    }
    if (remaining.length !== s.doc.falling.length || touched) {
      // Falling motion is not a grid change: the scene tracks those positions
      // through their own signature. Landing writes blocks, so a revision
      // flush is scheduled; it is batched rather than applied per block.
      s.doc.falling = remaining;
      if (touched) this.revisionPending = true;
      s.dirty = true;
    }
    st.falling = s.doc.falling.length;
    st.total = Object.keys(s.doc.blocks).length + s.doc.falling.length;
    // Standing count follows the grid as blocks land, so the panel never shows
    // more stable blocks than actually exist.
    st.stable = Object.keys(s.doc.blocks).length;
    if (!s.doc.falling.length) {
      st.phase = "analyzing";
      // Keep a warning the player needs to act on (a shatter, a block lost at
      // the world ceiling) visible instead of overwriting it with routine
      // progress text.
      const keepNotice = /碎裂|山顶|顶端|未能落稳/.test(s.message);
      st.message = keepNotice ? s.message : "坠落停止，正在复查结构支撑…";
      if (!keepNotice) s.message = st.message;
      this.needsReanalysis = true;
      this.generation++;
      this.beginRound();
    } else {
      st.phase = "collapsing";
      if (now > this.nextReport) {
        this.nextReport = now + 300;
        st.message = `${st.falling} 个方块正在坠落…`;
      }
    }
  }

  /**
   * Publishes landed blocks to the renderer at most ~10 times a second, and
   * always immediately once nothing is left in the air.
   */
  private flushLandings(now: number, final: boolean) {
    if (!this.revisionPending) return;
    if (!final && now - this.lastFlush < 90) return;
    this.revisionPending = false;
    this.lastFlush = now;
    this.s.doc.revision++;
  }

  /** Highest solid top (in cell units) at or below `bottom` in this column. */
  private surfaceIn(x: number, z: number, bottom: number): number {
    let surface = 0;
    for (let y = 0; y < WORLD_TOP; y++) {
      if (y + 1 <= bottom + 1e-4 && this.s.doc.blocks[key({ x, y, z })])
        surface = Math.max(surface, y + 1);
    }
    return surface;
  }

  private land(f: FallingBlock, surface: number): boolean {
    const s = this.s;
    const player = s.doc.player;
    let y = Math.max(0, Math.min(WORLD_TOP - 1, Math.round(surface)));
    // A block may never overwrite placed or just-landed geometry; find the
    // next free cell up.
    while (y < WORLD_TOP && s.doc.blocks[key({ x: f.x, y, z: f.z })]) y++;
    if (y >= WORLD_TOP) {
      s.message = "一块坠落的方块堆到了世界顶端，未能落稳";
      return false;
    }
    if (overlapsPlayer({ x: f.x, y, z: f.z }, player)) {
      // The warning window exists precisely so this is avoidable. A block that
      // does land on the player shatters: it is not recovered and not added to
      // the world, which also prevents a "block stuck on the player's head"
      // state from looping through the analyser forever.
      s.message = "坠落的方块砸中角色并碎裂，未能回收";
      return false;
    }
    const cell = { x: f.x, y, z: f.z };
    s.doc.blocks[key(cell)] = { ...cell, material: f.material };
    return true;
  }

  /**
   * Pre-indexes unstable blocks by column so the per-frame danger check costs a
   * handful of lookups instead of scanning every unstable block.
   */
  private indexDanger() {
    this.dangerTop.clear();
    for (const k of this.s.structure.unstableKeys) {
      const [x, y, z] = k.split(",").map(Number);
      const ck = `${x},${z}`;
      const prev = this.dangerTop.get(ck);
      if (prev === undefined || y > prev) this.dangerTop.set(ck, y);
    }
  }

  private updateDanger(now: number) {
    const st = this.s.structure;
    st.warningLeft =
      st.phase === "warning"
        ? Math.max(0, (this.warningUntil - now) / 1000)
        : 0;
    if (st.phase !== "warning" || !st.dangerColumns.length) {
      if (st.danger) st.danger = false;
      st.warningLeft = 0;
      return;
    }
    const p = this.s.doc.player;
    let danger = false;
    // Block centres sit at x+0.5, so 0.85 in each axis matches the player's
    // 0.78 body half-width. Any height counts: a block falling down the
    // player's column lands on them no matter how far above it started. The
    // column index stores the highest at-risk block, so one comparison covers
    // the whole stack.
    const x0 = Math.floor(p.x - 0.85);
    const x1 = Math.floor(p.x + 0.85);
    const z0 = Math.floor(p.z - 0.85);
    const z1 = Math.floor(p.z + 0.85);
    for (let x = x0; x <= x1 && !danger; x++) {
      if (Math.abs(x + 0.5 - p.x) >= 0.85) continue;
      for (let z = z0; z <= z1; z++) {
        if (Math.abs(z + 0.5 - p.z) >= 0.85) continue;
        const top = this.dangerTop.get(`${x},${z}`);
        if (top !== undefined && top + 1 >= p.y - 0.75) {
          danger = true;
          break;
        }
      }
    }
    const changed = st.danger !== danger;
    st.danger = danger;
    if (st.phase === "warning") {
      const msg = danger
        ? `⚠ 危险：头顶结构将在 ${st.warningLeft.toFixed(1)} 秒内坠落，快离开红色区域`
        : `${st.unstable} 个方块失去支撑，${st.warningLeft.toFixed(1)} 秒后坠落（你已在安全位置）`;
      if (st.message !== msg) st.message = msg;
    }
    if (changed) this.s.message = st.message;
  }
}

export function attachStructure(s: Workspace, warningSeconds?: number) {
  const engine = new StructureEngine(s, warningSeconds);
  engines.set(s, engine);
  engine.start();
  return () => engine.dispose();
}

/** Called from edit paths; a no-op before the engine is mounted. */
export function notifyStructure(s: Workspace, reason = "") {
  engines.get(s)?.invalidate(reason);
}
