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
  /**
   * May return a promise (as the real IPC call does); the picker awaits it to
   * know when a send has settled. A plain `void` return is also accepted and
   * is treated as settling immediately.
   */
  onChange(theme: SpaceTheme): void | Promise<unknown>;
  onClose(): void;
}

/**
 * The picker's local draft, tracked by in-flight acknowledgement rather than
 * by matching broadcast values. Live apply means a slider drag sends many
 * values in a row; matching each broadcast against the values we sent is
 * fragile (a stale broadcast can be mistaken for the echo of a later send,
 * or a duplicate/rejected send that main never echoes can leave state
 * stuck). Instead we just count sends that haven't settled yet:
 *
 * - `draftSent` bumps `inFlight` and adopts `next` as the draft immediately
 *   (so the UI feels live).
 * - While `inFlight > 0`, incoming broadcasts are ignored outright: we don't
 *   know yet whether they're stale, our own echo, or real.
 * - `draftSettled` fires when a send's promise resolves or rejects. While
 *   sends are still outstanding it only decrements the counter. Once it
 *   reaches zero, the draft is resynced to `latestProp` — the most recently
 *   seen `space.theme` — which by then equals main's actual stored value:
 *   after a run of successful sequential sends this is the last value sent
 *   (Electron delivers main's broadcast before the invoke reply, and main
 *   handles invokes in order), and it also heals a rejected send or picks up
 *   an external change that happened mid-flight, since either way it's
 *   exactly what main is holding.
 * - `draftBroadcast`, when idle (`inFlight === 0`), simply replaces the
 *   draft with any differing incoming value: the PRD rule for an outside
 *   change.
 */
export interface DraftSync {
  draft: SpaceTheme | null;
  inFlight: number;
}

export function initialDraftSync(theme: SpaceTheme | null): DraftSync {
  return { draft: theme, inFlight: 0 };
}

/**
 * The picker sent `next`: it becomes the draft and a send is now in flight.
 * A `next` equal to the current draft (e.g. clicking the already-pressed
 * swatch) is a no-op and isn't worth a round trip, so nothing changes.
 */
export function syncSent(sync: DraftSync, next: SpaceTheme): DraftSync {
  if (themesEqual(sync.draft, next)) {
    return sync;
  }
  return { draft: next, inFlight: sync.inFlight + 1 };
}

/**
 * A send's promise settled (resolved or rejected — both mean main is done
 * with it). While other sends remain outstanding, only the counter moves.
 * Once none remain, the draft resyncs to `latestProp`, the newest
 * `space.theme` value seen, which is what main is actually holding by now.
 */
export function syncSettled(sync: DraftSync, latestProp: SpaceTheme | null): DraftSync {
  const inFlight = Math.max(0, sync.inFlight - 1);
  if (inFlight > 0) {
    return { draft: sync.draft, inFlight };
  }
  return { draft: latestProp, inFlight: 0 };
}

/**
 * A broadcast carried `incoming` for the edited space. While a send is in
 * flight it's ignored (we can't yet tell stale from real; `syncSettled`
 * resolves it once the counter drains). When idle, a value that differs from
 * the draft is an outside change and replaces it.
 */
export function syncBroadcast(sync: DraftSync, incoming: SpaceTheme | null): DraftSync {
  if (sync.inFlight > 0) {
    return sync;
  }
  if (themesEqual(sync.draft, incoming)) {
    return sync;
  }
  return { draft: incoming, inFlight: 0 };
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
  // The latest space.theme seen, for syncSettled to resync to once every
  // in-flight send has settled. Updated on every render (not in an effect)
  // so it's current before a same-tick settle reads it.
  const latestThemeRef = useRef(space.theme);
  latestThemeRef.current = space.theme;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Follow the space's theme on every broadcast, unless a send is in flight.
  const incoming = space.theme;
  useEffect(() => {
    setSync((current) => syncBroadcast(current, incoming));
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
    // A no-op send (e.g. clicking the already-pressed swatch) isn't worth
    // an in-flight round trip.
    if (themesEqual(draft, next)) {
      return;
    }
    setSync((current) => syncSent(current, next));
    const settle = (): void => {
      setSync((current) => syncSettled(current, latestThemeRef.current));
    };
    const result = onChange(next);
    if (result instanceof Promise) {
      result.then(settle, settle);
    } else {
      settle();
    }
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
