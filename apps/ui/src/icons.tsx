import type { ReactElement, ReactNode } from "react";

/**
 * The single inline-SVG icon module (design book §5): 16px line icons, 1.5
 * stroke, round caps and joins, drawn in `currentColor`. No icon dependency;
 * later PRDs extend {@link IconName} and {@link ICON_PATHS}.
 */
export type IconName =
  | "sidebar"
  | "back"
  | "forward"
  | "reload"
  | "plus"
  | "close"
  | "download"
  | "archive"
  | "shield"
  | "shield-off"
  | "chevron-down"
  | "arrow"
  | "search"
  | "globe"
  | "grid"
  | "bolt"
  | "history";

const SHIELD_PATH = "M8 2.2 12.8 4v3.7c0 2.8-2 5-4.8 6.1-2.8-1.1-4.8-3.3-4.8-6.1V4z";

const ICON_PATHS: Record<IconName, ReactNode> = {
  sidebar: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2.2" />
      <path d="M6.2 3v10" />
    </>
  ),
  back: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  forward: <path d="M6 3.5 10.5 8 6 12.5" />,
  reload: (
    <>
      <path d="M12.8 8.6A4.9 4.9 0 1 1 11.4 4.3" />
      <path d="M11.8 1.8v2.9H8.9" />
    </>
  ),
  plus: <path d="M8 3.2v9.6M3.2 8h9.6" />,
  close: <path d="m4.6 4.6 6.8 6.8M11.4 4.6l-6.8 6.8" />,
  download: <path d="M8 2.6v7.6M4.8 7.2 8 10.4l3.2-3.2M3 13.2h10" />,
  archive: (
    <>
      <rect x="2.2" y="3" width="11.6" height="3.2" rx="1" />
      <path d="M3.2 6.2v6.3c0 .6.4 1 1 1h7.6c.6 0 1-.4 1-1V6.2M6.4 9h3.2" />
    </>
  ),
  shield: <path d={SHIELD_PATH} />,
  // The shield struck through: blocking is off for this site.
  "shield-off": (
    <>
      <path d={SHIELD_PATH} />
      <path d="m2.4 2.4 11.2 11.2" />
    </>
  ),
  "chevron-down": <path d="m4 6 4 4 4-4" />,
  arrow: <path d="M3 8h10M9.2 4.2 13 8l-3.8 3.8" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.3" />
      <path d="m10.2 10.2 3.3 3.3" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M2.4 8h11.2M8 2.4c1.6 1.6 2.4 3.5 2.4 5.6S9.6 12 8 13.6C6.4 12 5.6 10.1 5.6 8S6.4 4 8 2.4z" />
    </>
  ),
  grid: (
    <>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1.2" />
    </>
  ),
  bolt: <path d="M8.8 2 3.8 9h4l-.8 5 5-7h-4z" />,
  history: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 4.8V8l2.2 1.4" />
    </>
  ),
};

/**
 * Decorative icon: the owning control carries the accessible name. `size`
 * sets the rendered width and height (default 16); the drawing stays on the
 * 16-unit grid (`viewBox="0 0 16 16"`), so smaller sizes scale the strokes.
 */
export function Icon(props: { name: IconName; size?: number }): ReactElement {
  const size = props.size ?? 16;
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[props.name]}
    </svg>
  );
}
