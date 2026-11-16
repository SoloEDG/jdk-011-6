export type MaterialId =
  | "grass"
  | "soil"
  | "stone"
  | "wood"
  | "sand"
  | "brick"
  | "glass"
  | "leaf";
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Block extends Vec3 {
  material: MaterialId;
}
/**
 * A block that has lost its support. Its x/z stay aligned with the voxel
 * column it fell from while y is a continuous centre position. Falling blocks
 * live outside `blocks`, so they can never be mistaken for placed, stable
 * geometry when the world is serialised.
 */
export interface FallingBlock {
  id: number;
  material: MaterialId;
  x: number;
  z: number;
  y: number;
  vy: number;
}
export interface WorldDocument {
  version: 1;
  name: string;
  blocks: Record<string, Block>;
  inventory: Record<MaterialId, number>;
  player: Vec3;
  revision: number;
  falling: FallingBlock[];
}
export interface Region {
  a: Vec3;
  b: Vec3;
}
export type Tool = "place" | "remove" | "select";
export type StructurePhase = "idle" | "analyzing" | "warning" | "collapsing";
/** Live, non-persisted structural state shown by the UI and the 3D scene. */
export interface StructureRuntime {
  phase: StructurePhase;
  stable: number;
  unstable: number;
  total: number;
  analyzed: number;
  maxLoadRatio: number;
  unstableKeys: string[];
  /** Columns (x,z) whose blocks are about to fall. */
  dangerColumns: Vec3[];
  danger: boolean;
  /** Seconds left before pending blocks start falling. */
  warningLeft: number;
  falling: number;
  message: string;
  /** Increments whenever a completed analysis result is installed. */
  resultId: number;
}
export interface Workspace {
  doc: WorldDocument;
  material: MaterialId;
  tool: Tool;
  region: Region | null;
  anchor: Vec3 | null;
  message: string;
  dirty: boolean;
  mode: "build" | "walk";
  savedAt: string | null;
  structure: StructureRuntime;
}
export const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
export const inside = (p: Vec3) =>
  p.x >= -16 && p.x < 16 && p.z >= -16 && p.z < 16 && p.y >= 0 && p.y < 20;
