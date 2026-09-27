import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
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
  type Appearance,
  type Space,
  type SpaceHue,
  type SpaceTheme,
  type ThemeKind,
  type ThemeReport,
} from "@zeo/core";

export interface ThemePickerProps {
  /** The edited space, not necessarily the active one. */
  space: Space;
  /** `state.chrome.sidebarWidth`: the picker spans the sidebar minus 8px each side. */
  sidebarWidth: number;
  onChange(theme: SpaceTheme): void;
  onClose(): void;
}

/**
 * The picker's local draft plus the values it sent that main has not echoed
 * back yet. Live apply means a slider drag sends many values in a row; each
 * broadcast carries one of them, lagging the pointer. A broadcast equal to any
 * pending value is our own echo and must not move the draft back.
 *
 * `base` is the theme that was in effect just before the first pending send:
 * a broadcast still carrying it while sends are pending is a stale broadcast
 * that main queued before it saw our send (not yet processed), not an outside
 * change, and must be ignored too. Once every pending send has been echoed,
 * `base` stops mattering: a later broadcast equal to it is a real outside
 * change (e.g. someone edited the theme back to what it was) and replaces the
 * draft like any other.
 */
export interface DraftSync {
  draft: SpaceTheme | null;
  pending: SpaceTheme[];
  base: SpaceTheme | null;
}

export function initialDraftSync(theme: SpaceTheme | null): DraftSync {
  return { draft: theme, pending: [], base: theme };
}

/** The picker sent `next`: it becomes the draft and waits for its echo. */
export function draftSent(sync: DraftSync, next: SpaceTheme): DraftSync {
  const base = sync.pending.length === 0 ? sync.draft : sync.base;
  return { draft: next, pending: [...sync.pending, next], base };
}

/**
 * A broadcast carried `incoming` for the edited space. Our own echo is
 * ignored; entries sent before it are dropped, but the echoed value itself
 * stays pending, since every later unrelated broadcast (a tab change) repeats
 * it until main processes the next send. While sends are pending, a broadcast
 * equal to `base` is stale (queued before our first send landed) and is
 * ignored the same way. A broadcast that confirms a send moves `base` up to
 * that value, since main cannot go on to re-send anything older; once every
 * send has been confirmed this way, an old-`base` broadcast is no longer
 * possible from main and a later one equal to it is a genuine outside change.
 * Anything else is an outside change and replaces the draft.
 */
export function draftBroadcast(sync: DraftSync, incoming: SpaceTheme | null): DraftSync {
  const index =
    incoming === null ? -1 : sync.pending.findIndex((sent) => themesEqual(sent, incoming));
  if (index > 0) {
    return { draft: sync.draft, pending: sync.pending.slice(index), base: incoming };
  }
  if (index === 0) {
    if (sync.pending.length === 1 && !themesEqual(sync.base, incoming)) {
      return { draft: sync.draft, pending: sync.pending, base: incoming };
    }
    return sync;
  }
  if (sync.pending.length > 0 && themesEqual(sync.base, incoming)) {
    return sync;
  }
  if (sync.pending.length === 0 && themesEqual(sync.draft, incoming)) {
    return sync;
  }
  return { draft: incoming, pending: [], base: incoming };
}

/** Background for a contrast chip: the window ground, or both grounds as a gradient. */
export function chipGround(report: ThemeReport): string {
  const [first, second] = report.grounds;
  if (first === undefined) {
    return "transparent";
  }
  if (second === undefined) {
    return toHex(first);
  }
  return `linear-gradient(160deg, ${toHex(first)}, ${toHex(second)})`;
}

const APPEARANCE_LABEL: Record<Appearance, string> = { light: "Light", dark: "Dark" };

/** Accessible name of a contrast chip, e.g. `Light: text 12.8 to 1, secondary 5.1 to 1`. */
export function chipLabel(report: ThemeReport, appearance: Appearance): string {
  return `${APPEARANCE_LABEL[appearance]}: text ${report.inkContrast.toFixed(1)} to 1, secondary ${report.inkSecondaryContrast.toFixed(1)} to 1`;
}

