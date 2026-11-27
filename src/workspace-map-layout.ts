export type Point = { x: number; y: number };

export const TEAM_SPACING = 560;
// Two task roots closer than this would overlap their rings.
const MIN_TEAM_GAP = TEAM_SPACING * 0.75;

// Default team slots: the center, then hexagonal rings around it.
export function teamCenters(count: number): Point[] {
  const centers = [{ x: 0, y: 0 }];
  const directions = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  for (let ring = 1; centers.length < count; ring++) {
    let q = -ring;
    let r = ring;
    for (const [dq, dr] of directions) {
      for (let step = 0; step < ring && centers.length < count; step++) {
        centers.push({ x: TEAM_SPACING * (q + r / 2), y: TEAM_SPACING * Math.sqrt(3) / 2 * r });
        q += dq;
        r += dr;
      }
    }
  }
  return centers;
}

// Keeps every root that already has a position where it is, and gives each new root the first
// default slot that does not overlap a placed root. Placement never depends on root order.
export function placeRoots(rootIds: string[], known: ReadonlyMap<string, Point>): Map<string, Point> {
  const placed = new Map<string, Point>();
  for (const id of rootIds) {
    const point = known.get(id);
    if (point) placed.set(id, point);
  }
  const missing = rootIds.filter((id) => !placed.has(id));
  if (!missing.length) return placed;
  const occupied = [...placed.values()];
  const slots = teamCenters(rootIds.length + occupied.length * 4 + 1);
  let next = 0;
  for (const id of missing) {
    while (next < slots.length - 1 && occupied.some((point) =>
      Math.hypot(point.x - slots[next].x, point.y - slots[next].y) < MIN_TEAM_GAP)) next++;
    const slot = slots[next++] ?? { x: TEAM_SPACING * (occupied.length + 1), y: 0 };
    placed.set(id, slot);
    occupied.push(slot);
  }
  return placed;
}

// Stable per-root orientation for its children, independent of how many roots exist.
export function rootAngle(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return hash & 1 ? Math.PI / 7 : -Math.PI / 3;
}
