import type { FallingBlock, WorldDocument } from "../../../shared/document";
import { inside, key } from "../../../shared/document";
import { materials } from "../../../shared/materials";

/**
 * Save format
 * -----------
 * Only the authoritative world state is written: the placed blocks, the
 * inventory, the player and the blocks that are currently in the air.
 *
 * Structural conclusions are deliberately *not* saved. A saved "stable" flag
 * would turn a half-collapsed building into a permanent sculpture on reload,
 * so every load recomputes support from the geometry. Falling blocks are stored
 * with their position and velocity, so resuming a save resumes the fall instead
 * of freezing it.
 */
export function encode(doc: WorldDocument) {
  return JSON.stringify({
    version: doc.version,
    name: doc.name,
    blocks: doc.blocks,
    inventory: doc.inventory,
    player: doc.player,
    revision: doc.revision,
    falling: doc.falling,
  });
}

const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);

function decodeFalling(raw: unknown): FallingBlock[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw Error("坠落方块数据无效");
  if (raw.length > 20480) throw Error("坠落方块数量超出限制");
  const seen = new Set<number>();
  return raw.map((f: any) => {
    if (
      !f ||
      !Number.isInteger(f.id) ||
      seen.has(f.id) ||
      !finite(f.x) ||
      !finite(f.y) ||
      !finite(f.z) ||
      !Number.isInteger(f.x) ||
      !Number.isInteger(f.z) ||
      !Number.isFinite(f.vy) ||
      !materials.some((m) => m.id === f.material)
    )
      throw Error("文件包含无效的坠落方块");
    seen.add(f.id);
    if (
      f.x < -16 ||
      f.x >= 16 ||
      f.z < -16 ||
      f.z >= 16 ||
      f.y < 0 ||
      f.y > 21.5
    )
      throw Error("坠落方块超出世界边界");
    return {
      id: f.id,
      material: f.material,
      x: f.x,
      z: f.z,
      y: f.y,
      vy: Math.max(-40, Math.min(40, f.vy)),
    };
  });
}

export function decode(raw: string): WorldDocument {
  if (raw.length > 5_000_000) throw Error("世界文件过大");
  const d = JSON.parse(raw);
  if (
    d.version !== 1 ||
    typeof d.name !== "string" ||
    !d.blocks ||
    !d.inventory ||
    !d.player
  )
    throw Error("无法识别的世界文件");
  const entries = Object.entries(d.blocks);
  if (entries.length > 20480) throw Error("方块数量超出世界边界");
  for (const [k, b] of entries as [string, any][]) {
    if (
      ![b.x, b.y, b.z].every(Number.isInteger) ||
      !inside(b) ||
      key(b) !== k ||
      !materials.some((m) => m.id === b.material)
    )
      throw Error("文件包含无效方块");
  }
  for (const m of materials)
    if (!Number.isInteger(d.inventory[m.id]) || d.inventory[m.id] < 0)
      throw Error("物品栏数据无效");
  if (![d.player.x, d.player.y, d.player.z].every(Number.isFinite))
    throw Error("角色坐标无效");
  if (!Number.isInteger(d.revision) || d.revision < 0)
    throw Error("世界版本无效");
  const falling = decodeFalling(d.falling);
  // A falling block may not share its current cell with placed geometry; it is
  // allowed to be above another block, since that is what it lands on.
  for (const f of falling) {
    const cell = { x: f.x, y: Math.floor(f.y), z: f.z };
    if (d.blocks[key(cell)]) throw Error("坠落方块与已有方块重叠");
  }
  return {
    version: 1,
    name: d.name,
    blocks: d.blocks,
    inventory: d.inventory,
    player: d.player,
    revision: d.revision,
    falling,
  };
}