/**
 * Swatch index after an arrow key in the five-column grid of ten: Left/Right
 * step by one, Up/Down by a row, all wrapping. `null` for any other key.
 */
export function swatchIndexAfterKey(index: number, key: string): number | null {
  const count = SPACE_HUES.length;
  const step =
    key === "ArrowRight"
      ? 1
      : key === "ArrowLeft"
        ? -1
        : key === "ArrowDown"
          ? 5
          : key === "ArrowUp"
            ? -5
            : 0;
  if (step === 0) {
    return null;
  }
  return (((index + step) % count) + count) % count;
}

type Vars = CSSProperties & Record<`--${string}`, string>;

function ContrastChip({ theme, appearance }: { theme: SpaceTheme | null; appearance: Appearance }) {
  const report = themeReport(theme, appearance);
  const style: Vars = {
    "--chip-ground": chipGround(report),
    "--chip-ink": toHex(report.ink),
    "--chip-ink-secondary": toHex(report.inkSecondary),
  };
  return (
    <div
      className="theme-picker__chip"
      data-testid="theme-contrast"
      data-appearance={appearance}
      data-ink-contrast={report.inkContrast.toFixed(2)}
      data-secondary-contrast={report.inkSecondaryContrast.toFixed(2)}
      role="img"
      aria-label={chipLabel(report, appearance)}
      style={style}
    >
      <span className="theme-picker__chip-line">
        <span className="theme-picker__chip-sample">Aa</span>
        <span className="theme-picker__chip-name">{APPEARANCE_LABEL[appearance]}</span>
      </span>
      <span className="theme-picker__chip-ratios">
        {report.inkContrast.toFixed(1)} · {report.inkSecondaryContrast.toFixed(1)}
      </span>
    </div>
  );
}

/**
 * Space theme picker (PRD 10.3 §6): a popover rendered inside the sidebar,
 * anchored above the bottom bar. Every control applies live through
 * `onChange`; the draft follows outside changes to the space's theme but
 * ignores echoes of its own sends. Escape, a press outside and the window
 * losing focus close it; the remaining close conditions depend on app state
 * and live with the caller.
 */
