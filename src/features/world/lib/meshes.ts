import * as THREE from "three";
import type { FallingBlock, WorldDocument } from "../../../shared/document";
import { materials, materialSpec } from "../../../shared/materials";

const geometry = new THREE.BoxGeometry(1, 1, 1);

function shadeOf(x: number, y: number, z: number) {
  return 0.92 + ((x * 13 + z * 7 + y * 3) % 7) * 0.012;
}

export function blockMeshes(doc: WorldDocument) {
  const group = new THREE.Group();
  for (const spec of materials) {
    const blocks = Object.values(doc.blocks).filter(
      (b) => b.material === spec.id,
    );
    if (!blocks.length) continue;
    const mesh = new THREE.InstancedMesh(
      geometry.clone(),
      new THREE.MeshStandardMaterial({
        color: spec.color,
        roughness: 0.9,
        transparent: spec.opacity < 1,
        opacity: spec.opacity,
      }),
      blocks.length,
    );
    const matrix = new THREE.Matrix4();
    blocks.forEach((b, i) => {
      matrix.makeTranslation(b.x + 0.5, b.y + 0.5, b.z + 0.5);
      mesh.setMatrixAt(i, matrix);
      const shade = shadeOf(b.x, b.y, b.z);
      mesh.setColorAt(i, new THREE.Color().setScalar(shade));
    });
    mesh.userData.cells = blocks;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

export function fallingMeshes(falling: FallingBlock[]) {
  const group = new THREE.Group();
  for (const spec of materials) {
    const parts = falling.filter((f) => f.material === spec.id);
    if (!parts.length) continue;
    const mesh = new THREE.InstancedMesh(
      geometry.clone(),
      new THREE.MeshStandardMaterial({
        color: spec.color,
        roughness: 0.92,
        transparent: spec.opacity < 1,
        opacity: spec.opacity,
        emissive: new THREE.Color("#8d5a2b"),
        emissiveIntensity: 0.08,
      }),
      parts.length,
    );
    const matrix = new THREE.Matrix4();
    parts.forEach((f, i) => {
      // A slight tumble makes a collapse read as motion even in a screenshot.
      const tilt = Math.min(0.35, Math.abs(f.vy) * 0.02);
      const euler = new THREE.Euler(tilt * 0.7, 0, tilt);
      matrix.makeRotationFromEuler(euler);
      matrix.setPosition(f.x + 0.5, f.y, f.z + 0.5);
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, new THREE.Color().setScalar(shadeOf(f.x, 0, f.z)));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.falling = parts;
    group.add(mesh);
  }
  return group;
}

/**
 * Emissive wireframe boxes drawn around blocks that are about to give way.
 * They pulse during the warning window, so danger is visible from anywhere in
 * the scene rather than only in the side panel.
 */
export function unstableMarker(cells: { x: number; y: number; z: number }[]) {
  const group = new THREE.Group();
  if (!cells.length) return group;
  const edges = new THREE.EdgesGeometry(geometry);
  const material = new THREE.LineBasicMaterial({
    color: "#d9614a",
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });
  const lines = new THREE.LineSegments(edges, material);
  lines.renderOrder = 4;
  const matrix = new THREE.Matrix4();
  for (const c of cells) {
    // One object per cell keeps each hull 1×1×1; a single merged line buffer
    // would need per-cell offsets, and warnings are capped at a few hundred.
    if (group.children.length >= 600) break;
    const line = lines.clone();
    matrix.makeTranslation(c.x + 0.5, c.y + 0.5, c.z + 0.5);
    line.applyMatrix4(matrix);
    line.matrixAutoUpdate = false;
    group.add(line);
  }
  group.userData.material = material;
  return group;
}

/**
 * Translucent red columns under the blocks at risk: the player's "leave this
 * area" cue, readable even when the camera is far from the affected wall.
 */
export function dangerColumns(
  columns: { x: number; z: number; y?: number }[],
) {
  const group = new THREE.Group();
  if (!columns.length) return group;
  const material = new THREE.MeshBasicMaterial({
    color: "#de5844",
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  for (const c of columns.slice(0, 400)) {
    // The overlay runs from the floor to the highest at-risk block, so it
    // frames the actual hazard instead of a fixed tall shaft.
    const top = Math.max(2, (c.y ?? 8) + 1);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, top, 1), material.clone());
    mesh.position.set(c.x + 0.5, top / 2, c.z + 0.5);
    mesh.renderOrder = 2;
    group.add(mesh);
  }
  return group;
}

export function disposeGroup(group: THREE.Group) {
  group.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
      o.geometry.dispose();
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      ms.forEach((m) => m.dispose());
    }
  });
}

export { materialSpec };
