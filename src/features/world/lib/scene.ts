import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  blockMeshes,
  fallingMeshes,
  unstableMarker,
  dangerColumns,
  disposeGroup,
} from "./meshes";
import type { Workspace, Vec3 } from "../../../shared/document";
import type { SceneHit } from "../../../shared/commands";
export function mountScene(
  host: HTMLElement,
  state: Workspace,
  onHit: (hit: SceneHit) => void,
) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#dce5df");
  scene.fog = new THREE.Fog("#dce5df", 55, 110);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  camera.position.set(30, 27, 34);
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 2, 0);
  controls.maxPolarAngle = Math.PI / 2.1;
  controls.minDistance = 8;
  controls.maxDistance = 70;
  controls.enableDamping = true;
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN,
  };
  scene.add(new THREE.HemisphereLight("#fffae8", "#779082", 2.5));
  const sun = new THREE.DirectionalLight("#fff1d5", 3);
  sun.position.set(-15, 32, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {
    left: -25,
    right: 25,
    top: 25,
    bottom: -25,
  });
  sun.shadow.bias = -0.001;
  scene.add(sun);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: "#cdd8d0", roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.08;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(32, 32, "#abb9ad", "#c3cec3");
  grid.position.y = 0.005;
  scene.add(grid);
  let blocks = blockMeshes(state.doc);
  scene.add(blocks);
  let fallingGroup = fallingMeshes(state.doc.falling);
  scene.add(fallingGroup);
  let unstableGroup = new THREE.Group();
  scene.add(unstableGroup);
  let hazardGroup = new THREE.Group();
  scene.add(hazardGroup);
  const cursor = new THREE.Mesh(
    new THREE.BoxGeometry(1.02, 1.02, 1.02),
    new THREE.MeshBasicMaterial({ color: "#e9b261", wireframe: true }),
  );
  cursor.visible = false;
  scene.add(cursor);
  const region = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({
      color: "#eab569",
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
    }),
  );
  region.visible = false;
  scene.add(region);
  const avatar = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 0.95, 0.38),
    new THREE.MeshStandardMaterial({ color: "#df8d4d" }),
  );
  body.position.y = 0.7;
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.46, 0.46, 0.46),
    new THREE.MeshStandardMaterial({ color: "#f1ceac" }),
  );
  head.position.y = 1.4;
  avatar.add(body, head);
  scene.add(avatar);
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let hit: SceneHit | null = null;
  const move = (e: PointerEvent) => {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      (-(e.clientY - r.top) / r.height) * 2 + 1,
    );
    ray.setFromCamera(mouse, camera);
    const h = ray.intersectObjects(blocks.children)[0];
    hit = null;
    if (h && h.instanceId !== undefined && h.face) {
      const cell = h.object.userData.cells[h.instanceId] as Vec3;
      const n = h.face.normal;
      hit = {
        cell: { ...cell },
        adjacent: { x: cell.x + n.x, y: cell.y + n.y, z: cell.z + n.z },
      };
      const p = state.tool === "place" ? hit.adjacent : hit.cell;
      cursor.position.set(p.x + 0.5, p.y + 0.5, p.z + 0.5);
    }
    cursor.visible = !!hit;
  };
  let down = { x: 0, y: 0 };
  const start = (e: PointerEvent) => {
    down = { x: e.clientX, y: e.clientY };
  };
  const click = (e: PointerEvent) => {
    if (
      e.button === 0 &&
      Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5 &&
      hit &&
      state.mode === "build"
    )
      onHit(hit);
  };
  renderer.domElement.addEventListener("pointermove", move);
  renderer.domElement.addEventListener("pointerdown", start);
  renderer.domElement.addEventListener("pointerup", click);
  const resize = new ResizeObserver(() => {
    const w = host.clientWidth,
      h = host.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resize.observe(host);
  let frame = 0,
    revision = -1;
  let fallingCount = -1,
    fallingSignature = "";
  function refreshFalling() {
    const list = state.doc.falling;
    const signature = list
      .map((f) => `${f.id}:${f.y.toFixed(2)}`)
      .join("|");
    if (signature === fallingSignature && list.length === fallingCount) return;
    fallingSignature = signature;
    fallingCount = list.length;
    scene.remove(fallingGroup);
    disposeGroup(fallingGroup);
    fallingGroup = fallingMeshes(list);
    scene.add(fallingGroup);
  }
  let overlayPhase = "";
  function refreshStructureOverlay() {
    const st = state.structure;
    // `resultId` changes on every installed analysis, so the warn/danger
    // geometry follows edits without being rebuilt each frame.
    const key = `${st.resultId}:${st.phase}`;
    if (key === overlayPhase) return;
    overlayPhase = key;
    scene.remove(unstableGroup);
    disposeGroup(unstableGroup);
    unstableGroup = unstableMarker(
      st.unstableKeys.map((k) => {
        const [x, y, z] = k.split(",").map(Number);
        return { x, y, z };
      }),
    );
    scene.add(unstableGroup);
    scene.remove(hazardGroup);
    disposeGroup(hazardGroup);
    hazardGroup = dangerColumns(st.dangerColumns);
    scene.add(hazardGroup);
  }
  function animate() {
    frame = requestAnimationFrame(animate);
    if (revision !== state.doc.revision) {
      scene.remove(blocks);
      disposeGroup(blocks);
      blocks = blockMeshes(state.doc);
      scene.add(blocks);
      revision = state.doc.revision;
    }
    // Falling blocks move every frame, so they are rebuilt rather than keyed
    // to a revision. Their count is small (one collapse at a time).
    refreshFalling();
    refreshStructureOverlay();
    avatar.position.set(
      state.doc.player.x,
      state.doc.player.y,
      state.doc.player.z,
    );
    const danger = state.structure.danger;
    const warning = state.structure.phase === "warning";
    const cursorMat = cursor.material as THREE.MeshBasicMaterial;
    cursorMat.color.set(
      danger ? "#e04a3a" : warning ? "#e07a3a" : "#e9b261",
    );
    const pulse = 1 + Math.sin(performance.now() / 220) * 0.04;
    cursor.scale.setScalar(danger ? pulse * 1.08 : 1);
    hazardGroup.children.forEach((c, i) => {
      const m = (c as THREE.Mesh).material as THREE.MeshBasicMaterial;
      m.opacity = 0.1 + 0.1 * (0.5 + 0.5 * Math.sin(performance.now() / 260 + i));
    });
    unstableGroup.children.forEach((c, i) => {
      const m = (c as THREE.LineSegments).material as THREE.LineBasicMaterial;
      m.opacity = 0.45 + 0.5 * (0.5 + 0.5 * Math.sin(performance.now() / 200 + i * 0.3));
    });
    if (state.region) {
      const { a, b } = state.region;
      region.visible = true;
      region.position.set(
        (a.x + b.x + 1) / 2,
        (a.y + b.y + 1) / 2,
        (a.z + b.z + 1) / 2,
      );
      region.scale.set(
        Math.abs(a.x - b.x) + 1,
        Math.abs(a.y - b.y) + 1,
        Math.abs(a.z - b.z) + 1,
      );
    } else region.visible = false;
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
  return {
    reset() {
      camera.position.set(30, 27, 34);
      controls.target.set(0, 2, 0);
    },
    dispose() {
      cancelAnimationFrame(frame);
      resize.disconnect();
      controls.dispose();
      disposeGroup(blocks);
      disposeGroup(fallingGroup);
      disposeGroup(unstableGroup);
      disposeGroup(hazardGroup);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
