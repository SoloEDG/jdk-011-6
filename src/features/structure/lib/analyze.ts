import type { Block, Vec3 } from "../../../shared/document";
import { key } from "../../../shared/document";
import { materials, materialSpec } from "../../../shared/materials";
import type { CellRule, StructureStats } from "../../../shared/commands";

/**
 * Structural model
 * ----------------
 * Two separate checks decide whether a block can stay where it was placed.
 *
 * Support — a block is held up when it touches the ground (y = 0), sits
 * directly on a held-up block, or reaches sideways from a held-up block across
 * a gap no wider than its material's `span`. Sand never cantilevers; brick,
 * stone and glass span 1; leaves span 3; wood beams span 4. Grass and soil
 * also span 1 — enough for a doorstep, not for a lintel. Because the span is
 * checked on every sideways step, the beam's distance from its anchored column
 * is what matters, not the step before it.
 *
 * Load — every block carries its own weight plus everything resting on it.
 * Load runs down columns and back through cantilevers toward their anchor. A
 * block carrying more than its material's `capacity` gives way, bringing down
 * everything it carried. Stone and brick foundations shrug off loads that would
 * crush a glass or sand column, and a long unsupported beam can tear a support
 * loose even when the geometry alone looks fine.
 *
 * The pass is implemented as a generator so both the live engine and the tests
 * can run it in one go, while the engine yields between slices so the page stays
 * responsive on large structures.
 */
export const MAX_SPAN = Math.max(...materials.map((m) => m.span));

export const ruleOf = (b: Block): CellRule => {
  const spec = materialSpec(b.material);
  return { span: spec.span, weight: spec.weight, capacity: spec.capacity };
};

export interface SupportPass extends StructureStats {
  /** Every block that must fall. */
  fall: Set<string>;
  /** Accumulated load per supported block. */
  load: Map<string, number>;
  /** Distance from the nearest ground-anchored column (0 = on a column). */
  order: Map<string, number>;
}

export interface SupportStep {
  kind: "progress";
  scanned: number;
  total: number;
}

