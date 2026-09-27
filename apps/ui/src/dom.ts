/** Finds a `space-item` button by space id, or `null` when it isn't rendered. */
export function findSpaceItem(spaceId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-testid="space-item"][data-space-id="${CSS.escape(spaceId)}"]`,
  );
}
