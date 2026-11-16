import type { StructureRuntime } from "./document";

/** Fresh, non-persisted runtime state for the structural simulation. */
export function emptyStructure(): StructureRuntime {
  return {
    phase: "idle",
    stable: 0,
    unstable: 0,
    total: 0,
    analyzed: 0,
    maxLoadRatio: 0,
    unstableKeys: [],
    dangerColumns: [],
    danger: false,
    warningLeft: 0,
    falling: 0,
    message: "等待结构分析",
    resultId: 0,
  };
}
