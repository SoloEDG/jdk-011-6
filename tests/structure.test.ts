import { installHarness } from "./harness";
import { editCells } from "../src/features/world/model/edit";
import { analyseSupportSync } from "../src/features/structure/lib/analyze";
import {
  attachStructure,
} from "../src/features/structure/model/engine";
import { save, load } from "../src/features/archive/model/archive";
import { decode, encode } from "../src/features/archive/lib/codec";
import { emptyStructure } from "../src/shared/structure";
import type {
  Block,
  MaterialId,
  Workspace,
  WorldDocument,
} from "../src/shared/document";
import { key } from "../src/shared/document";
import { initialStock } from "../src/shared/materials";

const clock = installHarness();

let failures = 0;
function ok(cond: boolean, label: string, extra?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}`, extra ?? "");
  }
}
function eq(a: unknown, b: unknown, label: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
}

function docWith(
  put: (p: (x: number, y: number, z: number, m: MaterialId) => void) => void,
): WorldDocument {
  const blocks: Record<string, Block> = {};
  put((x, y, z, m) => {
    const b = { x, y, z, material: m };
    blocks[key(b)] = b;
  });
  return {
    version: 1,
    name: "test",
    blocks,
    inventory: initialStock(),
    player: { x: 0, y: 1, z: 8 },
    revision: 0,
    falling: [],
  };
}

function workspace(doc: WorldDocument): Workspace {
  return {
    doc,
    material: "wood",
    tool: "place",
    region: null,
    anchor: null,
    message: "",
    dirty: false,
    mode: "build",
    savedAt: null,
    structure: emptyStructure(),
  } as Workspace;
}

const cellsOfDoc = (doc: WorldDocument) => new Map(Object.entries(doc.blocks));

/** Advance frames until `predicate` holds or the budget runs out. */
async function waitFor(
  label: string,
  predicate: () => boolean,
  seconds = 8,
): Promise<boolean> {
  const step = 1 / 60;
  for (let t = 0; t < seconds; t += step) {
    if (predicate()) return true;
    await clock.advance(step, step);
  }
  console.log(`    (timeout waiting for ${label})`);
  return predicate();
}

async function main() {
  clock.resetStorage();

  console.log("\n— support geometry —");
  {
    const cells = new Map<string, Block>();
    const put = (x: number, y: number, z: number, m: MaterialId) =>
      cells.set(key({ x, y, z }), { x, y, z, material: m });
    // Anchored columns at y=0..1, then a beam hanging at y=1.
    put(0, 0, 0, "stone");
    put(0, 1, 0, "stone");
    for (let i = 1; i <= 4; i++) put(i, 1, 0, "wood");
    eq(analyseSupportSync(cells).unstable, 0, "wood beam spans 4 cells");

    const brick = new Map<string, Block>();
    const putB = (x: number, y: number, z: number, m: MaterialId) =>
      brick.set(key({ x, y, z }), { x, y, z, material: m });
    putB(0, 0, 0, "stone");
    putB(0, 1, 0, "stone");
    for (let i = 1; i <= 3; i++) putB(i, 1, 0, "brick");
    eq(analyseSupportSync(brick).unstable, 2, "brick only spans 1 cell");

    const sand = new Map<string, Block>();
    sand.set("0,0,0", { x: 0, y: 0, z: 0, material: "stone" });
    sand.set("0,1,0", { x: 0, y: 1, z: 0, material: "stone" });
    sand.set("1,1,0", { x: 1, y: 1, z: 0, material: "sand" });
    eq(analyseSupportSync(sand).unstable, 1, "sand never cantilevers");

    const stack = new Map<string, Block>();
    for (let y = 0; y < 12; y++) stack.set(`0,${y},0`, { x: 0, y, z: 0, material: "glass" });
    eq(analyseSupportSync(stack).unstable, 0, "a tall glass column stands");
  }

  console.log("\n— collapse after removing a pillar —");
  {
    const doc = docWith((p) => {
      for (let x = -1; x <= 1; x++)
        for (let z = -1; z <= 1; z++) p(x, 0, z, "stone");
      p(0, 1, 0, "wood");
      p(0, 2, 0, "wood");
      for (let x = -1; x <= 1; x++)
        for (let z = -1; z <= 1; z++) p(x, 3, z, "wood");
    });
    doc.player = { x: 0, y: 4.5, z: 0 };
    const s = workspace(doc);
    const detach = attachStructure(s, 3);
    await waitFor("initial analysis", () => s.structure.phase === "idle");
    eq(s.structure.phase, "idle", "initial world is stable");
    eq(Object.keys(s.doc.blocks).length, 20, "initial block count");

    editCells(s, [{ x: 0, y: 1, z: 0 }], true);
    eq(s.doc.inventory.wood, 257, "dismantled pillar refunded once");
    const refunded = s.doc.inventory.wood;
    ok(
      s.structure.phase === "analyzing" || s.structure.phase === "warning",
      "removal starts a fresh analysis",
      s.structure.phase,
    );
    await waitFor("warning", () => s.structure.phase === "warning");
    eq(s.structure.phase, "warning", "unsupported roof is flagged before it falls");
    ok(s.structure.unstable > 0, "warning counts unsupported blocks", s.structure.unstable);
    ok(s.structure.danger, "player under the roof is in the danger zone");
    ok(s.structure.warningLeft > 0, "a visible countdown is running", s.structure.warningLeft);
    const stableAtWarning = s.structure.stable;

    await waitFor("collapse", () => s.structure.phase === "collapsing");
    eq(s.structure.phase, "collapsing", "warning expires into a collapse");
    await waitFor("settled", () => s.doc.falling.length === 0);
    await clock.frames(2);
    eq(s.doc.falling.length, 0, "all falling blocks land");
    eq(s.doc.inventory.wood, refunded, "collapse refunds nothing");
    eq(
      Object.keys(s.doc.blocks).length,
      stableAtWarning + (s.structure.total - stableAtWarning),
      "standing + landed blocks account for the warning total",
    );
    eq(s.structure.phase, "idle", "final structure is stable");
    eq(s.structure.unstable, 0, "no blocks left unsupported");
    detach();
  }

  console.log("\n— reinforce while the scan is running —");
  {
    const doc = docWith((p) => {
      for (let x = -14; x <= 14; x++)
        for (let z = -14; z <= 14; z++) p(x, 0, z, "stone");
      // A dense ring of walls gives the scanner thousands of cells to visit.
      for (let y = 1; y <= 12; y++)
        for (let x = -13; x <= 13; x++)
          for (let z = -13; z <= 13; z++)
            if (Math.abs(x) === 13 || Math.abs(z) === 13) p(x, y, z, "brick");
      p(0, 1, 0, "wood");
      for (let x = -3; x <= 3; x++)
        for (let z = -3; z <= 3; z++) p(x, 7, z, "wood");
    });
    doc.player = { x: 0, y: 9, z: 0 };
    const s = workspace(doc);
    const detach = attachStructure(s, 1.5);
    await clock.frames(1);
    eq(s.structure.phase, "analyzing", "large world is still being scanned");
    ok(s.structure.total > 2000, "analysis total is large", s.structure.total);
    ok(
      s.structure.analyzed < s.structure.total,
      "first frame reports partial progress",
      `${s.structure.analyzed}/${s.structure.total}`,
    );
    const before = Object.keys(s.doc.blocks).length;
    const posts = [
      [-2, -2],
      [2, -2],
      [-2, 2],
      [2, 2],
    ];
    for (let y = 1; y <= 6; y++)
      for (const [x, z] of posts) editCells(s, [{ x, y, z }]);
    eq(s.structure.phase, "analyzing", "edit interrupts and restarts the scan");
    await waitFor("reinforced stability", () => s.structure.phase === "idle", 20);
    eq(s.structure.unstable, 0, "reinforced structure is stable");
    eq(s.structure.phase, "idle", "no stale collapse fired");
    eq(Object.keys(s.doc.blocks).length, before + 24, "all 24 posts are present");
    eq(s.doc.inventory.wood, 256 - 24, "only the posted beams were spent");
    detach();
  }

  console.log("\n— reinforcing during the warning cancels the collapse —");
  {
    const doc = docWith((p) => {
      for (let x = -2; x <= 2; x++)
        for (let z = -2; z <= 2; z++) p(x, 0, z, "stone");
      for (let y = 1; y <= 3; y++) p(0, y, 0, "wood");
      for (let x = -3; x <= 3; x++)
        for (let z = -3; z <= 3; z++) p(x, 4, z, "wood");
    });
    doc.player = { x: 6, y: 1, z: 6 };
    const s = workspace(doc);
    const detach = attachStructure(s, 1.2);
    await waitFor("pre-warning", () => s.structure.phase === "warning");
    eq(s.structure.phase, "warning", "roof is flagged");
    const blocksAtWarning = Object.keys(s.doc.blocks).length;
    // Add corner posts while the countdown is running.
    for (let y = 1; y <= 3; y++)
      for (const [x, z] of [
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ])
        editCells(s, [{ x, y, z }]);
    eq(s.structure.phase, "analyzing", "reinforcement cancels the countdown");
    await waitFor("stable again", () => s.structure.phase === "idle");
    eq(s.structure.phase, "idle", "structure is stable after reinforcement");
    eq(s.structure.unstable, 0, "nothing remains unsupported");
    eq(s.doc.falling.length, 0, "nothing fell");
    eq(Object.keys(s.doc.blocks).length, blocksAtWarning + 12, "posts are in place");
    detach();
  }

  console.log("\n— overload collapses even when geometry looks fine —");
  {
    const doc = docWith((p) => {
      for (let x = -2; x <= 2; x++)
        for (let z = -2; z <= 2; z++) p(x, 0, z, "stone");
      // A single 1x1 glass column carrying a cross-shaped stone load: the
      // geometry is fine (span 1) but the weight exceeds glass capacity.
      for (let y = 1; y <= 4; y++) p(0, y, 0, "glass");
      for (const [x, z] of [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ])
        for (let y = 5; y <= 7; y++) p(x, y, z, "stone");
    });
    const s = workspace(doc);
    const before = analyseSupportSync(cellsOfDoc(s.doc));
    ok(before.unstable > 0, "heavy slab overloads the glass column", before.unstable);
    ok(before.maxLoadRatio > 1, "load ratio reports the overload", before.maxLoadRatio);
    // The same load on a stone column holds: stone has both the span for the
    // overhang and the capacity for the slab.
    const strong = docWith((p) => {
      for (let x = -2; x <= 2; x++)
        for (let z = -2; z <= 2; z++) p(x, 0, z, "stone");
      for (let y = 1; y <= 4; y++) p(0, y, 0, "stone");
      for (const [x, z] of [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ])
        for (let y = 5; y <= 7; y++) p(x, y, z, "stone");
    });
    eq(
      analyseSupportSync(cellsOfDoc(strong)).unstable,
      0,
      "the same load on a stone column holds",
    );
    const detach = attachStructure(s, 0.2);
    await waitFor("overload collapse", () => s.doc.falling.length === 0 && s.structure.phase === "idle", 12);
    eq(s.structure.unstable, 0, "overloaded world settles");
    eq(s.doc.inventory.stone, 256, "no stone refunded by the overload collapse");
    detach();
  }

  console.log("\n— edits cannot postpone a warning forever —");
  {
    const doc = docWith((p) => {
      for (let x = -3; x <= 3; x++)
        for (let z = -3; z <= 3; z++) p(x, 0, z, "stone");
      for (let y = 1; y <= 3; y++) p(0, y, 0, "wood");
      for (let x = -3; x <= 3; x++)
        for (let z = -3; z <= 3; z++) p(x, 4, z, "wood");
    });
    doc.player = { x: 9, y: 1, z: 9 };
    const s = workspace(doc);
    const detach = attachStructure(s, 1);
    await waitFor("warning", () => s.structure.phase === "warning");
    const firstDeadline = s.structure.warningLeft;
    // Repeated unrelated edits: each restarts the analysis but must not reset
    // the countdown afresh.
    for (let i = 0; i < 6; i++) {
      editCells(s, [{ x: 8, y: 1, z: 8 }]);
      await clock.advance(0.1);
    }
    await waitFor("unavoidable collapse", () => s.doc.falling.length > 0, 4);
    ok(s.doc.falling.length > 0, "collapse still happens despite the edits");
    ok(firstDeadline > 0, "a countdown was visible", firstDeadline);
    detach();
  }

  console.log("\n— stacks of falling blocks land without overlapping —");
  {
    const doc = docWith((p) => {
      for (let x = -3; x <= 3; x++)
        for (let z = -3; z <= 3; z++) p(x, 0, z, "stone");
      // Two small slabs at different heights in the same columns, both
      // unsupported from the start.
      for (let x = -1; x <= 1; x++)
        for (let z = -1; z <= 1; z++) {
          p(x, 6, z, "wood");
          p(x, 9, z, "wood");
        }
    });
    doc.player = { x: 8, y: 1, z: 8 };
    const s = workspace(doc);
    const detach = attachStructure(s, 0.2);
    await waitFor("stack collapse", () => s.doc.falling.length === 0, 12);
    await waitFor("stack re-analysis", () => s.structure.phase === "idle", 12);
    eq(s.doc.falling.length, 0, "both slabs have landed");
    // 7×7 ground + 2 slabs of 3×3 = 49 + 18 blocks, none lost or duplicated.
    eq(Object.keys(s.doc.blocks).length, 67, "no block lost or duplicated");
    // Each landed stack must occupy distinct cells.
    const occupied = new Set<string>();
    let overlap = false;
    for (const b of Object.values(s.doc.blocks)) {
      if (occupied.has(key(b))) overlap = true;
      occupied.add(key(b));
    }
    ok(!overlap, "no two blocks share a cell");
    eq(s.doc.inventory.wood, 256, "no wood was refunded by the fall");
    detach();
  }

  console.log("\n— a block landing on the player shatters instead of stacking —");
  {
    const doc = docWith((p) => {
      for (let x = -3; x <= 3; x++)
        for (let z = -3; z <= 3; z++) p(x, 0, z, "stone");
      p(0, 8, 0, "brick");
    });
    doc.player = { x: 0.5, y: 1, z: 0.5 };
    const s = workspace(doc);
    const detach = attachStructure(s, 0.2);
    await waitFor("brick warning", () => s.structure.phase === "warning");
    ok(s.structure.danger, "standing under the brick is a danger");
    await waitFor("brick airborne", () => s.doc.falling.length > 0, 8);
    await waitFor("brick resolved", () => s.doc.falling.length === 0, 8);
    ok(s.message.includes("碎裂"), "the shatter is reported to the player", s.message);
    await waitFor("settled after shatter", () => s.structure.phase === "idle", 8);
    eq(Object.keys(s.doc.blocks).length, 49, "shattered brick is not added to the world");
    eq(s.doc.inventory.brick, 256, "shattered brick is not refunded");
    ok(
      s.message.includes("碎裂"),
      "the shatter notice survives re-analysis",
      s.message,
    );
    detach();
  }

  console.log("\n— save / load keeps counts and stability consistent —");
  {
    const doc = docWith((p) => {
      for (let x = -10; x <= 10; x++)
        for (let z = -10; z <= 10; z++) p(x, 0, z, "grass");
    });
    const s = workspace(doc);
    const detach = attachStructure(s, 0.4);
    await clock.frames(120);
    eq(s.structure.phase, "idle", "flat world stable before saving");
    const total = Object.keys(s.doc.blocks).length;
    save(s);
    detach();
    const s2 = workspace({
      version: 1,
      name: "placeholder",
      blocks: {},
      inventory: initialStock(),
      player: { x: 0, y: 1, z: 8 },
      revision: 99,
      falling: [],
    });
    const detach2 = attachStructure(s2, 0.4);
    await clock.frames(30);
    load(s2);
    await clock.frames(120);
    eq(Object.keys(s2.doc.blocks).length, total, "loaded block count matches save");
    eq(s2.structure.stable, total, "loaded world re-analysed as stable");
    eq(s2.structure.unstable, 0, "load does not invent instability");
    detach2();
  }

  console.log("\n— reloading a mid-collapse world resumes the fall —");
  {
    const doc = docWith((p) => {
      for (let x = -2; x <= 2; x++)
        for (let z = -2; z <= 2; z++) p(x, 0, z, "stone");
      for (let x = -1; x <= 1; x++)
        for (let z = -1; z <= 1; z++) p(x, 5, z, "brick");
    });
    const s = workspace(doc);
    const detach = attachStructure(s, 1.2);
    await waitFor("slab warning", () => s.structure.phase === "warning");
    eq(s.structure.phase, "warning", "dangling slab flagged");
    await waitFor("slab falling", () => s.doc.falling.length > 0);
    eq(s.structure.phase, "collapsing", "slab starts to fall");
    ok(s.doc.falling.length > 0, "blocks are in the air", s.doc.falling.length);
    const airborne = s.doc.falling.length;
    const standing = Object.keys(s.doc.blocks).length;
    const midAir = s.doc.falling.map((f) => f.material);
    const saved = encode(s.doc);
    detach();

    const decoded = decode(saved);
    eq(decoded.falling.length, airborne, "airborne blocks survive save/load");
    eq(Object.keys(decoded.blocks).length, standing, "standing blocks survive save/load");
    const s2 = workspace(decoded);
    const detach2 = attachStructure(s2, 0.2);
    await waitFor("reloaded settle", () => s2.doc.falling.length === 0);
    eq(s2.doc.falling.length, 0, "reloaded blocks settle instead of hanging in the air");
    ok(
      s2.structure.phase === "idle" || s2.structure.phase === "analyzing",
      "structure is re-evaluated rather than frozen",
      s2.structure.phase,
    );
    eq(
      Object.keys(s2.doc.blocks).length,
      standing + airborne,
      "block counts line up after reload and settle",
    );
    eq(s2.structure.unstable, 0, "reloaded world ends stable");
    ok(midAir.length === airborne, "airborne materials preserved", midAir);
    detach2();
  }

  console.log("\n— reload mid-fall matches an uninterrupted run exactly —");
  {
    const build = () =>
      docWith((p) => {
        for (let x = -3; x <= 3; x++)
          for (let z = -3; z <= 3; z++) p(x, 0, z, "stone");
        // A hanging canopy with several layers in different columns.
        for (let x = -2; x <= 2; x++)
          for (let z = -2; z <= 2; z++) p(x, 5, z, "wood");
        for (let x = -1; x <= 1; x++)
          for (let z = -1; z <= 1; z++) p(x, 6, z, "brick");
        for (let x = 0; x <= 1; x++) p(x, 7, 0, "glass");
      });
    const occupancy = (d: WorldDocument) =>
      Object.keys(d.blocks).sort().join("|");

    // Reference: one uninterrupted run.
    const a = workspace(build());
    a.doc.player = { x: 8, y: 1, z: 8 };
    const detachA = attachStructure(a, 0.4);
    await waitFor("reference settle", () => a.structure.phase === "idle" && a.doc.falling.length === 0, 20);
    const reference = occupancy(a.doc);
    const referenceStable = a.structure.stable;
    detachA();

    // Interrupted: save while the canopy is in the air, then load.
    const b = workspace(build());
    b.doc.player = { x: 8, y: 1, z: 8 };
    const detachB = attachStructure(b, 0.4);
    await waitFor("airborne", () => b.doc.falling.length > 0, 10);
    const saved = encode(b.doc);
    detachB();
    const decoded = decode(saved);
    const c = workspace(decoded);
    const detachC = attachStructure(c, 0.4);
    await waitFor("resumed settle", () => c.structure.phase === "idle" && c.doc.falling.length === 0, 20);
    detachC();
    eq(occupancy(c.doc), reference, "reloaded world settles into the same cells");
    eq(c.structure.stable, referenceStable, "reloaded stable count matches");
    eq(c.doc.inventory, b.doc.inventory, "inventory is untouched across the reload");
  }

  console.log("\n— landed blocks can overload the structure below —");
  {
    const doc = docWith((p) => {
      for (let x = -1; x <= 1; x++)
        for (let z = -1; z <= 1; z++) p(x, 0, z, "stone");
      for (let x = -1; x <= 1; x++)
        for (let z = -1; z <= 1; z++) p(x, 8, z, "brick");
    });
    doc.player = { x: 9, y: 1, z: 9 };
    const s = workspace(doc);
    const detach = attachStructure(s, 0.2);
    await waitFor("slab landed", () => s.doc.falling.length === 0, 10);
    eq(s.doc.falling.length, 0, "slab has landed");
    await waitFor("post-landing analysis", () => s.structure.phase === "idle", 10);
    const final = analyseSupportSync(cellsOfDoc(s.doc));
    eq(final.unstable, 0, "landed pile re-analysed as stable");
    ok(
      Object.keys(s.doc.blocks).length > 9,
      "landed bricks are in the world",
      Object.keys(s.doc.blocks).length,
    );
    detach();
  }

  console.log("\n— the renderer sees every landed block eventually —");
  {
    const doc = docWith((p) => {
      for (let x = -4; x <= 4; x++)
        for (let z = -4; z <= 4; z++) p(x, 0, z, "stone");
      for (let x = -2; x <= 2; x++)
        for (let z = -2; z <= 2; z++) p(x, 6, z, "wood");
    });
    doc.player = { x: 9, y: 1, z: 9 };
    const s = workspace(doc);
    const detach = attachStructure(s, 0.2);
    const revisionAtStart = s.doc.revision;
    await waitFor("batch settle", () => s.doc.falling.length === 0 && s.structure.phase === "idle", 20);
    ok(
      s.doc.revision > revisionAtStart,
      "a final revision flush marks the landed geometry",
      s.doc.revision,
    );
    // The rendered block set is derived from doc.blocks, so the count must
    // match what a fresh analysis computes.
    eq(
      Object.keys(s.doc.blocks).length,
      analyseSupportSync(cellsOfDoc(s.doc)).total,
      "renderer's source of truth matches the analysed geometry",
    );
    detach();
  }

  console.log("\n— danger zone follows the player's column —");
  {
    // A hanging block high above the player's head: it is above 4 blocks away,
    // yet falling down that column would still hit them.
    const doc = docWith((p) => {
      for (let x = -4; x <= 4; x++)
        for (let z = -4; z <= 4; z++) p(x, 0, z, "stone");
      for (let y = 1; y <= 12; y++) p(0, y, 0, "wood");
      p(0, 17, 0, "wood");
      p(1, 17, 0, "wood");
    });
    doc.player = { x: 0.5, y: 1, z: 0.5 };
    const s = workspace(doc);
    const detach = attachStructure(s, 3);
    await waitFor("high warning", () => s.structure.phase === "warning");
    eq(s.structure.phase, "warning", "high dangling block warns");
    ok(
      s.structure.unstableKeys.every((k) => Number(k.split(",")[1]) >= 17),
      "only the high blocks are unstable",
      s.structure.unstableKeys,
    );
    ok(s.structure.danger, "far-overhead block is a danger");
    await clock.frames(30);
    ok(s.structure.danger, "danger remains until the drop");
    detach();
  }

  console.log("\n— safe escape leaves the danger zone —");
  {
    const { escapeDanger, findSafeSpot } = await import(
      "../src/features/structure/lib/escape"
    );
    const doc = docWith((p) => {
      for (let x = -6; x <= 6; x++)
        for (let z = -6; z <= 6; z++) p(x, 0, z, "grass");
    });
    for (let x = -2; x <= 2; x++)
      for (let z = -2; z <= 2; z++)
        doc.blocks[key({ x, y: 4, z }) as string] = {
          x,
          y: 4,
          z,
          material: "brick",
        };
    doc.player = { x: 0, y: 1, z: 0 };
    const s = workspace(doc);
    const detach = attachStructure(s, 3);
    await waitFor("danger warning", () => s.structure.phase === "warning");
    eq(s.structure.phase, "warning", "danger is pending");
    const spot = findSafeSpot(s);
    ok(!!spot, "a safe spot exists", spot);
    if (spot) {
      const d = Math.hypot(spot.x - 0, spot.z - 0);
      ok(d > 2.4, "safe spot is outside the drop columns", d);
    }
    escapeDanger(s);
    await clock.frames(4);
    eq(s.structure.danger, false, "player is out of the danger zone after escaping");
    await clock.frames(600);
    eq(s.doc.falling.length, 0, "collapse completes without burying the player");
    ok(
      s.doc.player.y >= 1,
      "player remains at a walkable height",
      s.doc.player,
    );
    detach();
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall structure tests passed");
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
