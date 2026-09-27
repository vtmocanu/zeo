/**
 * Pure helpers for the in-app confirmation dialog (PRD 10.6 §3), kept free of
 * React and the DOM so they are unit-testable.
 */

/**
 * The index focus moves to when Tab (or Shift+Tab when `backwards`) is pressed
 * while the control at `current` is focused, cycling through `count` controls
 * and wrapping both ways. A `current` outside the range (focus is not on any
 * of the controls) enters at the first control going forwards and at the last
 * going backwards. `count <= 0` yields -1: there is nothing to focus.
 */
export function nextFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) {
    return -1;
  }
  if (current < 0 || current >= count) {
    return backwards ? count - 1 : 0;
  }
  return (current + (backwards ? count - 1 : 1)) % count;
}
