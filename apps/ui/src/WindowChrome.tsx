import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import type { ChromeState, CommandId, PaneSide, Rect, WindowLayout } from "@zeo/core";
import {
  SIDEBAR_HIDE_DELAY_MS,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_REVEAL_EDGE,
  clampSidebarWidth,
  contentRect,
  splitPaneBounds,
} from "@zeo/core";
import { Icon, type IconName } from "./icons.js";

/**
 * Frameless window chrome for the main sidebar surface (PRD 10.2 §6). The
 * sidebar's webContents fills the window beneath every native page view, so it
 * paints the window ground, the card each page floats in and the drag strip,
 * and hosts the window row and the resize handle. Geometry comes from
 * `@zeo/core` (the same formulas main uses for the native view bounds); state
 * changes go through `window.zeo.chrome` and come back on the broadcast.
 */

/** Keyboard step, in px, for the focused resize handle. */
const RESIZE_KEY_STEP = 10;

/** The live viewport size, updated on `resize`. */
export function useWindowSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const onResize = (): void => {
      setSize({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/** One card to draw: its geometry and, in split view, the pane it backs. */
export interface WindowCard {
  pane: PaneSide | null;
  rect: Rect;
}

/**
 * The cards beneath the native views: one at {@link contentRect} in single
 * mode, or the left and right panes of {@link splitPaneBounds} in split mode
 * (the divider's 8px gap between them stays window ground).
 */
export function windowCards(
  width: number,
  height: number,
  chrome: ChromeState,
  layout: WindowLayout,
): WindowCard[] {
  if (layout.mode === "split") {
    const { left, right } = splitPaneBounds(width, height, chrome, layout.ratio);
    return [
      { pane: "left", rect: left },
      { pane: "right", rect: right },
    ];
  }
  return [{ pane: null, rect: contentRect(width, height, chrome) }];
}

function rectStyle(rect: Rect): CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

/** Window ground, card(s) and top drag strip, rendered before the sidebar. */
export function WindowBackdrop(props: { chrome: ChromeState; layout: WindowLayout }): ReactElement {
  const { width, height } = useWindowSize();
  const cards = windowCards(width, height, props.chrome, props.layout);
  return (
    <>
      <div className="window-tint" data-testid="window-tint" aria-hidden="true" />
      {cards.map((card) => (
        <div
          key={card.pane ?? "single"}
          className="window-card"
          data-testid="window-card"
          data-pane={card.pane ?? undefined}
          aria-hidden="true"
          style={rectStyle(card.rect)}
        />
      ))}
      <div className="window-drag-strip" data-testid="window-drag-strip" aria-hidden="true" />
    </>
  );
}

interface WindowRowButton {
  testId: string;
  label: string;
  icon: IconName;
  command: CommandId;
}

const WINDOW_ROW_BUTTONS: readonly WindowRowButton[] = [
  {
    testId: "sidebar-toggle",
    label: "Toggle sidebar",
    icon: "sidebar",
    command: "view.toggleSidebar",
  },
  { testId: "nav-back", label: "Back", icon: "back", command: "tab.back" },
  { testId: "nav-forward", label: "Forward", icon: "forward", command: "tab.forward" },
  { testId: "nav-reload", label: "Reload", icon: "reload", command: "tab.reload" },
];

/**
 * The 44px drag row atop the sidebar: the native traffic lights sit in its
 * left padding, the four icon buttons are right-aligned. The sidebar has no
 * navigation flags, so the buttons stay enabled and a disabled command is a
 * silent no-op in main.
 */
export function WindowRow(): ReactElement {
  return (
    <div className="window-row" data-testid="window-row">
      <div className="window-row__actions">
        {WINDOW_ROW_BUTTONS.map((button) => (
          <button
            key={button.testId}
            type="button"
            className="icon-button"
            data-testid={button.testId}
            aria-label={button.label}
            title={button.label}
            onClick={() => void window.zeo?.commands.run(button.command).catch(() => {})}
          >
            <Icon name={button.icon} />
          </button>
        ))}
      </div>
    </div>
  );
}

function sendSidebarWidth(px: number): void {
  void window.zeo?.chrome.setSidebarWidth(clampSidebarWidth(px)).catch(() => {});
}

interface ResizeDrag {
  pointerId: number;
  startX: number;
  startWidth: number;
}

/**
 * The sidebar's right-edge resize strip. A pointer drag sends the clamped
 * width at most once per animation frame (the last value is flushed on
 * release); ArrowLeft/ArrowRight step {@link RESIZE_KEY_STEP}px while focused.
 * Main clamps again and broadcasts the result, which flows back as `width`.
 */
export function SidebarResizeHandle(props: { width: number }): ReactElement {
  const { width } = props;
  const dragRef = useRef<ResizeDrag | null>(null);
  const pendingRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  // The width the last arrow key asked for, until the broadcast catches up.
  // Auto-repeat can fire faster than the round trip through main, and stepping
  // from the stale `width` prop would resend the same value.
  const keyTargetRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (keyTargetRef.current === width) {
      keyTargetRef.current = null;
    }
  }, [width]);

  const flush = (): void => {
    frameRef.current = null;
    const next = pendingRef.current;
    pendingRef.current = null;
    if (next !== null) {
      sendSidebarWidth(next);
    }
  };

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    },
    [],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    keyTargetRef.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) {
      return;
    }
    pendingRef.current = clampSidebarWidth(drag.startWidth + event.clientX - drag.startX);
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(flush);
    }
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      flush();
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step =
      event.key === "ArrowLeft"
        ? -RESIZE_KEY_STEP
        : event.key === "ArrowRight"
          ? RESIZE_KEY_STEP
          : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const from = keyTargetRef.current ?? width;
    const next = clampSidebarWidth(from + step);
    if (next === from) {
      return;
    }
    keyTargetRef.current = next;
    sendSidebarWidth(next);
  };

  return (
    <div
      className={`sidebar__resize-handle${dragging ? " sidebar__resize-handle--dragging" : ""}`}
      data-testid="sidebar-resize-handle"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
      onBlur={() => {
        keyTargetRef.current = null;
      }}
    />
  );
}

