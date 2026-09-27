import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  HUE_DEFINITIONS,
  SPACE_HUES,
  hueSwatchColor,
  themeReport,
  toHex,
  type Space,
  type SpaceTheme,
  type ThemeReport,
} from "@zeo/core";
import {
  ThemePicker,
  chipGround,
  chipLabel,
  initialDraftSync,
  swatchIndexAfterKey,
  syncBroadcast,
  syncSent,
  syncSettled,
} from "./ThemePicker.js";

function space(theme: SpaceTheme | null, name = "Work"): Space {
  return { id: "s1", name, profileId: "p1", createdAt: 0, theme };
}

function render(theme: SpaceTheme | null, sidebarWidth = 240): string {
  return renderToStaticMarkup(
    <ThemePicker
      space={space(theme)}
      sidebarWidth={sidebarWidth}
      onChange={() => {}}
      onClose={() => {}}
    />,
  );
}

/** The opening tag of the first element carrying `attr`. */
function tagWith(html: string, attr: string): string {
  const match = new RegExp(`<[a-z0-9]+[^>]*${attr}[^>]*>`).exec(html);
  if (match === null) {
    throw new Error(`no element with ${attr}`);
  }
  return match[0];
}

function testIds(html: string): string[] {
  return [...html.matchAll(/data-testid="([a-z-]+)"/g)].map((m) => m[1]!);
}

