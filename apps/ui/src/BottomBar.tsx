import {
  useEffect,
  useRef,
  type CSSProperties,
  type MouseEventHandler,
  type ReactElement,
} from "react";
import type { Download, Space } from "@zeo/core";
import { SPACE_ACTIVATE_DELAY_MS, spaceDotColor } from "@zeo/core";
import { findSpaceItem } from "./dom.js";
import { Icon } from "./icons.js";

export type SpaceEdit =
  | { mode: "create" }
  | { mode: "rename"; spaceId: string }
  | { mode: "new-profile"; spaceId: string };

/** The accessible name of the space-name input for each edit mode. */
export function spaceEditLabel(edit: SpaceEdit): string {
  switch (edit.mode) {
    case "create":
      return "New space name";
    case "rename":
      return "Rename space";
    case "new-profile":
      return "New profile name";
  }
}

export function SpaceNameInput({
  label,
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <input
      type="text"
      className="space-name-input"
      data-testid="space-name-input"
      aria-label={label}
      autoFocus
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCancel()}
    />
  );
}

/**
 * The space name editor panel above the bottom bar (PRD 10.4 §7.7): one place
 * for create, rename and new-profile, so the switcher's dots never move while
 * a name is being typed.
 */
export function SpaceNameEditor(props: {
  edit: SpaceEdit;
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <div className="space-name-editor">
      <SpaceNameInput
        label={spaceEditLabel(props.edit)}
        value={props.value}
        onChange={props.onChange}
        onCommit={props.onCommit}
        onCancel={props.onCancel}
      />
    </div>
  );
}

/**
 * A single space in the switcher: a 28px dot button. A plain click activates
 * the space, but the activation is deferred by {@link SPACE_ACTIVATE_DELAY_MS}
 * so a double-click (which opens the rename editor) never also switches
 * spaces: the second click and `onDoubleClick` both clear the pending timer
 * first (PRD 9.4 §6). The timer is per-item and cleared on unmount. The name
 * lives in a visually hidden span (the accessible name and the text e2e reads)
 * and in `title`.
 */
export function SpaceItem({
  space,
  isActive,
  onActivate,
  onRename,
  onContextMenu,
}: {
  space: Space;
  isActive: boolean;
  onActivate: () => void;
  onRename: () => void;
  onContextMenu: MouseEventHandler<HTMLButtonElement>;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clear, []);
  return (
    <button
      type="button"
      className={`space-item${isActive ? " space-item--active" : ""}`}
      data-testid="space-item"
      data-space-id={space.id}
      aria-current={isActive ? "true" : undefined}
      title={space.name}
      onClick={(event) => {
        if (event.detail > 1) {
          clear();
          return;
        }
        clear();
        timer.current = setTimeout(() => {
          timer.current = null;
          onActivate();
        }, SPACE_ACTIVATE_DELAY_MS);
      }}
      onDoubleClick={() => {
        clear();
        onRename();
      }}
      onContextMenu={onContextMenu}
    >
      <span
        className="space-item__dot"
        data-testid="space-dot"
        data-hue={space.theme === null ? "none" : space.theme.stops.join("+")}
        aria-hidden="true"
        style={{ "--space-dot": spaceDotColor(space.theme) ?? undefined } as CSSProperties}
      />
      <span className="space-item__name visually-hidden">{space.name}</span>
    </button>
  );
}

/** Aggregate view of the download list the indicator draws from. */
export interface DownloadsSummary {
  /** Progressing or paused downloads. */
  active: number;
  /** Every download in the list, finished ones included. */
  total: number;
  /** No active download reports a total size. */
  indeterminate: boolean;
  /** sum(received) / sum(total) over active downloads, 0..100. */
  percent: number;
  /** "Downloading 2 · 40%", "Downloading 2…", "Downloads (3)" or "Downloads". */
  label: string;
}

/**
 * Summarises the broadcast `downloads` slice (no forked state). "Active" is
 * progressing-or-paused; aggregate progress is sum(receivedBytes) /
 * sum(totalBytes) across active downloads. When every active download has an
 * unknown total (totalBytes 0) the sum is 0 and the indicator goes
 * indeterminate; the percentage is clamped to 100 since an unknown-total item
 * can still contribute received bytes.
 */
export function summarizeDownloads(items: readonly Download[]): DownloadsSummary {
  const active = items.filter((d) => d.state === "progressing" || d.state === "paused");
  const received = active.reduce((sum, d) => sum + d.receivedBytes, 0);
  const totalBytes = active.reduce((sum, d) => sum + d.totalBytes, 0);
  const indeterminate = totalBytes === 0;
  const percent = totalBytes > 0 ? Math.min(100, Math.round((received / totalBytes) * 100)) : 0;
  const label =
    active.length > 0
      ? indeterminate
        ? `Downloading ${active.length}…`
        : `Downloading ${active.length} · ${percent}%`
      : items.length > 0
        ? `Downloads (${items.length})`
        : "Downloads";
  return { active: active.length, total: items.length, indeterminate, percent, label };
}

/**
 * The 2px progress ring around the downloads button while downloads are
 * active: the accent arc runs to `percent`, or a static quarter arc when the
 * total is unknown. Geometry lives in SVG attributes (`pathLength` 100), so
 * no inline style carries a computed value.
 */
