import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  HUE_DEFINITIONS,
  SPACE_HUES,
  hueSwatchColor,
  themeReport,
  type Appearance,
  type Space,
  type SpaceTheme,
} from "@zeo/core";
import { ThemePicker, isOwnThemeEcho } from "./ThemePicker.js";

function space(theme: SpaceTheme | null): Space {
  return { id: "s1", name: "Work", profileId: "p1", createdAt: 0, theme };
}

// A minimal element tree over React's static markup (the UI tests run under
// Node with no DOM): enough to query by test id and read attributes and text.
interface MarkupNode {
  tag: string;
  attrs: Record<string, string>;
  children: (MarkupNode | string)[];
  parent: MarkupNode | null;
}

const VOID_TAGS = new Set(["input", "br", "img", "hr", "meta", "link"]);

function decode(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parse(html: string): MarkupNode {
  const root: MarkupNode = { tag: "#root", attrs: {}, children: [], parent: null };
  let current = root;
  const token =
    /<!--.*?-->|<\/([a-z0-9]+)>|<([a-z0-9]+)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/gs;
  for (const match of html.matchAll(token)) {
    const [, close, open, attrText, selfClose, text] = match;
    if (close !== undefined) {
      current = current.parent ?? root;
    } else if (open !== undefined) {
      const attrs: Record<string, string> = {};
      for (const [, name, value] of (attrText ?? "").matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
        attrs[name!] = decode(value ?? "");
      }
      const node: MarkupNode = { tag: open, attrs, children: [], parent: current };
      current.children.push(node);
      if (selfClose !== "/" && !VOID_TAGS.has(open)) {
        current = node;
      }
    } else if (text !== undefined) {
      current.children.push(decode(text));
    }
  }
  return root;
}

function descendants(node: MarkupNode): MarkupNode[] {
  return node.children.flatMap((child) =>
    typeof child === "string" ? [] : [child, ...descendants(child)],
  );
}

function text(node: MarkupNode): string {
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
}

function render(theme: SpaceTheme | null, sidebarWidth = 232): MarkupNode {
  return parse(
    renderToStaticMarkup(
      <ThemePicker
        space={space(theme)}
        sidebarWidth={sidebarWidth}
        onChange={() => {}}
        onClose={() => {}}
      />,
    ),
  );
}

function all(root: MarkupNode, testId: string): MarkupNode[] {
  return descendants(root).filter((node) => node.attrs["data-testid"] === testId);
}

function one(root: MarkupNode, testId: string): MarkupNode {
  const [node] = all(root, testId);
  if (node === undefined) {
    throw new Error(`missing ${testId}`);
  }
  return node;
}

function attr(node: MarkupNode, name: string): string | undefined {
  return node.attrs[name];
}

const TEAL: SpaceTheme = { stops: ["teal"], intensity: 0.6 };
const GRADIENT: SpaceTheme = { stops: ["rose", "amber"], intensity: 1 };

describe("ThemePicker", () => {
  test("root is a labelled dialog for the edited space, sidebar width minus 16px", () => {
    const root = one(render(TEAL, 240), "theme-picker");
    expect(attr(root, "role")).toBe("dialog");
    expect(attr(root, "aria-label")).toBe("Work theme");
    expect(attr(root, "data-space-id")).toBe("s1");
    expect(attr(root, "class")).toBe("theme-picker");
    expect(attr(root, "style")).toBe("width:224px");
    const title = descendants(root).find((node) => attr(node, "class") === "theme-picker__title");
    expect(title && text(title)).toBe("Work theme");
  });

  test("ten swatches in SPACE_HUES order, labelled, colored through --swatch", () => {
    const swatches = all(render(TEAL), "theme-swatch");
    expect(swatches.map((s) => attr(s, "data-hue"))).toEqual([...SPACE_HUES]);
    swatches.forEach((swatch, index) => {
      const hue = SPACE_HUES[index]!;
      expect(attr(swatch, "aria-label")).toBe(HUE_DEFINITIONS[hue].label);
      expect(attr(swatch, "title")).toBe(HUE_DEFINITIONS[hue].label);
      expect(attr(swatch, "style")).toBe(`--swatch:${hueSwatchColor(hue)}`);
    });
  });

  test("aria-pressed marks the selected hue and the solid kind", () => {
    const doc = render(TEAL);
    const pressed = all(doc, "theme-swatch").filter((s) => attr(s, "aria-pressed") === "true");
    expect(pressed.map((s) => attr(s, "data-hue"))).toEqual(["teal"]);
    expect(attr(one(doc, "theme-kind-solid"), "aria-pressed")).toBe("true");
    expect(attr(one(doc, "theme-kind-gradient"), "aria-pressed")).toBe("false");
    expect(attr(one(doc, "theme-intensity"), "value")).toBe("60");
    expect(text(one(doc, "theme-intensity-value"))).toBe("60%");
  });

  test("a null draft shows Solid pressed, no swatch pressed and the slider at 0", () => {
    const doc = render(null);
    expect(attr(one(doc, "theme-kind-solid"), "aria-pressed")).toBe("true");
    expect(all(doc, "theme-swatch").filter((s) => attr(s, "aria-pressed") === "true")).toEqual([]);
    const slider = one(doc, "theme-intensity");
    expect(attr(slider, "value")).toBe("0");
    expect(attr(slider, "min")).toBe("0");
    expect(attr(slider, "max")).toBe("100");
    expect(attr(slider, "step")).toBe("5");
    expect(text(one(doc, "theme-intensity-value"))).toBe("0%");
  });

  test("the stop segment shows only for two stops", () => {
    expect(all(render(TEAL), "theme-stop")).toEqual([]);
    expect(all(render(null), "theme-stop")).toEqual([]);
    const doc = render(GRADIENT);
    const stops = all(doc, "theme-stop");
    expect(stops.map((s) => attr(s, "data-stop-index"))).toEqual(["0", "1"]);
    expect(stops.map((s) => text(s))).toEqual(["Color 1", "Color 2"]);
    expect(attr(stops[0]!, "aria-pressed")).toBe("true");
    expect(stops[0]!.parent && attr(stops[0]!.parent, "aria-label")).toBe("Gradient stop");
    expect(attr(one(doc, "theme-kind-gradient"), "aria-pressed")).toBe("true");
  });

  test.each([TEAL, GRADIENT, null])("contrast chips report themeReport for %j", (theme) => {
    const chips = all(render(theme), "theme-contrast");
    expect(chips.map((c) => attr(c, "data-appearance"))).toEqual(["light", "dark"]);
    chips.forEach((chip) => {
      const appearance = attr(chip, "data-appearance") as Appearance;
      const report = themeReport(theme, appearance);
      expect(attr(chip, "data-ink-contrast")).toBe(report.inkContrast.toFixed(2));
      expect(attr(chip, "data-secondary-contrast")).toBe(report.inkSecondaryContrast.toFixed(2));
      const name = appearance === "light" ? "Light" : "Dark";
      expect(attr(chip, "aria-label")).toBe(
        `${name}: text ${report.inkContrast.toFixed(1)} to 1, secondary ${report.inkSecondaryContrast.toFixed(1)} to 1`,
      );
    });
  });

  test("aria-label reads e.g. 'Light: text 12.8 to 1, secondary 5.1 to 1'", () => {
    const [light] = all(render(TEAL), "theme-contrast");
    expect(attr(light!, "aria-label")).toMatch(
      /^Light: text \d+\.\d to 1, secondary \d+\.\d to 1$/,
    );
  });

  test("gradient grounds reach the chip as a 160deg gradient custom property", () => {
    const [light] = all(render(GRADIENT), "theme-contrast");
    const style = attr(light!, "style") ?? "";
    expect(style).toMatch(
      /--chip-ground:(linear-gradient\(160deg, #[0-9a-f]{6}, #[0-9a-f]{6}\)|#[0-9a-f]{6})/,
    );
    expect(style).toMatch(/--chip-ink:#[0-9a-f]{6}/);
    expect(style).toMatch(/--chip-ink-secondary:#[0-9a-f]{6}/);
  });

  test("the intensity value is aria-live=off so it isn't announced twice per step", () => {
    expect(attr(one(render(TEAL), "theme-intensity-value"), "aria-live")).toBe("off");
  });

  test("the picker title carries a matching title attribute for truncated names", () => {
    const root = one(render(TEAL), "theme-picker");
    const title = descendants(root).find((node) => attr(node, "class") === "theme-picker__title");
    expect(title && attr(title, "title")).toBe("Work theme");
  });

  test("the swatch grid is a labelled group: 'Color' for solid, 'Color N' for the selected gradient stop", () => {
    const solidSwatches = one(render(TEAL), "theme-swatch").parent!;
    expect(attr(solidSwatches, "role")).toBe("group");
    expect(attr(solidSwatches, "aria-label")).toBe("Color");

    const gradientSwatches = one(render(GRADIENT), "theme-swatch").parent!;
    expect(attr(gradientSwatches, "role")).toBe("group");
    // Stop 0 is selected on initial render of a two-stop theme.
    expect(attr(gradientSwatches, "aria-label")).toBe("Color 1");
  });

  test("roving tabindex: only the pressed swatch is tabbable, the rest are -1", () => {
    const swatches = all(render(TEAL), "theme-swatch");
    const tabbable = swatches.filter((s) => attr(s, "tabindex") === "0");
    expect(tabbable.map((s) => attr(s, "data-hue"))).toEqual(["teal"]);
    for (const s of swatches) {
      if (attr(s, "data-hue") !== "teal") {
        expect(attr(s, "tabindex")).toBe("-1");
      }
    }
  });

  test("roving tabindex: with no pressed swatch (null draft), the first swatch is tabbable", () => {
    const swatches = all(render(null), "theme-swatch");
    expect(attr(swatches[0]!, "tabindex")).toBe("0");
    for (const s of swatches.slice(1)) {
      expect(attr(s, "tabindex")).toBe("-1");
    }
  });
});

const IRIS: SpaceTheme = { stops: ["iris"], intensity: 1 };
const ROSE: SpaceTheme = { stops: ["rose"], intensity: 1 };
const AMBER: SpaceTheme = { stops: ["amber"], intensity: 1 };

describe("isOwnThemeEcho", () => {
  test("a broadcast equal to the current draft is an echo", () => {
    expect(isOwnThemeEcho(IRIS, IRIS, [])).toBe(true);
  });

  test("a broadcast equal to any theme sent since the last external change is an echo, regardless of order", () => {
    // Sent A then B; A's own echo already consumed elsewhere, but A is STILL
    // in the sent-since-external record, so a broadcast carrying A (e.g. an
    // out-of-order resend) must not be treated as external and rewind the
    // draft away from B.
    expect(isOwnThemeEcho(ROSE, AMBER, [ROSE, AMBER])).toBe(true);
    expect(isOwnThemeEcho(AMBER, AMBER, [ROSE, AMBER])).toBe(true);
  });

  test("a broadcast matching none of the sent themes nor the draft is external", () => {
    expect(isOwnThemeEcho(AMBER, ROSE, [ROSE])).toBe(false);
  });

  test("a null broadcast is an echo only when the draft is already null", () => {
    expect(isOwnThemeEcho(null, null, [])).toBe(true);
    expect(isOwnThemeEcho(null, ROSE, [])).toBe(false);
  });
});
