import { inside, key, type Workspace, type Vec3 } from "../../../shared/document";

/**
 * Finds a nearby safe cell for the player when a collapse is imminent.
 *
 * A column is unsafe if any block above the player's feet is about to fall in
 * it; we also avoid the columns immediately around those, because a block can
 * clip the player's shoulder on the way down. Candidate spots are ranked by
 * walking distance from the current position and must have clear headroom.
 */
export function findSafeSpot(s: Workspace): Vec3 | null {
  const st = s.structure;
  const blocked = new Set<string>();
  for (const k of st.unstableKeys) {
    const [x, , z] = k.split(",").map(Number);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) blocked.add(`${x + dx},${z + dz}`);
  }
  const p = s.doc.player;
  let best: Vec3 | null = null;
  let bestScore = Infinity;
  for (let x = Math.floor(p.x) - 8; x <= Math.floor(p.x) + 8; x++) {
    for (let z = Math.floor(p.z) - 8; z <= Math.floor(p.z) + 8; z++) {
      if (!inside({ x, y: 0, z })) continue;
      if (blocked.has(`${x},${z}`)) continue;
      // Find the top of this column.
      let top = -1;
      for (let y = 19; y >= 0; y--) {
        if (s.doc.blocks[key({ x, y, z })]) {
          top = y;
          break;
        }
      }
      const standY = top + 1;
      if (standY + 2 > 20) continue;
      // Needs room for a 1.7-block body.
      let clear = true;
      for (let y = standY; y <= standY + 1 && clear; y++)
        if (s.doc.blocks[key({ x, y, z })]) clear = false;
      if (!clear) continue;
      const score =
        Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z) + Math.abs(standY - p.y) * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = { x: x + 0.5, y: standY, z: z + 0.5 };
      }
    }
  }
  return best;
}

/** Runs the escape: if no safe spot exists the player is left to their fate. */
export function escapeDanger(s: Workspace) {
  const spot = findSafeSpot(s);
  if (!spot) {
    s.message = "周围没有安全落点，寻找更远的位置！";
    return false;
  }
  Object.assign(s.doc.player, spot);
  s.dirty = true;
  s.mode = "walk";
  s.message = "已撤离到安全位置，注意头顶结构";
  return true;
}
