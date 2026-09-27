import {
  useEffect,
  useId,
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

export interface ThemePickerProps {
  /** The edited space, not necessarily the active one. */
  space: Space;
  /** `state.chrome.sidebarWidth`; the picker is 16 px narrower. */
  sidebarWidth: number;
  onChange(theme: SpaceTheme): void;
  onClose(): void;
}

// Horizontal inset (px) on each side: the picker stays inside the sidebar
// renderer, left of the content card.
const PICKER_INSET = 8;
// Swatch grid columns; Up/Down move focus by one row.
const SWATCH_COLUMNS = 5;
// Unechoed sends kept for broadcast matching; a stale tail is harmless.
const MAX_PENDING = 32;

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
    first === undefined
      ? "transparent"
      : second === undefined
        ? toHex(first)
        : `linear-gradient(160deg, ${toHex(first)}, ${toHex(second)})`;
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
}: ThemePickerProps): ReactElement {
  const [draft, setDraft] = useState<SpaceTheme | null>(space.theme);
  const [stopIndex, setStopIndex] = useState<0 | 1>(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const pressedKindRef = useRef<HTMLButtonElement>(null);
  const swatchRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Themes sent but not yet seen in a broadcast, oldest first. A broadcast
  // matching one of them is our own echo (possibly stale while the slider is
  // dragged) and never rewinds the draft; anything else came from elsewhere.
  const pending = useRef<SpaceTheme[]>([]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const intensityId = useId();

  useEffect(() => {
    const incoming = space.theme;
    const echo = pending.current.findIndex((sent) => themesEqual(sent, incoming));
    if (echo >= 0) {
      pending.current.splice(0, echo + 1);
      return;
    }
    if (!themesEqual(incoming, draftRef.current)) {
      pending.current = [];
      setDraft(incoming);
      if (incoming === null || incoming.stops.length === 1) {
        setStopIndex(0);
      }
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
    const item = document.querySelector<HTMLElement>(
      `[data-testid="space-item"][data-space-id="${CSS.escape(space.id)}"]`,
    );
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
      ref={rootRef}
      className="theme-picker"
      role="dialog"
      aria-label={title}
      data-testid="theme-picker"
      data-space-id={space.id}
      style={{ width: sidebarWidth - 2 * PICKER_INSET }}
      onKeyDown={onKeyDown}
    >
      <h2 className="theme-picker__title">{title}</h2>

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

      <div className="theme-picker__swatches">
        {SPACE_HUES.map((hue, index) => {
          const label = HUE_DEFINITIONS[hue].label;
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
              aria-pressed={hue === selectedHue}
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
