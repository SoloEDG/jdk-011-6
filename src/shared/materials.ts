import type { MaterialId } from "./document";
export interface MaterialSpec {
  id: MaterialId;
  name: string;
  color: string;
  solid: boolean;
  opacity: number;
  /** How many blocks a block can span sideways without support below it. */
  span: number;
  /** Relative downward force this material applies to its supports. */
  weight: number;
  /** Load (in weight units) one block can carry before it gives way. */
  capacity: number;
  /** Short structural description used in the UI. */
  structure: string;
}
export const materials: MaterialSpec[] = [
  {
    id: "grass",
    name: "草方块",
    color: "#78a44b",
    solid: true,
    opacity: 1,
    span: 1,
    weight: 1,
    capacity: 30,
    structure: "松软表层，几乎不能悬挑",
  },
  {
    id: "soil",
    name: "泥土",
    color: "#96704f",
    solid: true,
    opacity: 1,
    span: 1,
    weight: 1.2,
    capacity: 36,
    structure: "沉重且松散，纵向承重有限",
  },
  {
    id: "stone",
    name: "岩石",
    color: "#99a4a5",
    solid: true,
    opacity: 1,
    span: 1,
    weight: 1.6,
    capacity: 60,
    structure: "沉重但极耐压，适合做基础",
  },
  {
    id: "wood",
    name: "橡木",
    color: "#b58a55",
    solid: true,
    opacity: 1,
    span: 4,
    weight: 0.7,
    capacity: 45,
    structure: "木梁可悬挑四格，也宜做支柱",
  },
  {
    id: "sand",
    name: "沙地",
    color: "#e3ce95",
    solid: true,
    opacity: 1,
    span: 0,
    weight: 1,
    capacity: 12,
    structure: "松散沙粒，悬挑即塌",
  },
  {
    id: "brick",
    name: "砖块",
    color: "#bd735c",
    solid: true,
    opacity: 1,
    span: 1,
    weight: 1.3,
    capacity: 50,
    structure: "承重墙材，适合拱与柱",
  },
  {
    id: "glass",
    name: "玻璃",
    color: "#a4dce0",
    solid: true,
    opacity: 0.38,
    span: 1,
    weight: 0.8,
    capacity: 18,
    structure: "轻而脆，避免承受集中载荷",
  },
  {
    id: "leaf",
    name: "树叶",
    color: "#4d8650",
    solid: true,
    opacity: 1,
    span: 3,
    weight: 0.35,
    capacity: 30,
    structure: "极轻，可大片悬挑成冠",
  },
];
export const materialSpec = (id: MaterialId) =>
  materials.find((m) => m.id === id)!;
export const initialStock = () =>
  Object.fromEntries(materials.map((m) => [m.id, 256])) as Record<
    MaterialId,
    number
  >;
