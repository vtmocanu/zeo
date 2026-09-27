import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import type { Appearance, Space, SpaceHue, SpaceTheme, ThemeKind } from "@zeo/core";
import {
  HUE_DEFINITIONS,
  SPACE_HUES,
  hueSwatchColor,
  pickerSelectHue,
  pickerSetIntensity,
  pickerSetKind,
  themeReport,
  themesEqual,
  toHex,
} from "@zeo/core";
import { findSpaceItem } from "./dom.js";
import { useEnterMotion } from "./motion.js";

export interface ThemePickerProps {
  /** The edited space, not necessarily the active one. */
  space: Space;
  /** `state.chrome.sidebarWidth`; the picker is 16 px narrower. */
  sidebarWidth: number;
  onChange(theme: SpaceTheme): void;
  onClose(): void;
  /**
   * Called synchronously from this component's own `useLayoutEffect`
   * cleanup, the instant before it unmounts, with whether focus was inside
   * the picker at that moment. Layout-effect cleanups of a deleted fiber run
   * before its host DOM nodes are removed, so this is the last point at
   * which `document.activeElement` reliably reflects "was it in here" —
   * by the time an ancestor's own effects run (e.g. after a sidebar collapse
   * or the edited space being removed), the node is already gone and focus
   * has already fallen back to `<body>`. The parent uses this to restore
   * focus for those close reasons only; Escape moves focus itself (to the
   * space's own item) before closing, so it reliably reports `false`. An
   * outside pointerdown or a window blur does NOT move focus itself, so
   * this can still report `true` for those closes — harmlessly, since the
   * parent never consults this value for a plain outside-pointerdown/blur
   * close, only for the sidebar-collapse, active-space-change and
   * edited-space-removed paths.
   */
  reportUnmountFocus(hadFocus: boolean): void;
}

// Horizontal inset (px) on each side: the picker stays inside the sidebar
// renderer, left of the content card.
const PICKER_INSET = 8;
// Swatch grid columns; Up/Down move focus by one row.
const SWATCH_COLUMNS = 5;
// Themes sent since the last externally-originated change kept for broadcast
// matching; a stale tail (trimmed oldest-first past this bound) is harmless —
// it just makes a very old resend look external sooner than ideal.
const MAX_PENDING = 32;

/**
 * Whether an incoming broadcast theme is one WE caused (an echo of a change
 * this picker itself sent), as opposed to an externally-originated change
 * (another window, or a broadcast unrelated to this picker) that should
 * rewind the draft.
 *
 * `incoming` is ours when it equals the current draft (nothing to do), or
 * when it equals ANY theme sent since the last externally-originated change —
 * not just the oldest unacknowledged one. Every theme this picker sends stays
 * a recognized echo until an actual external change arrives and resets the
 * record; a single broadcast can therefore match interleaved sends out of
 * order without ever falling through to "external" and rewinding the draft.
 *
 * PRD §6 only asks to compare against "the last value the picker sent";
 * matching the whole pending set is a deliberate widening — this picker is
 * meant to be the only writer of its own space's theme while open, so the
 * wider match is not expected to hide a genuine external change in practice.
 */
export function isOwnThemeEcho(
  incoming: SpaceTheme | null,
  draft: SpaceTheme | null,
  sentSinceExternal: readonly SpaceTheme[],
): boolean {
  if (themesEqual(incoming, draft)) {
    return true;
  }
  return sentSinceExternal.some((sent) => themesEqual(sent, incoming));
}

const APPEARANCES: readonly Appearance[] = ["light", "dark"];
const APPEARANCE_LABEL: Record<Appearance, string> = { light: "Light", dark: "Dark" };

type ThemeVars = CSSProperties & Record<`--${string}`, string>;

/** The `--chip-*` properties for one contrast chip: `themeReport` colors as hex. */
function chipStyle(
  draft: SpaceTheme | null,
  appearance: Appearance,
): {
  style: ThemeVars;
  inkContrast: number;
  secondaryContrast: number;
} {
  const report = themeReport(draft, appearance);
  const [first, second] = report.grounds;
  const ground =
    second === undefined ? toHex(first) : `linear-gradient(160deg, ${toHex(first)}, ${toHex(second)})`;
  return {
    style: {
      "--chip-ground": ground,
      "--chip-ink": toHex(report.ink),
      "--chip-ink-secondary": toHex(report.inkSecondary),
    },
    inkContrast: report.inkContrast,
    secondaryContrast: report.inkSecondaryContrast,
  };
}

