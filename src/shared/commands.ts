import type { Block, Vec3 } from "./document";
export interface EditResult {
  ok: boolean;
  message: string;
  changed: Block[];
}
export interface SceneHit {
  cell: Vec3;
  adjacent: Vec3;
}
export interface WorldSummary {
  total: number;
  highest: number;
  materials: number;
}
/** Static facts about a single block, used by the structural analyser. */
export interface CellRule {
  span: number;
  weight: number;
  capacity: number;
}
export interface StructureStats {
  total: number;
  stable: number;
  unstable: number;
  maxLoadRatio: number;
  unstableKeys: string[];
}