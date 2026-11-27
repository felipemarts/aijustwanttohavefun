/**
 * Layout of the village project tree (what unlocks what): one column per depth (the longest chain of requirements
 * leading to the project), rows ordered to keep children next to their parents. Pure.
 */

export type TreeInput = { id: string; requires: readonly string[] };
export type TreeNode<T extends TreeInput = TreeInput> = { item: T; col: number; row: number };
export type TreeEdge = { from: string; to: string };
export type TreeLayout<T extends TreeInput = TreeInput> = {
  nodes: TreeNode<T>[];
  edges: TreeEdge[];
  cols: number;
  rows: number;
};

export function layoutProjectTree<T extends TreeInput>(items: readonly T[]): TreeLayout<T> {
  const byId = new Map(items.map((p) => [p.id, p]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // a cycle in bad data: break it
    visiting.add(id);
    const p = byId.get(id);
    let d = 0;
    for (const r of p?.requires ?? []) if (byId.has(r) && r !== id) d = Math.max(d, depthOf(r) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const p of items) depthOf(p.id);

  const cols = items.length ? Math.max(...items.map((p) => depth.get(p.id)!)) + 1 : 0;
  const rowOf = new Map<string, number>();
  const order = new Map(items.map((p, i) => [p.id, i]));
  let rows = 0;
  for (let c = 0; c < cols; c++) {
    const col = items.filter((p) => depth.get(p.id) === c);
    // Barycentre of the parents' rows; roots keep the input (content) order.
    const key = (p: T) => {
      const parents = p.requires.filter((r) => rowOf.has(r));
      return parents.length ? parents.reduce((s, r) => s + rowOf.get(r)!, 0) / parents.length : order.get(p.id)!;
    };
    col.sort((a, b) => key(a) - key(b) || order.get(a.id)! - order.get(b.id)!);
    let next = 0;
    for (const p of col) {
      // Try to sit level with the parents, never above an already placed sibling.
      const want = c === 0 ? next : Math.max(next, Math.round(key(p)));
      rowOf.set(p.id, want);
      next = want + 1;
    }
    rows = Math.max(rows, next);
  }
  const nodes = items.map((item) => ({ item, col: depth.get(item.id)!, row: rowOf.get(item.id)! }));
  const edges: TreeEdge[] = [];
  for (const p of items) for (const r of p.requires) if (byId.has(r) && r !== p.id) edges.push({ from: r, to: p.id });
  return { nodes, edges, cols, rows };
}