/**
 * The space theme picker (PRD 10.3 §6): a sidebar-anchored dialog that edits
 * one space's theme live. Every transition is a core `picker*` function; this
 * component only keeps the draft, the selected gradient stop and focus.
 */
export function ThemePicker({
  space,
  sidebarWidth,
  onChange,
  onClose,
  reportUnmountFocus,
}: ThemePickerProps): ReactElement {
  const [draft, setDraft] = useState<SpaceTheme | null>(space.theme);
  const [stopIndex, setStopIndex] = useState<0 | 1>(0);
  // N5: `useEnterMotion`'s RefObject also serves as the dismiss-on-outside-
  // press root ref below, so there is no second, inline callback ref
  // re-attaching on every render just to fan the node out to two refs.
  // PRD 10.7 §3, §5: the picker only ever mounts while open, so `open` is
  // always true; `useEnterMotion` still runs the initial "replay" step,
  // which plays the enter animation on mount.
  const motionRef = useEnterMotion<HTMLDivElement>(true);
  const pressedKindRef = useRef<HTMLButtonElement>(null);
  const swatchRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Every theme sent since the last externally-originated change, oldest
  // first. A broadcast matching one of them (or the current draft) is our
  // own echo and never rewinds the draft; anything else came from elsewhere.
  const pending = useRef<SpaceTheme[]>([]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const reportUnmountFocusRef = useRef(reportUnmountFocus);
  reportUnmountFocusRef.current = reportUnmountFocus;
  const intensityId = useId();

  // Report, right as this unmounts, whether focus was still inside it — see
  // `reportUnmountFocus` on ThemePickerProps. A plain `useEffect` cleanup
  // would run too late (after the host node is already removed and the
  // parent's own effects have already run); `useLayoutEffect` cleanup runs
  // in time.
  useLayoutEffect(() => {
    return () => {
      const root = document.querySelector('[data-testid="theme-picker"]');
      const active = document.activeElement;
      reportUnmountFocusRef.current(root !== null && active instanceof Node && root.contains(active));
    };
  }, []);

  useEffect(() => {
    const incoming = space.theme;
    if (isOwnThemeEcho(incoming, draftRef.current, pending.current)) {
      return;
    }
    pending.current = [];
    setDraft(incoming);
    if (incoming === null || incoming.stops.length === 1) {
      setStopIndex(0);
    }
  }, [space.theme]);

  // On open, focus the pressed kind button.
  useEffect(() => {
    pressedKindRef.current?.focus();
  }, []);

  // Dismiss on a press outside the picker or when the sidebar window loses
  // focus (to a page view or another window).
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const root = motionRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        onCloseRef.current();
      }
    };
    const onBlur = (): void => onCloseRef.current();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const apply = (next: SpaceTheme): void => {
    if (themesEqual(next, draftRef.current)) {
      return;
    }
    draftRef.current = next;
    setDraft(next);
    pending.current.push(next);
    if (pending.current.length > MAX_PENDING) {
      pending.current.shift();
    }
    onChange(next);
  };

  const kind: ThemeKind = draft !== null && draft.stops.length === 2 ? "gradient" : "solid";
  const stops = draft?.stops ?? null;
  const selectedHue: SpaceHue | null =
    stops === null ? null : stops[Math.min(stopIndex, stops.length - 1)]!;
  const percent = draft === null ? 0 : Math.round(draft.intensity * 100);

  const setKind = (next: ThemeKind): void => {
    setStopIndex(next === "gradient" ? 1 : 0);
    apply(pickerSetKind(draft, next));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const item = findSpaceItem(space.id);
    onClose();
    item?.focus();
  };

  const onSwatchKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step =
      event.key === "ArrowLeft"
        ? -1
        : event.key === "ArrowRight"
          ? 1
          : event.key === "ArrowUp"
            ? -SWATCH_COLUMNS
            : event.key === "ArrowDown"
              ? SWATCH_COLUMNS
              : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const count = SPACE_HUES.length;
    swatchRefs.current[(index + step + count) % count]?.focus();
  };

  const title = `${space.name} theme`;

  return (
    <div
      ref={motionRef}
      className="theme-picker"
      role="dialog"
      aria-label={title}
      data-testid="theme-picker"
      data-space-id={space.id}
      style={{ width: sidebarWidth - 2 * PICKER_INSET }}
      onKeyDown={onKeyDown}
    >
      <h2 className="theme-picker__title" title={title}>
        {title}
      </h2>

      <div className="theme-picker__segment" role="group" aria-label="Theme kind">
        {(["solid", "gradient"] as const).map((option) => (
          <button
            key={option}
            ref={option === kind ? pressedKindRef : undefined}
            type="button"
            className="theme-picker__segment-button"
            data-testid={`theme-kind-${option}`}
            aria-pressed={option === kind}
            onClick={() => setKind(option)}
          >
            {option === "solid" ? "Solid" : "Gradient"}
          </button>
        ))}
      </div>

      {stops !== null && stops.length === 2 && (
        <div className="theme-picker__segment" role="group" aria-label="Gradient stop">
          {stops.map((hue, index) => (
            <button
              key={index}
              type="button"
              className="theme-picker__segment-button"
              data-testid="theme-stop"
              data-stop-index={index}
              aria-pressed={index === stopIndex}
              onClick={() => setStopIndex(index === 0 ? 0 : 1)}
            >
              <span
                className="theme-picker__stop-dot"
                aria-hidden="true"
                style={{ "--swatch": hueSwatchColor(hue) } as ThemeVars}
              />
              {`Color ${index + 1}`}
            </button>
          ))}
        </div>
      )}

      <div
        className="theme-picker__swatches"
        role="group"
        aria-label={kind === "solid" ? "Color" : `Color ${stopIndex + 1}`}
      >
        {SPACE_HUES.map((hue, index) => {
          const label = HUE_DEFINITIONS[hue].label;
          const pressed = hue === selectedHue;
          // Roving tabindex: only the pressed swatch (or the first when none
          // is pressed) is in the tab order; Left/Right/Up/Down move focus
          // between the rest without changing the tab stop.
          const tabbable = selectedHue === null ? index === 0 : pressed;
          return (
            <button
              key={hue}
              ref={(node) => {
                swatchRefs.current[index] = node;
              }}
              type="button"
              className="theme-picker__swatch"
              data-testid="theme-swatch"
              data-hue={hue}
              aria-label={label}
              title={label}
              aria-pressed={pressed}
              tabIndex={tabbable ? 0 : -1}
              style={{ "--swatch": hueSwatchColor(hue) } as ThemeVars}
              onClick={() => apply(pickerSelectHue(draft, stopIndex, hue))}
              onKeyDown={(event) => onSwatchKeyDown(event, index)}
            />
          );
        })}
      </div>

      <div className="theme-picker__intensity">
        <div className="theme-picker__intensity-row">
          <label htmlFor={intensityId}>Intensity</label>
          <output
            className="theme-picker__intensity-value"
            htmlFor={intensityId}
            data-testid="theme-intensity-value"
            aria-live="off"
          >
            {`${percent}%`}
          </output>
        </div>
        <input
          id={intensityId}
          type="range"
          className="theme-picker__slider"
          min="0"
          max="100"
          step="5"
          value={percent}
          data-testid="theme-intensity"
          onChange={(event) => apply(pickerSetIntensity(draft, Number(event.target.value)))}
        />
      </div>

      <div className="theme-picker__contrast">
        {APPEARANCES.map((appearance) => {
          const chip = chipStyle(draft, appearance);
          const name = APPEARANCE_LABEL[appearance];
          const ink = chip.inkContrast.toFixed(1);
          const secondary = chip.secondaryContrast.toFixed(1);
          return (
            <div
              key={appearance}
              className="theme-picker__chip"
              data-testid="theme-contrast"
              data-appearance={appearance}
              data-ink-contrast={chip.inkContrast.toFixed(2)}
              data-secondary-contrast={chip.secondaryContrast.toFixed(2)}
              role="img"
              aria-label={`${name}: text ${ink} to 1, secondary ${secondary} to 1`}
              style={chip.style}
            >
              <div className="theme-picker__chip-line">
                <span className="theme-picker__chip-sample">Aa</span>
                <span>{name}</span>
              </div>
              <div className="theme-picker__chip-ratios">{`${ink} · ${secondary}`}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
