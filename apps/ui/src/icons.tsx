import type { ReactElement, ReactNode } from "react";

/**
 * The single inline-SVG icon module (design book §5): 16px line icons, 1.5
 * stroke, round caps and joins, drawn in `currentColor`. No icon dependency;
 * later PRDs extend {@link IconName} and {@link ICON_PATHS}.
 */
export type IconName = "sidebar" | "back" | "forward" | "reload";

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
};

/** Decorative icon: the owning control carries the accessible name. */
export function Icon(props: { name: IconName }): ReactElement {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
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
