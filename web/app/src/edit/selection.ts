// The Edit tool's selection (W6.7a S3): the keys of the selected objects on one page, in the order
// they were picked. Ctrl+click toggles one object; a rubber band selects by intersection. Keys are
// valid only for the revision they were listed at, so a selection is pruned against a new list.
import type { RectDto } from '../rpc/generated';
import { type Hittable, objectAt, objectsIn, type Point } from './hitTest';

export type Selection = readonly string[];

// Ctrl+click (additive) toggles the object under the point. A plain click selects only it, and a
// click on empty ground clears the selection unless it is additive.
export function clickSelection(
  current: Selection,
  objects: readonly Hittable[],
  point: Point,
  tol: number,
  additive: boolean,
): Selection {
  const hit = objectAt(objects, point, tol);
  if (hit === null) return additive ? current : [];
  if (!additive) return [hit.key];
  return current.includes(hit.key)
    ? current.filter((key) => key !== hit.key)
    : [...current, hit.key];
}

// A rubber band selects every object it meets. Without Ctrl it replaces the selection; with Ctrl it
// adds to it.
export function rubberSelection(
  current: Selection,
  objects: readonly Hittable[],
  box: RectDto,
  additive: boolean,
): Selection {
  const keys = objectsIn(objects, box).map((o) => o.key);
  if (!additive) return keys;
  const merged = [...current];
  for (const key of keys) if (!merged.includes(key)) merged.push(key);
  return merged;
}

// The selection with the keys that the list no longer holds removed, as after a revision change.
export function pruneSelection(current: Selection, objects: readonly Hittable[]): Selection {
  const present = new Set(objects.map((o) => o.key));
  return current.filter((key) => present.has(key));
}