export function ThemePicker({
  space,
  sidebarWidth,
  onChange,
  onClose,
}: ThemePickerProps): ReactElement {
  const [sync, setSync] = useState<DraftSync>(() => initialDraftSync(space.theme));
  const [stopIndex, setStopIndex] = useState<0 | 1>(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const pressedKindRef = useRef<HTMLButtonElement>(null);
  const swatchRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onCloseRef = useRef(onClose);
  const intensityId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Follow the space's theme on every broadcast (echoes filtered out).
  const incoming = space.theme;
  useEffect(() => {
    setSync((current) => draftBroadcast(current, incoming));
  }, [incoming]);

  // Open: focus the pressed kind button.
  useEffect(() => {
    pressedKindRef.current?.focus();
  }, []);

  // Dismiss on a press outside the picker or when the sidebar window blurs
  // (focus went to a page view or another window).
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
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

  const draft = sync.draft;
  const kind: ThemeKind = draft !== null && draft.stops.length === 2 ? "gradient" : "solid";
  const activeStop: 0 | 1 = draft !== null && draft.stops.length === 2 ? stopIndex : 0;
  const selectedHue: SpaceHue | null =
    draft === null ? null : (draft.stops[activeStop] ?? draft.stops[0]);
  const percent = draft === null ? 0 : Math.round(draft.intensity * 100);
  const focusableHueIndex = selectedHue === null ? 0 : Math.max(0, SPACE_HUES.indexOf(selectedHue));

  const send = (next: SpaceTheme): void => {
    setSync((current) => draftSent(current, next));
    onChange(next);
  };

  const setKind = (next: ThemeKind): void => {
    // Same kind is a no-op; in particular Solid on an untinted space stays untinted.
    if (next === kind) {
      return;
    }
    setStopIndex(next === "gradient" ? 1 : 0);
    send(pickerSetKind(draft, next));
  };

  const onRootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const item = document.querySelector<HTMLElement>(
      `[data-testid="space-item"][data-space-id="${CSS.escape(space.id)}"]`,
    );
    onClose();
    item?.focus();
  };

  const onSwatchKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const current = swatchRefs.current.findIndex((el) => el === document.activeElement);
    if (current < 0) {
      return;
    }
    const next = swatchIndexAfterKey(current, event.key);
    if (next === null) {
      return;
    }
    event.preventDefault();
    swatchRefs.current[next]?.focus();
  };

  const kindButton = (value: ThemeKind, label: string) => {
    const pressed = kind === value;
    return (
      <button
        type="button"
        ref={pressed ? pressedKindRef : undefined}
        className="theme-picker__segment"
        data-testid={`theme-kind-${value}`}
        aria-pressed={pressed}
        onClick={() => setKind(value)}
      >
        {label}
      </button>
    );
  };

  const title = `${space.name} theme`;

  return (
    <div
      ref={rootRef}
      className="theme-picker"
      role="dialog"
      aria-label={title}
      data-testid="theme-picker"
      data-space-id={space.id}
      style={{ width: sidebarWidth - 16 }}
      onKeyDown={onRootKeyDown}
    >
      <h2 className="theme-picker__title">{title}</h2>

      <div className="theme-picker__track" role="group" aria-label="Theme kind">
        {kindButton("solid", "Solid")}
        {kindButton("gradient", "Gradient")}
      </div>

      {draft !== null && draft.stops.length === 2 && (
        <div className="theme-picker__track" role="group" aria-label="Gradient stop">
          {draft.stops.map((hue, index) => (
            <button
              key={index}
              type="button"
              className="theme-picker__segment"
              data-testid="theme-stop"
              data-stop-index={index}
              aria-pressed={activeStop === index}
              onClick={() => setStopIndex(index === 0 ? 0 : 1)}
            >
              <span
                className="theme-picker__stop-dot"
                aria-hidden="true"
                style={{ "--swatch": hueSwatchColor(hue) } as Vars}
              />
              Color {index + 1}
            </button>
          ))}
        </div>
      )}

      <div className="theme-picker__swatches" onKeyDown={onSwatchKeyDown}>
        {SPACE_HUES.map((hue, index) => {
          const label = HUE_DEFINITIONS[hue].label;
          return (
            <button
              key={hue}
              ref={(el) => {
                swatchRefs.current[index] = el;
              }}
              type="button"
              className="theme-picker__swatch"
              data-testid="theme-swatch"
              data-hue={hue}
              aria-label={label}
              title={label}
              aria-pressed={selectedHue === hue}
              tabIndex={index === focusableHueIndex ? 0 : -1}
              style={{ "--swatch": hueSwatchColor(hue) } as Vars}
              onClick={() => send(pickerSelectHue(draft, activeStop, hue))}
            />
          );
        })}
      </div>

      <div className="theme-picker__intensity">
        <label className="theme-picker__label" htmlFor={intensityId}>
          Intensity
        </label>
        <output
          className="theme-picker__value"
          data-testid="theme-intensity-value"
          htmlFor={intensityId}
        >
          {percent}%
        </output>
        <input
          id={intensityId}
          className="theme-picker__slider"
          type="range"
          min="0"
          max="100"
          step="5"
          value={percent}
          data-testid="theme-intensity"
          onChange={(event) => send(pickerSetIntensity(draft, Number(event.target.value)))}
        />
      </div>

      <div className="theme-picker__contrast">
        <ContrastChip theme={draft} appearance="light" />
        <ContrastChip theme={draft} appearance="dark" />
      </div>
    </div>
  );
}