/** The slice of `window.zeo.chrome` the edge reveal drives. */
export interface SidebarRevealApi {
  setSidebarRevealed(revealed: boolean): Promise<void>;
}

/** The chrome fields the edge reveal reacts to. */
export type SidebarRevealState = Pick<
  ChromeState,
  "sidebarCollapsed" | "sidebarRevealed" | "sidebarWidth"
>;

/**
 * The edge-reveal state machine behind {@link useSidebarReveal}, kept free of
 * React and the DOM so its timing is testable with fake timers. It owns the
 * hide timer across state updates: a width change (or any other broadcast)
 * while a hide is pending leaves the timer running, so the sidebar still hides
 * {@link SIDEBAR_HIDE_DELAY_MS} after the pointer left. The timer is dropped
 * only when the sidebar stops being revealed (hidden, or un-collapsed), when
 * the pointer comes back over it, or on {@link dispose}.
 */
export class SidebarRevealController {
  private state: SidebarRevealState = {
    sidebarCollapsed: false,
    sidebarRevealed: false,
    sidebarWidth: 0,
  };
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  // Set once a reveal is in flight so a burst of edge moves sends one call;
  // cleared when the pointer leaves the edge (or the reveal state flips) so a
  // later touch retries.
  private revealRequested = false;

  constructor(private readonly api: () => SidebarRevealApi | undefined) {}

  /** Adopt the latest broadcast chrome state. */
  update(next: SidebarRevealState): void {
    if (next.sidebarRevealed !== this.state.sidebarRevealed) {
      this.revealRequested = false;
    }
    this.state = { ...next };
    if (!next.sidebarCollapsed || !next.sidebarRevealed) {
      this.cancelHide();
    }
    if (!next.sidebarCollapsed) {
      this.revealRequested = false;
    }
  }

  /** A pointer move anywhere in the document, at viewport x `clientX`. */
  pointerMove(clientX: number): void {
    const { sidebarCollapsed, sidebarRevealed, sidebarWidth } = this.state;
    if (!sidebarCollapsed) {
      return;
    }
    if (!sidebarRevealed) {
      if (clientX >= SIDEBAR_REVEAL_EDGE) {
        this.revealRequested = false;
      } else if (!this.revealRequested) {
        this.revealRequested = true;
        void this.api()?.setSidebarRevealed(true).catch(() => {});
      }
      return;
    }
    if (clientX >= sidebarWidth) {
      this.scheduleHide();
    } else {
      this.cancelHide();
    }
  }

  /** The pointer left the document. */
  pointerLeave(): void {
    if (this.state.sidebarCollapsed && this.state.sidebarRevealed) {
      this.scheduleHide();
    }
  }

  /** Whether a hide is pending. */
  get hidePending(): boolean {
    return this.hideTimer !== null;
  }

  /** Drop any pending hide; call on unmount. */
  dispose(): void {
    this.cancelHide();
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  private scheduleHide(): void {
    if (this.hideTimer !== null) {
      return;
    }
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      void this.api()?.setSidebarRevealed(false).catch(() => {});
    }, SIDEBAR_HIDE_DELAY_MS);
  }
}

/**
 * Edge reveal for a collapsed sidebar. Touching the left
 * {@link SIDEBAR_REVEAL_EDGE}px reveals it; while revealed, leaving the
 * document or moving right of the sidebar starts a {@link SIDEBAR_HIDE_DELAY_MS}
 * timer that hides it again, and moving back over the sidebar cancels it.
 * Inactive (no listeners, no timers) while the sidebar is not collapsed. The
 * timing lives in a {@link SidebarRevealController} held for the component's
 * lifetime, so a broadcast mid-delay does not reset or drop the hide timer.
 */
export function useSidebarReveal(chrome: ChromeState): void {
  const { sidebarCollapsed, sidebarRevealed, sidebarWidth } = chrome;
  const [controller] = useState(() => new SidebarRevealController(() => window.zeo?.chrome));

  useEffect(() => {
    controller.update({ sidebarCollapsed, sidebarRevealed, sidebarWidth });
  }, [controller, sidebarCollapsed, sidebarRevealed, sidebarWidth]);

  useEffect(() => {
    if (!sidebarCollapsed || !window.zeo?.chrome) {
      return;
    }
    const onPointerMove = (event: PointerEvent): void => controller.pointerMove(event.clientX);
    const onPointerLeave = (): void => controller.pointerLeave();
    const root = document.documentElement;
    document.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerleave", onPointerLeave);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [controller, sidebarCollapsed]);

  useEffect(() => () => controller.dispose(), [controller]);
}
