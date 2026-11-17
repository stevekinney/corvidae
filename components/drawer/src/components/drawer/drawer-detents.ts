import type { DrawerDetent } from './drawer.types.ts';

/** Every detent, smallest first. */
export const DRAWER_DETENT_ORDER: readonly DrawerDetent[] = ['peek', 'medium', 'large'];

/** The share of the viewport `medium` takes. drawer.css gives the same `50dvh`. */
export const MEDIUM_DETENT_RATIO = 0.5;

/** The share of the viewport `large` takes: the sheet's 90dvh cap in drawer.css. */
export const LARGE_DETENT_RATIO = 0.9;

/**
 * About how tall the `peek` bar is, in pixels: the 20px grabber band plus the 56px bar. drawer.css
 * owns the real height (`--_cinder-drawer-peek-height`, which adds the bottom safe area), so this
 * only places `peek` among the other detents while a drag decides which one to snap to.
 */
export const PEEK_DETENT_HEIGHT = 76;

/**
 * How far, in pixels, a pointer may move between pressing and releasing the grabber and still be a
 * tap rather than a drag.
 */
export const DRAG_TAP_DISTANCE = 6;

/** The detents a drawer was given, without duplicates, smallest first. */
export function normalizeDetents(detents: readonly DrawerDetent[] | undefined): DrawerDetent[] {
  if (detents === undefined) return [];
  return DRAWER_DETENT_ORDER.filter((detent) => detents.includes(detent));
}

/** The detent a sheet rests at: the requested one when it is listed, otherwise the smallest. */
export function resolveDetent(
  detents: readonly DrawerDetent[],
  requested: DrawerDetent | undefined,
): DrawerDetent | undefined {
  if (requested !== undefined && detents.includes(requested)) return requested;
  return detents[0];
}

/** How tall a detent is, in pixels, in a viewport of this height. */
export function detentHeight(detent: DrawerDetent, viewportHeight: number): number {
  if (detent === 'peek') return PEEK_DETENT_HEIGHT;
  if (detent === 'medium') return viewportHeight * MEDIUM_DETENT_RATIO;
  return viewportHeight * LARGE_DETENT_RATIO;
}

/** The listed detent whose height is closest to `height`. */
export function nearestDetent(
  detents: readonly DrawerDetent[],
  height: number,
  viewportHeight: number,
): DrawerDetent {
  let nearest = detents[0] ?? 'large';
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const detent of detents) {
    const distance = Math.abs(detentHeight(detent, viewportHeight) - height);
    if (distance < nearestDistance) {
      nearest = detent;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/**
 * The detent one step away from `current` towards larger (`1`) or smaller (`-1`), stopping at the
 * ends: ArrowUp on the largest detent stays on it.
 */
export function stepDetent(
  detents: readonly DrawerDetent[],
  current: DrawerDetent,
  direction: 1 | -1,
): DrawerDetent {
  const index = detents.indexOf(current);
  const next = Math.min(Math.max(index + direction, 0), detents.length - 1);
  return detents[next] ?? current;
}

/** The next larger detent, or the smallest when `current` is already the largest: a tap. */
export function cycleDetent(detents: readonly DrawerDetent[], current: DrawerDetent): DrawerDetent {
  const index = detents.indexOf(current);
  return detents[index + 1] ?? detents[0] ?? current;
}

/** A dragged height held between the smallest and largest detents. */
export function clampDragHeight(
  detents: readonly DrawerDetent[],
  height: number,
  viewportHeight: number,
): number {
  const smallest = detents[0];
  const largest = detents.at(-1);
  if (smallest === undefined || largest === undefined) return height;
  return Math.min(
    Math.max(height, detentHeight(smallest, viewportHeight)),
    detentHeight(largest, viewportHeight),
  );
}