describe("ThemePicker markup", () => {
  test("root dialog, header and sections in order", () => {
    const html = render({ stops: ["teal"], intensity: 0.6 }, 260);
    const root = tagWith(html, 'data-testid="theme-picker"');
    expect(root).toContain('class="theme-picker"');
    expect(root).toContain('role="dialog"');
    expect(root).toContain('aria-label="Work theme"');
    expect(root).toContain('data-space-id="s1"');
    expect(root).toContain("width:244px");
    expect(html).toContain(">Work theme</h2>");
    expect(html).toContain('role="group" aria-label="Theme kind"');
    expect([...new Set(testIds(html))]).toEqual([
      "theme-picker",
      "theme-kind-solid",
      "theme-kind-gradient",
      "theme-swatch",
      "theme-intensity-value",
      "theme-intensity",
      "theme-contrast",
    ]);
  });

  test("a solid theme: Solid pressed, its hue pressed, intensity shown, no stop segment", () => {
    const html = render({ stops: ["teal"], intensity: 0.6 });
    expect(tagWith(html, 'data-testid="theme-kind-solid"')).toContain('aria-pressed="true"');
    expect(tagWith(html, 'data-testid="theme-kind-gradient"')).toContain('aria-pressed="false"');
    expect(html).not.toContain('data-testid="theme-stop"');
    const pressed = [...html.matchAll(/data-hue="([a-z]+)"[^>]*aria-pressed="true"/g)].map(
      (m) => m[1],
    );
    expect(pressed).toEqual(["teal"]);
    const slider = tagWith(html, 'data-testid="theme-intensity"');
    expect(slider).toContain('type="range"');
    expect(slider).toContain('min="0"');
    expect(slider).toContain('max="100"');
    expect(slider).toContain('step="5"');
    expect(slider).toContain('value="60"');
    expect(html).toMatch(/data-testid="theme-intensity-value"[^>]*>60%<\/output>/);
    expect(html).toMatch(/<label[^>]*>Intensity<\/label>/);
  });

  test("a null theme: Solid pressed, no swatch pressed, slider at 0", () => {
    const html = render(null);
    expect(tagWith(html, 'data-testid="theme-kind-solid"')).toContain('aria-pressed="true"');
    expect(tagWith(html, 'data-testid="theme-kind-gradient"')).toContain('aria-pressed="false"');
    expect(html).not.toMatch(/data-testid="theme-swatch"[^>]*aria-pressed="true"/);
    expect(tagWith(html, 'data-testid="theme-intensity"')).toContain('value="0"');
    expect(html).toMatch(/data-testid="theme-intensity-value"[^>]*>0%<\/output>/);
  });

  test("a two-stop theme shows the stop segment with Color 1 and Color 2", () => {
    const html = render({ stops: ["coral", "sky"], intensity: 1 });
    expect(tagWith(html, 'data-testid="theme-kind-gradient"')).toContain('aria-pressed="true"');
    expect(html).toContain('role="group" aria-label="Gradient stop"');
    const stops = [...html.matchAll(/<button[^>]*data-testid="theme-stop"[^>]*>(.*?)<\/button>/g)];
    expect(stops).toHaveLength(2);
    expect(stops[0]![0]).toContain('data-stop-index="0"');
    expect(stops[1]![0]).toContain('data-stop-index="1"');
    expect(stops[0]![1]).toContain("Color 1");
    expect(stops[1]![1]).toContain("Color 2");
    expect(stops[0]![1]).toContain(`--swatch:${hueSwatchColor("coral")}`);
    expect(stops[1]![1]).toContain(`--swatch:${hueSwatchColor("sky")}`);
    // The local stop index starts at 0, so the first stop's hue is pressed.
    const pressed = [...html.matchAll(/data-hue="([a-z]+)"[^>]*aria-pressed="true"/g)].map(
      (m) => m[1],
    );
    expect(pressed).toEqual(["coral"]);
  });

  test("ten swatches in SPACE_HUES order, labelled by HUE_DEFINITIONS, colored inline", () => {
    const html = render({ stops: ["iris"], intensity: 1 });
    const swatches = [...html.matchAll(/<button[^>]*data-testid="theme-swatch"[^>]*>/g)].map(
      (m) => m[0],
    );
    expect(swatches).toHaveLength(10);
    swatches.forEach((tag, index) => {
      const hue = SPACE_HUES[index]!;
      expect(tag).toContain(`data-hue="${hue}"`);
      expect(tag).toContain(`aria-label="${HUE_DEFINITIONS[hue].label}"`);
      expect(tag).toContain(`title="${HUE_DEFINITIONS[hue].label}"`);
      expect(tag).toContain(`--swatch:${hueSwatchColor(hue)}`);
    });
  });

  test("roving tab stop lands on the pressed swatch, not just index 0", () => {
    // iris is index 0, the same as the no-selection fallback: use amber
    // instead so the assertion can't pass by accident.
    const html = render({ stops: ["amber"], intensity: 1 });
    const swatches = [...html.matchAll(/<button[^>]*data-testid="theme-swatch"[^>]*>/g)].map(
      (m) => m[0],
    );
    const withTabStop = swatches.filter((tag) => tag.includes('tabindex="0"'));
    expect(withTabStop).toHaveLength(1);
    expect(withTabStop[0]).toContain('data-hue="amber"');
  });

  test.each<SpaceTheme | null>([
    { stops: ["amber"], intensity: 0.75 },
    { stops: ["rose", "mint"], intensity: 1 },
    null,
  ])("contrast chips carry the themeReport values for light and dark (%j)", (theme) => {
    const html = render(theme);
    const chips = [...html.matchAll(/<div[^>]*data-testid="theme-contrast"[^>]*>/g)].map(
      (m) => m[0],
    );
    expect(chips).toHaveLength(2);
    (["light", "dark"] as const).forEach((appearance, index) => {
      const report = themeReport(theme, appearance);
      const chip = chips[index]!;
      expect(chip).toContain(`data-appearance="${appearance}"`);
      expect(chip).toContain(`data-ink-contrast="${report.inkContrast.toFixed(2)}"`);
      expect(chip).toContain(`data-secondary-contrast="${report.inkSecondaryContrast.toFixed(2)}"`);
      expect(chip).toContain(`aria-label="${chipLabel(report, appearance)}"`);
      expect(chip).toContain(`--chip-ink:${toHex(report.ink)}`);
      expect(chip).toContain(`--chip-ink-secondary:${toHex(report.inkSecondary)}`);
    });
    expect(html).toContain(">Light</span>");
    expect(html).toContain(">Dark</span>");
    expect(html).not.toContain("inkOnAccent");
  });
});