function ProgressRing({ percent, indeterminate }: { percent: number; indeterminate: boolean }) {
  const arc = indeterminate ? 25 : percent;
  return (
    <svg
      className={`progress-ring${indeterminate ? " progress-ring--indeterminate" : ""}`}
      viewBox="0 0 28 28"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="progress-ring__track" cx="14" cy="14" r="12" pathLength={100} />
      <circle
        className="progress-ring__arc"
        cx="14"
        cy="14"
        r="12"
        pathLength={100}
        strokeDasharray={`${arc} 100`}
        transform="rotate(-90 14 14)"
      />
    </svg>
  );
}

/** The id of the archived panel the archived toggle controls. */
export const ARCHIVED_VIEW_ID = "archived-view";

/**
 * The strip `scrollLeft` that brings `[itemStart, itemEnd)` (content
 * coordinates) fully into a `viewport`-wide window with "nearest" semantics:
 * unchanged when already visible, otherwise the smallest scroll that reveals
 * it, aligning the leading edge when the item is wider than the viewport.
 */
export function nearestScrollLeft(
  scrollLeft: number,
  viewport: number,
  itemStart: number,
  itemEnd: number,
): number {
  if (itemStart < scrollLeft || itemEnd - itemStart > viewport) {
    return itemStart;
  }
  if (itemEnd > scrollLeft + viewport) {
    return itemEnd - viewport;
  }
  return scrollLeft;
}

/**
 * The sidebar's bottom bar (PRD 10.4 §7.8): downloads and archived on the
 * left, one dot per space in the centre, new space on the right. Every button
 * is a 28px icon button whose text lives in a visually hidden span and `title`.
 */
export function BottomBar({
  spaces,
  activeSpaceId,
  downloads,
  archivedCount,
  archivedOpen,
  onToggleArchived,
  onRenameSpace,
  onNewSpace,
}: {
  spaces: readonly Space[];
  activeSpaceId: string;
  downloads: readonly Download[];
  archivedCount: number;
  archivedOpen: boolean;
  onToggleArchived: () => void;
  onRenameSpace: (space: Space) => void;
  onNewSpace: () => void;
}): ReactElement {
  const summary = summarizeDownloads(downloads);
  const archivedLabel = `Archived (${archivedCount})`;

  // Keep the active dot in view when the strip overflows. Only the strip
  // scrolls: `scrollIntoView` would also nudge overflow-hidden ancestors such
  // as `.sidebar`.
  const switcherRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const strip = switcherRef.current;
    const item = findSpaceItem(activeSpaceId);
    if (strip === null || item === null || !strip.contains(item)) {
      return;
    }
    const stripRect = strip.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const origin = stripRect.left + strip.clientLeft - strip.scrollLeft;
    const next = nearestScrollLeft(
      strip.scrollLeft,
      strip.clientWidth,
      itemRect.left - origin,
      itemRect.right - origin,
    );
    if (next !== strip.scrollLeft) {
      strip.scrollLeft = next;
    }
  }, [activeSpaceId]);

  return (
    <footer className="sidebar__footer bottom-bar">
      <div className="bottom-bar__group">
        <button
          type="button"
          className={`icon-button bottom-bar__button downloads-indicator${
            summary.active > 0 ? " downloads-indicator--active" : ""
          }`}
          data-testid="downloads-indicator"
          title={summary.label}
          onClick={() => void window.zeo?.commands.run("downloads.open").catch(() => {})}
        >
          {summary.active > 0 ? (
            <ProgressRing percent={summary.percent} indeterminate={summary.indeterminate} />
          ) : null}
          <Icon name="download" />
          <span className="visually-hidden">{summary.label}</span>
        </button>
        <button
          type="button"
          className="icon-button bottom-bar__button"
          data-testid="archived-toggle"
          aria-expanded={archivedOpen}
          aria-controls={archivedOpen ? ARCHIVED_VIEW_ID : undefined}
          title={archivedLabel}
          onClick={onToggleArchived}
        >
          <Icon name="archive" />
          <span className="visually-hidden">{archivedLabel}</span>
        </button>
      </div>

      <nav ref={switcherRef} className="space-switcher" data-testid="space-switcher" aria-label="Spaces">
        {spaces.map((space) => (
          <SpaceItem
            key={space.id}
            space={space}
            isActive={space.id === activeSpaceId}
            onActivate={() => void window.zeo?.spaces.activate(space.id).catch(() => {})}
            onRename={() => onRenameSpace(space)}
            onContextMenu={(event) => {
              event.preventDefault();
              void window.zeo?.spaces
                .showContextMenu(space.id, event.clientX, event.clientY)
                .then((result) => {
                  (
                    globalThis as { __zeoLastSpaceContextMenu?: unknown }
                  ).__zeoLastSpaceContextMenu = result;
                })
                .catch(() => {});
            }}
          />
        ))}
      </nav>

      <div className="bottom-bar__group">
        <button
          type="button"
          className="icon-button bottom-bar__button"
          data-testid="new-space-button"
          aria-label="New space"
          title="New space"
          onClick={onNewSpace}
        >
          <Icon name="plus" />
        </button>
      </div>
    </footer>
  );
}
