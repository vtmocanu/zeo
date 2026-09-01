import type { Space } from "./space.js";

/** The default name for a newly created space: "Space N", where N is the smallest
 *  integer greater than the current space count whose "Space N" name is not already
 *  taken — so it never collides with an existing space, even after deletions.
 *  Shared by the renderer (inline-create prefill) and the main process (the
 *  Cmd+Shift+N accelerator) so both creation paths agree on the name. */
export function defaultSpaceName(spaces: Space[]): string {
  const used = new Set(spaces.map((s) => s.name));
  let n = spaces.length + 1;
  while (used.has(`Space ${n}`)) {
    n += 1;
  }
  return `Space ${n}`;
}
