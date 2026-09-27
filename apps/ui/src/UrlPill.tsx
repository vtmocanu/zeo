import type { ReactElement } from "react";
import { urlPillLabel } from "@zeo/core";

/** Placeholder shown when the active tab has no displayable location. */
export const URL_PILL_PLACEHOLDER = "Search or enter address";

/**
 * The sidebar's location pill (PRD 10.4 §7.1): the active tab's domain only,
 * never the path, with the full URL in `title`. A click opens the command bar
 * in `navigate` (location) mode; main falls back to `new-tab` when there is no
 * active tab. ⌘L reaches the same mode through `bar.open-location` in main.
 */
export function UrlPill({ url }: { url: string | null }): ReactElement {
  const label = urlPillLabel(url);
  return (
    <button
      type="button"
      className="url-pill"
      data-testid="sidebar-url-pill"
      title={url ?? undefined}
      aria-keyshortcuts="Meta+L"
      onClick={() => void window.zeo?.commandBar.open("navigate").catch(() => {})}
    >
      {label === "" ? (
        <span className="url-pill__label url-pill__label--placeholder">{URL_PILL_PLACEHOLDER}</span>
      ) : (
        <span className="url-pill__label">{label}</span>
      )}
    </button>
  );
}