export function* supportSteps(
  cells: Map<string, Block>,
  budget = 1500,
): Generator<SupportStep, SupportPass, void> {
  const total = cells.size;
  const dist = new Map<string, number>();
  const queues: string[][] = Array.from({ length: MAX_SPAN + 1 }, () =>
    [],
  );
  const heads = new Array<number>(MAX_SPAN + 1).fill(0);
  const rules = new Map<string, CellRule>();
  for (const [k, b] of cells) rules.set(k, ruleOf(b));

  const assign = (k: string, d: number) => {
    if (d > MAX_SPAN) return;
    const prev = dist.get(k);
    if (prev !== undefined && prev <= d) return;
    dist.set(k, d);
    queues[d].push(k);
  };
  for (const [k, b] of cells) if (b.y === 0) assign(k, 0);

  let scanned = 0;
  let sinceYield = 0;
  // Sweep the distance buckets until no bucket has pending work. A block that
  // is re-reached at a shorter cantilever distance moves to a lower bucket, so
  // a sweep can leave work behind; repeat until a sweep is empty.
  let active = true;
  while (active) {
    active = false;
    for (let d = 0; d <= MAX_SPAN; d++) {
      const queue = queues[d];
      while (heads[d] < queue.length) {
        const k = queue[heads[d]++];
        if (dist.get(k) !== d) continue;
        active = true;
        scanned++;
        const [x, y, z] = k.split(",").map(Number);
        // Stacking is free: everything directly above stays at the same
        // horizontal distance from the support column.
        const above = key({ x, y: y + 1, z });
        if (cells.has(above)) assign(above, d);
        if (d + 1 <= MAX_SPAN) {
          for (const [dx, dz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const nk = key({ x: x + dx, y, z: z + dz });
            if (!cells.has(nk)) continue;
            // The destination material determines how far this step may reach.
            if ((rules.get(nk)?.span ?? 0) < d + 1) continue;
            assign(nk, d + 1);
          }
        }
        if (++sinceYield >= budget) {
          sinceYield = 0;
          yield { kind: "progress", scanned, total };
        }
      }
    }
  }

  yield { kind: "progress", scanned, total };

  // Anything not reached from the ground is floating and cannot hold anything.
  const fall = new Set<string>();
  for (const k of cells.keys()) if (!dist.has(k)) fall.add(k);

  // Load-carrying graph. A supported block is carried by every neighbour that
  // is at least as anchored as it is: the block below (when it is not farther
  // from a column) and sideways neighbours closer to their column. Splitting
  // the load across several carriers is what lets a wall or a canopy spread
  // its weight instead of piling it onto a single block.
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const [k, d] of dist) {
    const b = cells.get(k)!;
    if (b.y === 0) continue;
    const [x, y, z] = k.split(",").map(Number);
    const found: string[] = [];
    const below = key({ x, y: y - 1, z });
    const belowD = dist.get(below);
    if (belowD !== undefined && belowD <= d) found.push(below);
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nk = key({ x: x + dx, y, z: z + dz });
      const nd = dist.get(nk);
      if (nd !== undefined && nd < d) found.push(nk);
    }
    if (!found.length) {
      // A supported block with no supported carrier is a contradiction; let it
      // fall rather than inventing support.
      fall.add(k);
      continue;
    }
    parents.set(k, found);
    for (const p of found) {
      const list = children.get(p);
      if (list) list.push(k);
      else children.set(p, [k]);
    }
  }

  // Topological order: parents always sit lower or at a smaller cantilever
  // distance on the same layer, so descending (y, distance) visits children
  // before their carriers.
  const order = [...dist.keys()]
    .filter((k) => !fall.has(k))
    .sort((a, b) => {
      const pa = cells.get(a)!;
      const pb = cells.get(b)!;
      return pb.y - pa.y || (dist.get(b) ?? 0) - (dist.get(a) ?? 0);
    });

  let load = new Map<string, number>();
  const computeLoad = (excluded: Set<string>) => {
    const next = new Map<string, number>();
    for (const k of order) if (!excluded.has(k)) next.set(k, rules.get(k)?.weight ?? 1);
    for (const k of order) {
      if (excluded.has(k)) continue;
      const carriers = (parents.get(k) ?? []).filter((p) => !excluded.has(p));
      if (!carriers.length) continue;
      const share = (next.get(k) ?? 0) / carriers.length;
      for (const p of carriers) next.set(p, (next.get(p) ?? 0) + share);
    }
    return next;
  };

  let maxLoadRatio = 0;
  let overloaded: string[] = [];
  const measure = (current: Map<string, number>) => {
    overloaded = [];
    for (const [k, v] of current) {
      const capacity = Math.max(0.001, rules.get(k)?.capacity ?? 1);
      const ratio = v / capacity;
      // Keep the peak across all rounds: once an overloaded block is removed
      // the survivors look lightly loaded, but the diagnosis should still
      // report how far over capacity the structure went.
      if (ratio > maxLoadRatio) maxLoadRatio = ratio;
      if (ratio > 1.0001) overloaded.push(k);
    }
  };

  load = computeLoad(new Set());
  measure(load);
  // A failed block takes down everything that can no longer reach a carrier.
  // Recompute until the surviving structure carries its own weight.
  let rounds = 0;
  while (overloaded.length && rounds++ < 12) {
    const doomed = [...overloaded];
    while (doomed.length) {
      const k = doomed.pop()!;
      if (fall.has(k)) continue;
      fall.add(k);
      for (const child of children.get(k) ?? []) {
        if (fall.has(child)) continue;
        const carriers = (parents.get(child) ?? []).filter((p) => !fall.has(p));
        if (!carriers.length) doomed.push(child);
      }
    }
    load = computeLoad(fall);
    measure(load);
  }

  const unstableKeys = [...fall].sort((a, b) => {
    const pa = cells.get(a)!;
    const pb = cells.get(b)!;
    return pa.y - pb.y || pa.x - pb.x || pa.z - pb.z;
  });
  return {
    total,
    stable: total - unstableKeys.length,
    unstable: unstableKeys.length,
    maxLoadRatio,
    unstableKeys,
    fall,
    load,
    order: dist,
  };
}

export function analyseSupportSync(cells: Map<string, Block>): SupportPass {
  const it = supportSteps(cells);
  let next = it.next();
  while (!next.done) next = it.next();
  return next.value;
}

export function cellsOf(blocks: Record<string, Block>): Map<string, Block> {
  return new Map(Object.entries(blocks));
}

/**
 * Columns touched by a set of unstable cells, used for hazard previews. `y` is
 * the highest at-risk block, so the overlay can stop at the actual height of
 * the structure instead of guessing.
 */
export function dangerColumnsOf(keys: string[]): Vec3[] {
  const seen = new Map<string, Vec3>();
  for (const k of keys) {
    const [x, y, z] = k.split(",").map(Number);
    const ck = `${x},${z}`;
    const prev = seen.get(ck);
    if (!prev) seen.set(ck, { x, y, z });
    else if (y > prev.y) prev.y = y;
  }
  return [...seen.values()];
}
