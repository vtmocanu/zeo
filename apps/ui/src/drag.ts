// Pointer travel (px) required before a press turns into a drag. Below this a
// press stays a plain click, so click-to-activate / click-to-close keep working.
// Shared by the tab-row and favorite-tile drags.
export const DRAG_THRESHOLD = 5;

/**
 * Swallows the click the browser fires on pointer release after a real drag,
 * so the row or tile under the pointer is not also activated or closed.
 */
export function suppressNextClick(): void {
  const suppress = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    document.removeEventListener("click", suppress, true);
  };
  document.addEventListener("click", suppress, true);
  window.setTimeout(() => {
    document.removeEventListener("click", suppress, true);
  }, 0);
}
