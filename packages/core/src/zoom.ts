/**
 * The pure per-site zoom ladder and its state reducers. This module owns the
 * zoom slice that main attaches to the broadcast snapshot: the per-host zoom
 * factors, keyed by the host {@link siteKeyForUrl} derives (see `allowlist.ts`).
 *
 * Everything here is Electron-free and total: the ladder helpers snap any finite
 * input onto {@link ZOOM_FACTORS}, and the reducers treat their input as
 * immutable, each returning a NEW {@link ZoomState} rather than mutating the
 * argument, matching the existing reducers in `packages/core`.
 */

/**
 * The Chromium zoom ladder, ascending: the discrete factors a view may render
 * at. {@link zoomIn} and {@link zoomOut} step between adjacent rungs and every
 * off-ladder input snaps onto this array.
 */
export const ZOOM_FACTORS: readonly number[] = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5,
  3.0, 4.0, 5.0,
];

/**
 * The factor a host renders at when it has no {@link ZoomState.byHost} entry.
 * The default is represented by absence, so {@link setHostZoom} at this factor
 * removes the host key rather than storing it.
 */
export const DEFAULT_ZOOM_FACTOR = 1.0;

/**
 * The per-site zoom slice of the broadcast state: the per-host zoom factors in
 * `byHost`, keyed by the port-less hostname {@link siteKeyForUrl} derives. A
 * host with no entry renders at {@link DEFAULT_ZOOM_FACTOR}, so the default is
 * never stored.
 */
export interface ZoomState {
  byHost: Record<string, number>;
}

/**
 * The next rung strictly ABOVE `factor`, clamped at the top of the ladder
 * (`5.0`). Because {@link ZOOM_FACTORS} is ascending this is the first rung
 * greater than `factor`, which also snaps an off-ladder input UP to the nearest
 * rung above it (e.g. `zoomIn(0.6) === 0.67`, `zoomIn(1.0) === 1.1`,
 * `zoomIn(5.0) === 5.0`, `zoomIn(6.0) === 5.0`). Total for any finite input.
 */
export function zoomIn(factor: number): number {
  return ZOOM_FACTORS.find((rung) => rung > factor) ?? 5.0;
}

/**
 * The next rung strictly BELOW `factor`, clamped at the bottom of the ladder
 * (`0.25`): the largest rung less than `factor`, which also snaps an off-ladder
 * input DOWN to the nearest rung below it (e.g. `zoomOut(0.6) === 0.5`,
 * `zoomOut(1.0) === 0.9`, `zoomOut(0.25) === 0.25`, `zoomOut(6.0) === 5.0`).
 * Total for any finite input.
 */
export function zoomOut(factor: number): number {
  return [...ZOOM_FACTORS].reverse().find((rung) => rung < factor) ?? 0.25;
}

/**
 * `factor` as a rounded whole-percent string (`1.5` → `"150%"`, `0.9` → `"90%"`,
 * `0.33` → `"33%"`), matching the label the sidebar zoom badge shows.
 */
export function formatZoomPercent(factor: number): string {
  return Math.round(factor * 100) + "%";
}

/**
 * Returns a new state with `host`'s factor set to `factor`, EXCEPT that a
 * `factor` of exactly {@link DEFAULT_ZOOM_FACTOR} (`1.0`) removes the `host` key
 * instead of storing the default — so `setHostZoom(state, host, 1.0)` behaves
 * exactly like {@link clearHostZoom}. The input `state` is not mutated.
 */
export function setHostZoom(
  state: ZoomState,
  host: string,
  factor: number,
): ZoomState {
  if (factor === DEFAULT_ZOOM_FACTOR) {
    return clearHostZoom(state, host);
  }
  return { ...state, byHost: { ...state.byHost, [host]: factor } };
}

/**
 * Returns a new state with `host`'s entry removed from `byHost`. Removing an
 * absent key returns a fresh object equal in value to the input. The input
 * `state` is not mutated.
 */
export function clearHostZoom(state: ZoomState, host: string): ZoomState {
  const byHost = { ...state.byHost };
  delete byHost[host];
  return { ...state, byHost };
}
