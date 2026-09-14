import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { clampRatio } from "@zeo/core";
import "./App.css";

/**
 * The draggable divider (gutter) between the two split panes, mounted in its own
 * full-viewport WebContentsView (selected by `?view=divider` in
 * {@link "./main.js"}). Main positions and sizes this view between the panes;
 * this renderer only translates a horizontal pointer drag into a new left-pane
 * ratio and pushes it through the `window.zeo` bridge. No business logic lives
 * here — the layout state is owned by main.
 *
 * It seeds its geometry two ways (mirroring {@link "./CommandBar.js"}'s
 * `onCommandBarChange` + `commandBar.state()` pairing): it subscribes to
 * `onDividerLayout` for main's pushes AND fetches `dividerGeometry()` once on
 * mount, so it renders correct geometry even if the subscribe lands after main's
 * initial push.
 *
 * Drag state lives in refs so the `pointermove` handler reads the latest
 * `dividableWidth` and the ratio captured at press without stale closures.
 */
export function Divider() {
  const [ratio, setRatio] = useState(0.5);
  const [dividableWidth, setDividableWidth] = useState(0);

  // Mirror state into refs so the pointer handlers always read the latest values.
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;
  const widthRef = useRef(dividableWidth);
  widthRef.current = dividableWidth;

  // Mutable drag session: whether a drag is active, and the pointer x / ratio
  // captured at press.
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startRatioRef = useRef(0.5);

  useEffect(() => {
    // Guard so a bare browser dev-open (no bridge) doesn't throw. In Electron
    // the preload injects `window.zeo` before the renderer runs.
    if (!window.zeo) {
      return;
    }
    const unsub = window.zeo.onDividerLayout((geom) => {
      setRatio(geom.ratio);
      setDividableWidth(geom.dividableWidth);
    });
    void window.zeo.splitView
      .dividerGeometry()
      .then((geom) => {
        setRatio(geom.ratio);
        setDividableWidth(geom.dividableWidth);
      })
      .catch(() => {});
    return unsub;
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    startXRef.current = event.clientX;
    startRatioRef.current = ratioRef.current;
    draggingRef.current = true;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) {
      return;
    }
    const width = widthRef.current;
    if (width <= 0) {
      return;
    }
    const next = clampRatio(
      startRatioRef.current + (event.clientX - startXRef.current) / width,
    );
    void window.zeo?.splitView.setRatio(next).catch(() => {});
    (globalThis as { __zeoDivider?: unknown }).__zeoDivider = { ratio: next };
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.currentTarget.releasePointerCapture(event.pointerId);
    draggingRef.current = false;
  };

  // A pointercancel (or an implicit capture loss) ends the drag WITHOUT a
  // pointerup, so clear the flag here too — otherwise draggingRef stays true and
  // a later bare hover-move would move the divider with no press.
  const onDragInterrupted = (): void => {
    draggingRef.current = false;
  };

  return (
    <div
      className="divider-handle"
      data-testid="divider-handle"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onDragInterrupted}
      onLostPointerCapture={onDragInterrupted}
    />
  );
}
