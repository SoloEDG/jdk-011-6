import {
  inside,
  key,
  type Workspace,
  type Vec3,
  type Block,
} from "../../../shared/document";
import { overlapsPlayer } from "../lib/queries";
import type { EditResult } from "../../../shared/commands";
import { notifyStructure } from "../../structure/model/engine";
import { materialSpec } from "../../../shared/materials";

/**
 * Applies a batch of placements or dismantles.
 *
 * Refunds happen only here — when a block is deliberately dismantled. Blocks
 * that fall from a collapse are handled by the structure engine and never
 * credit the inventory, so material cannot be farmed by undermining a building.
 *
 * Every successful edit invalidates the running structural analysis, which is
 * the point where reinforcement can interrupt an older collapse calculation.
 */
export function editCells(
  s: Workspace,
  cells: Vec3[],
  remove = false,
): EditResult {
  const unique = [...new Map(cells.map((p) => [key(p), p])).values()];
  const changed: Block[] = [];
  for (const p of unique) {
    const old = s.doc.blocks[key(p)];
    if (!inside(p) || (!remove && old) || (remove && (!old || p.y === 0)))
      continue;
    if (!remove && overlapsPlayer(p, s.doc.player))
      return { ok: false, message: "这里是角色所在位置", changed: [] };
    // Do not place a block into a cell a falling block already occupies; the
    // two would end up sharing a cell on landing.
    if (
      !remove &&
      s.doc.falling.some(
        (f) =>
          f.x === p.x &&
          f.z === p.z &&
          Math.floor(f.y) === p.y,
      )
    )
      return { ok: false, message: "空中有坠落方块，稍后再放置", changed: [] };
    changed.push(remove ? old! : { ...p, material: s.material });
  }
  if (!remove && s.doc.inventory[s.material] < changed.length)
    return { ok: false, message: "物品数量不足，未进行建造", changed: [] };
  for (const b of changed) {
    if (remove) {
      delete s.doc.blocks[key(b)];
      s.doc.inventory[b.material]++;
    } else {
      s.doc.blocks[key(b)] = b;
      s.doc.inventory[b.material]--;
    }
  }
  if (changed.length) {
    s.doc.revision++;
    s.dirty = true;
    // Re-check support from scratch; any in-flight collapse is superseded.
    notifyStructure(
      s,
      remove
        ? `拆除了 ${changed.length} 个方块，重新检查支撑…`
        : `已放置 ${changed.length} 个方块，检查承重…`,
    );
  }
  const load = changed.length
    ? changed.reduce((n, b) => n + materialSpec(b.material).weight, 0)
    : 0;
  return {
    ok: true,
    message: changed.length
      ? `${remove ? "拆除" : "放置"}了 ${changed.length} 个方块${
          remove ? `，回收材料 ${changed.length} 份` : `（新增载荷 ${load.toFixed(1)}）`
        }`
      : "没有可修改的方块",
    changed,
  };
}
