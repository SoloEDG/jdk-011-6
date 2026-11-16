import type { Workspace, WorldDocument } from "../../../shared/document";
import { writeWorld, readWorld, downloadWorld } from "../lib/storage";
import { decode } from "../lib/codec";
function install(s: Workspace, doc: WorldDocument) {
  const revision = s.doc.revision + 1;
  s.doc = doc;
  // Force the live structural engine to treat this as an external document
  // change: it re-seeds falling-block IDs and re-runs analysis from scratch.
  // No structural verdict is restored from the file, so nothing can stay
  // frozen in the air just because it was saved while falling.
  s.doc.revision = revision;
  s.structure.phase = "analyzing";
  s.structure.message = "正在复查载入世界的结构…";
  s.structure.unstable = 0;
  s.structure.unstableKeys = [];
  s.structure.dangerColumns = [];
  s.structure.danger = false;
  s.structure.warningLeft = 0;
  s.structure.falling = doc.falling.length;
  s.dirty = false;
  s.mode = "build";
  s.savedAt = null;
  s.message = doc.falling.length
    ? "世界已载入，正在承接未完成的坠落"
    : "世界已载入";
}
export function save(s: Workspace) {
  try {
    s.savedAt = writeWorld(s.doc);
    s.dirty = false;
    s.message = s.doc.falling.length
      ? `世界已保存（含 ${s.doc.falling.length} 个坠落中的方块）`
      : "世界已保存到此浏览器";
  } catch {
    s.message = "保存失败，请导出备份";
  }
}
export function load(s: Workspace) {
  try {
    install(s, readWorld());
  } catch (e) {
    s.message = (e as Error).message;
  }
}
export function exportWorld(s: Workspace) {
  downloadWorld(s.doc);
  s.message = "世界文件已导出";
}
export async function importWorld(s: Workspace, file: File) {
  try {
    install(s, decode(await file.text()));
  } catch (e) {
    s.message = (e as Error).message;
  }
}
