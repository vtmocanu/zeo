/**
 * Motion constants and space-switch detection (PRD 10.7 §1, design book §7).
 *
 * Pure: no DOM, no Electron, no `node:*` imports, so it can be shared by the
 * main process, the renderers and `apps/ui`.
 */

export const MOTION_FAST_MS = 120;
export const MOTION_BASE_MS = 200;
export const MOTION_SPACE_MS = 320;
export const MOTION_REDUCED_MS = 120;
export const EASE_STANDARD = "cubic-bezier(.2, .8, .2, 1)";
export const ENTER_SCALE_FROM = 0.97;
export const SPACE_SHIFT_PX = 28;
export const PRESS_SCALE = 0.96;

export type SpaceSwitchDirection = "forward" | "backward";

export interface SpaceSwitch {
  from: string;
  to: string;
  direction: SpaceSwitchDirection | null;
}

/**
 * Detects a space switch between two `activeSpaceId` broadcasts.
 *
 * Returns `null` when there is nothing to animate: the previous id is `""`
 * (the renderer's state before the first broadcast), the two ids are equal,
 * or the next id is not in `spaceIds`. Otherwise the direction is
 * `"forward"` when the next space's index in `spaceIds` is greater than the
 * previous one's, `"backward"` when it is smaller, and `null` when the
 * previous id is no longer listed (the active space was deleted).
 */
export function detectSpaceSwitch(
  previousActiveId: string,
  nextActiveId: string,
  spaceIds: readonly string[],
): SpaceSwitch | null {
  if (previousActiveId === "") return null;
  if (previousActiveId === nextActiveId) return null;
  const nextIndex = spaceIds.indexOf(nextActiveId);
  if (nextIndex === -1) return null;
  const previousIndex = spaceIds.indexOf(previousActiveId);
  const direction: SpaceSwitchDirection | null =
    previousIndex === -1 ? null : nextIndex > previousIndex ? "forward" : "backward";
  return { from: previousActiveId, to: nextActiveId, direction };
}