describe("chip helpers", () => {
  const report = (grounds: ThemeReport["grounds"]): ThemeReport => ({
    ...themeReport(null, "light"),
    grounds,
  });

  test("chipGround: one ground is a hex, two a 160deg gradient", () => {
    const a = [255, 0, 0] as const;
    const b = [0, 0, 255] as const;
    expect(chipGround(report([a]))).toBe(toHex(a));
    expect(chipGround(report([a, b]))).toBe(`linear-gradient(160deg, ${toHex(a)}, ${toHex(b)})`);
  });

  test("chipGround matches the report of a real two-stop theme", () => {
    const real = themeReport({ stops: ["coral", "sky"], intensity: 1 }, "dark");
    expect(chipGround(real)).toMatch(/^linear-gradient\(160deg, #[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
  });

  test("chipLabel reads both ratios to one decimal", () => {
    const r = { ...themeReport(null, "light"), inkContrast: 12.84, inkSecondaryContrast: 5.06 };
    expect(chipLabel(r, "light")).toBe("Light: text 12.8 to 1, secondary 5.1 to 1");
    expect(chipLabel(r, "dark")).toBe("Dark: text 12.8 to 1, secondary 5.1 to 1");
  });
});

describe("swatchIndexAfterKey", () => {
  test("left/right step by one and wrap", () => {
    expect(swatchIndexAfterKey(0, "ArrowRight")).toBe(1);
    expect(swatchIndexAfterKey(9, "ArrowRight")).toBe(0);
    expect(swatchIndexAfterKey(0, "ArrowLeft")).toBe(9);
  });

  test("up/down step by a row of five and wrap", () => {
    expect(swatchIndexAfterKey(2, "ArrowDown")).toBe(7);
    expect(swatchIndexAfterKey(7, "ArrowDown")).toBe(2);
    expect(swatchIndexAfterKey(3, "ArrowUp")).toBe(8);
  });

  test("other keys are ignored", () => {
    expect(swatchIndexAfterKey(4, "Enter")).toBeNull();
    expect(swatchIndexAfterKey(4, "Tab")).toBeNull();
  });
});

describe("draft sync", () => {
  const t = (intensity: number): SpaceTheme => ({ stops: ["teal"], intensity });

  test("starts from the space theme with nothing in flight", () => {
    expect(initialDraftSync(t(1))).toEqual({ draft: t(1), inFlight: 0, failed: false });
  });

  test("a drag passing back through its start ignores stale broadcasts and echoes", () => {
    let sync = initialDraftSync(t(0.4));
    sync = syncSent(sync, t(0.45));
    sync = syncSent(sync, t(0.4));
    sync = syncSent(sync, t(0.35));
    expect(sync).toEqual({ draft: t(0.35), inFlight: 3, failed: false });
    // A stale pre-send broadcast, then the echoes: none moves the draft.
    for (const incoming of [t(0.4), t(0.45), t(0.4), t(0.35)]) {
      sync = syncBroadcast(sync, incoming);
      expect(sync.draft).toEqual(t(0.35));
    }
    // Each success settles; the prop passed in is deliberately stale (App has
    // not re-rendered the echo yet) and must not be read.
    sync = syncSettled(sync, true, t(0.4));
    sync = syncSettled(sync, true, t(0.4));
    expect(sync).toEqual({ draft: t(0.35), inFlight: 1, failed: false });
    sync = syncSettled(sync, true, t(0.4));
    expect(sync).toEqual({ draft: t(0.35), inFlight: 0, failed: false });
  });

  test("a successful settle never resyncs to a not-yet-rendered prop", () => {
    let sync = initialDraftSync(t(0.4));
    sync = syncSent(sync, t(0.45));
    sync = syncSettled(sync, true, t(0.4));
    expect(sync).toEqual({ draft: t(0.45), inFlight: 0, failed: false });
  });

  test("a rejected send resyncs to the prop once nothing is in flight", () => {
    let sync = initialDraftSync(t(0.4));
    sync = syncSent(sync, t(0.45));
    sync = syncSent(sync, t(0.5));
    sync = syncSettled(sync, false, t(0.4));
    // Another send is still outstanding: only the counter moves.
    expect(sync).toEqual({ draft: t(0.5), inFlight: 1, failed: true });
    sync = syncSettled(sync, true, t(0.4));
    expect(sync).toEqual({ draft: t(0.4), inFlight: 0, failed: false });
  });

  test("a broadcast while idle replaces the draft (outside change)", () => {
    const sync = initialDraftSync(t(0.4));
    expect(syncBroadcast(sync, t(0.9))).toEqual({ draft: t(0.9), inFlight: 0, failed: false });
    expect(syncBroadcast(sync, null)).toEqual({ draft: null, inFlight: 0, failed: false });
  });

  test("an unchanged broadcast while idle keeps the same object", () => {
    const sync = initialDraftSync(t(1));
    expect(syncBroadcast(sync, t(1))).toBe(sync);
    const empty = initialDraftSync(null);
    expect(syncBroadcast(empty, null)).toBe(empty);
  });
});
