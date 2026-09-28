import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { tokenBackground } from "./token";

// PRD 10.7 §7 — the hit-target audit. Every visible focus-ring-eligible control
// (the same `:where(...)` selector base.css keys its focus rule off) must
// measure at least `--hit-target` (28px) on each side of its
// `getBoundingClientRect()`. A radio or checkbox measures its enclosing
// `<label>` instead (the label is the actual click/tap target), and the two
// pointer-only drag strips (the split divider and the sidebar resize handle)
// are exempt (PRD 10.7 §7's table).

/** Minimum hit-target size, in CSS px — mirrors `--hit-target` in tokens.css. */
const MIN_HIT_TARGET = 28;

/**
 * Controls §7's floor does not apply to. The two pointer-only drag strips are
 * §7's own named exemptions. `command-bar-input` and `find-input` are outside
 * "every §6 control" that §7's floor binds — §6's overlay row names only
 * find-previous/find-next/find-close, and its other rows never list either
 * input, so neither is a §6-covered control in the first place (they are not
 * exempted from an otherwise-applicable rule; the rule never applies to them).
 */
const EXEMPT_TESTIDS = [
  "divider-handle",
  "sidebar-resize-handle",
  "command-bar-input",
  "find-input",
];

/** The same control universe base.css's focus-ring rule targets (PRD 10.7 §6). */
const SELECTOR =
  'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

interface HitTargetFailure {
  name: string;
  width: number;
  height: number;
}

// A stable identifier for a probed element -- its `data-testid` (quoted as an
// attribute selector) when present, else a dotted class selector, else its
// tag name -- is computed by an inline `identify()` inside each
// `page.evaluate()` below (a page.evaluate callback is serialized and runs in
// the browser context, so it cannot close over a module-scope helper). Both
// sweeps use the identical format, so a caller can pass the same identifier
// in a required-coverage list to either helper.

/**
 * Fails with the names of any `requiredIds` that `covered` (the set of
 * identifiers a sweep actually measured or focused) does not contain, plus
 * the names skipped as disabled, so a caller never has to guess why a control
 * silently dropped out of a sweep. A no-op when `requiredIds` is omitted.
 */
function assertCoverage(
  auditName: string,
  covered: Set<string>,
  skippedDisabled: Set<string>,
  requiredIds: readonly string[] | undefined,
): void {
  if (requiredIds === undefined) return;
  const missing = requiredIds.filter((id) => !covered.has(id));
  if (missing.length > 0) {
    const detail = missing
      .map((id) => (skippedDisabled.has(id) ? `${id} (skipped: disabled)` : `${id} (not found)`))
      .join(", ");
    throw new Error(`${auditName}: required control(s) not covered: ${detail}`);
  }
}

/**
 * Asserts that every visible control on `page` measures at least 28 × 28 px,
 * per PRD 10.7 §7. Disabled controls ARE measured (their size does not depend
 * on `disabled`, and §7 binds "every §6 control", not just the enabled ones) —
 * only invisible controls (zero-size, `display: none`, `visibility: hidden`,
 * or hidden through an ANCESTOR's opacity/visibility via `checkVisibility`)
 * are skipped — a control's own resting `opacity: 0` does not disqualify it,
 * since the shared hover/`:focus-within`-reveal pattern (`archived-delete`,
 * `.tab-item__close`) is `opacity: 0` at rest by design. Radio/checkbox
 * inputs are measured via their enclosing `<label>`.
 * Throws one `Error` naming every failing control (its `data-testid`, or else
 * its class list) and its measured size. When `requiredIds` is given, also
 * throws if any of those identifiers (the same format `identify()` above computes) were never
 * found/measured, so a coverage regression in a test's own setup — not just a
 * CSS regression — fails loudly. Returns the set of identifiers measured.
 */
export async function assertHitTargets(
  page: Page,
  requiredIds?: readonly string[],
): Promise<Set<string>> {
  const result: { failures: HitTargetFailure[]; measured: string[] } = await page.evaluate(
    ({ selector, minSize, exemptTestIds }) => {
      // A control (archived-delete, .tab-item__close) can legitimately be
      // `opacity: 0` AT REST and only reach `opacity: 1` on `:hover` /
      // `:focus-within` — that is the shared hover-reveal pattern several §6
      // rows use, not the element being closed/hidden. So opacity is checked
      // on the element's ANCESTORS (a genuinely closed panel, e.g. a
      // `[data-motion="closed"]` container, hides its children that way) but
      // never on the element's own resting opacity.
      function isVisible(el: Element): boolean {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") return false;
        const ancestor = el.parentElement as
          | (Element & {
              checkVisibility?: (opts: {
                opacityProperty?: boolean;
                visibilityProperty?: boolean;
              }) => boolean;
            })
          | null;
        if (
          ancestor !== null &&
          typeof ancestor.checkVisibility === "function" &&
          !ancestor.checkVisibility({ opacityProperty: true, visibilityProperty: true })
        ) {
          return false;
        }
        return true;
      }

      function identify(el: Element): string {
        const testid = el.getAttribute("data-testid");
        if (testid !== null) return `[data-testid="${testid}"]`;
        const className = typeof el.className === "string" ? el.className.trim() : "";
        if (className !== "") return `.${className.split(/\s+/).join(".")}`;
        return el.tagName.toLowerCase();
      }

      const failures: HitTargetFailure[] = [];
      const measured: string[] = [];
      const elements = Array.from(document.querySelectorAll(selector));
      for (const el of elements) {
        const testid = el.getAttribute("data-testid");
        if (testid !== null && exemptTestIds.includes(testid)) continue;
        if (!isVisible(el)) continue;

        const id = identify(el);
        let measuredEl: Element = el;
        let label = id;
        if (
          el instanceof HTMLInputElement &&
          (el.type === "radio" || el.type === "checkbox")
        ) {
          const enclosing = el.closest("label");
          if (enclosing !== null) {
            measuredEl = enclosing;
            label = `${id} (label)`;
          }
        }

        measured.push(id);
        const rect = measuredEl.getBoundingClientRect();
        if (rect.width < minSize || rect.height < minSize) {
          failures.push({ name: label, width: rect.width, height: rect.height });
        }
      }
      return { failures, measured };
    },
    { selector: SELECTOR, minSize: MIN_HIT_TARGET, exemptTestIds: EXEMPT_TESTIDS },
  );

  if (result.failures.length > 0) {
    const message = result.failures
      .map((f) => `${f.name} measured ${f.width.toFixed(1)}×${f.height.toFixed(1)}px`)
      .join("; ");
    throw new Error(`hit-target audit (PRD 10.7 §7): ${message}`);
  }

  const measured = new Set(result.measured);
  assertCoverage("hit-target audit (PRD 10.7 §7)", measured, new Set(), requiredIds);
  return measured;
}

/** The exempt inputs whose `outline: none` PRD 10.7 §6 keeps. */
const FOCUS_EXEMPT_TESTIDS = ["command-bar-input", "find-input"];

/**
 * Sweeps every visible, non-exempt control on `page` matching the same
 * `:where(...)` universe base.css's focus-ring rule targets, focusing each one
 * directly with `el.focus({ focusVisible: true })` rather than a real Tab-key
 * walk: under xvfb a WebContentsView-hosted page can fail to take keyboard
 * focus at all (a known flake noted for this PRD), so a per-control synthetic
 * focus is the reliable fallback (§10 also wants a real Tab-key smoke test —
 * see `assertFocusRingsByTab` below — this helper is the documented xvfb
 * fallback, not a replacement for it). Every focused control's computed
 * outline must be the 2px solid `--focus-ring` ring, offset 1px (PRD 10.7
 * §6). A disabled control cannot take focus at all (browsers refuse it), so it
 * is recorded as skipped rather than silently dropped — pass `requiredIds` to
 * fail the sweep when a required control turns out to have been skipped this
 * way (or never found), instead of a coverage gap passing silently. Returns
 * the set of identifiers actually focused and checked.
 */
export async function assertFocusRings(
  page: Page,
  requiredIds?: readonly string[],
): Promise<Set<string>> {
  const focusRing = await tokenBackground(page, "--focus-ring");
  const probes: { index: number; label: string; disabled: boolean }[] = await page.evaluate(
    (exempt) => {
      const selector =
        'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
      // See assertHitTargets's isVisible: ancestor opacity/visibility is
      // checked, never the element's own resting opacity, so a hover/focus
      // -reveal control (archived-delete, .tab-item__close) stays probeable —
      // focusing it below satisfies :focus-within and reveals it for real.
      function isVisible(el: Element): boolean {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") return false;
        const ancestor = el.parentElement as
          | (Element & {
              checkVisibility?: (opts: {
                opacityProperty?: boolean;
                visibilityProperty?: boolean;
              }) => boolean;
            })
          | null;
        if (
          ancestor !== null &&
          typeof ancestor.checkVisibility === "function" &&
          !ancestor.checkVisibility({ opacityProperty: true, visibilityProperty: true })
        ) {
          return false;
        }
        return true;
      }
      function identify(el: Element): string {
        const testid = el.getAttribute("data-testid");
        if (testid !== null) return `[data-testid="${testid}"]`;
        const className = typeof el.className === "string" ? el.className.trim() : "";
        if (className !== "") return `.${className.split(/\s+/).join(".")}`;
        return el.tagName.toLowerCase();
      }
      const out: { index: number; label: string; disabled: boolean }[] = [];
      let i = 0;
      for (const el of Array.from(document.querySelectorAll(selector))) {
        const testid = el.getAttribute("data-testid");
        if (testid !== null && exempt.includes(testid)) continue;
        if (!isVisible(el)) continue;
        const disabled = (el as HTMLButtonElement | HTMLInputElement).disabled === true;
        el.setAttribute("data-zeo-focus-probe", String(i));
        out.push({ index: i, label: identify(el), disabled });
        i += 1;
      }
      return out;
    },
    FOCUS_EXEMPT_TESTIDS,
  );

  const checked = new Set<string>();
  const skippedDisabled = new Set<string>();

  for (const probe of probes) {
    const locator = page.locator(`[data-zeo-focus-probe="${probe.index}"]`);
    if (probe.disabled) {
      // A disabled control cannot receive focus at all — record it rather
      // than silently dropping it from the sweep.
      skippedDisabled.add(probe.label);
      continue;
    }
    await locator.evaluate((el) => {
      const target = el as HTMLElement;
      // Blur first: a prior real click (e.g. selecting a settings section)
      // can leave `target` already the active element WITHOUT focus-visible,
      // and re-focusing an already-focused element is a no-op in the DOM
      // focus model — no new focus transition, so `focusVisible: true` would
      // never take effect. Blurring guarantees the next focus() is a genuine
      // transition.
      target.blur();
      target.focus({ focusVisible: true } as unknown as FocusOptions);
    });
    const style = await locator.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        outlineStyle: s.outlineStyle,
        outlineWidth: s.outlineWidth,
        outlineOffset: s.outlineOffset,
        outlineColor: s.outlineColor,
      };
    });
    expect(style, `focus ring on ${probe.label}`).toEqual({
      outlineStyle: "solid",
      outlineWidth: "2px",
      outlineOffset: "1px",
      outlineColor: focusRing,
    });
    checked.add(probe.label);
  }

  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll("[data-zeo-focus-probe]"))) {
      el.removeAttribute("data-zeo-focus-probe");
    }
  });

  assertCoverage("focus-ring audit (PRD 10.7 §6)", checked, skippedDisabled, requiredIds);
  return checked;
}

/**
 * The identifier of `document.activeElement` on `page`, in the same format
 * `identify()` uses everywhere else in this module (its own inline copy — a
 * `page.evaluate()` callback is serialized and cannot close over a
 * module-scope helper). `null` when nothing but the document body has focus.
 */
async function activeElementLabel(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    function identify(el: Element): string {
      const testid = el.getAttribute("data-testid");
      if (testid !== null) return `[data-testid="${testid}"]`;
      const className = typeof el.className === "string" ? el.className.trim() : "";
      if (className !== "") return `.${className.split(/\s+/).join(".")}`;
      return el.tagName.toLowerCase();
    }
    const active = document.activeElement;
    if (active === null || active === document.body) return null;
    return identify(active);
  });
}

/**
 * The real Tab-key smoke test PRD 10.7 §10 asks for: presses Tab up to
 * `maxSteps` times starting from `page`'s current focus (the "seed", whatever
 * the caller already focused before calling this), and for every distinct
 * element that becomes `document.activeElement` AFTER a Tab press, asserts it
 * shows the same 2px solid `--focus-ring` ring §6 requires (skipping the two
 * exempt inputs). Stops early once focus cycles back to an element already
 * seen (the seed counts as already seen, so a Tab walk that wraps all the way
 * around stops there too).
 *
 * The seed itself is recorded (via `document.activeElement`) BEFORE the first
 * Tab and is never counted as visited: a caller focuses the seed only to give
 * the walk a known starting point, and never presses Tab to reach it, so
 * crediting it as "visited" would let a Tab key that does nothing at all
 * (e.g. a listener that `preventDefault`s it) pass vacuously — the seed would
 * still show up as the sole "visited" entry. The first Tab press is also
 * required to actually move focus away from the seed; if it does not, this
 * throws immediately rather than silently returning an empty/seed-only set.
 *
 * Returns the identifiers of every element Tab actually moved focus to (never
 * including the seed), so a caller can assert the walk reached specific next
 * stops in DOM tab order — asserting only a non-empty set is exactly the
 * vacuous check this helper is designed not to allow.
 *
 * This is a genuine `keyboard.press("Tab")` walk, not the synthetic
 * `el.focus({ focusVisible: true })` sweep `assertFocusRings` uses: under
 * xvfb a WebContentsView-hosted page can fail to take keyboard focus at all,
 * so real Tab is exercised here as the documented §10 smoke test, and
 * `assertFocusRings` remains the reliable fallback for full-page coverage.
 */
export async function assertFocusRingsByTab(
  page: Page,
  maxSteps: number = 40,
): Promise<Set<string>> {
  const focusRing = await tokenBackground(page, "--focus-ring");
  const seedLabel = await activeElementLabel(page);
  const visited = new Set<string>(seedLabel !== null ? [seedLabel] : []);
  const order: string[] = [];

  for (let step = 0; step < maxSteps; step += 1) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate((exempt) => {
      function identify(el: Element): string {
        const testid = el.getAttribute("data-testid");
        if (testid !== null) return `[data-testid="${testid}"]`;
        const className = typeof el.className === "string" ? el.className.trim() : "";
        if (className !== "") return `.${className.split(/\s+/).join(".")}`;
        return el.tagName.toLowerCase();
      }
      const active = document.activeElement;
      if (active === null || active === document.body) return null;
      const testid = active.getAttribute("data-testid");
      if (testid !== null && exempt.includes(testid)) return { exempt: true, label: identify(active) };
      const s = getComputedStyle(active);
      return {
        exempt: false,
        label: identify(active),
        outlineStyle: s.outlineStyle,
        outlineWidth: s.outlineWidth,
        outlineOffset: s.outlineOffset,
        outlineColor: s.outlineColor,
      };
    }, FOCUS_EXEMPT_TESTIDS);

    if (step === 0) {
      const firstLabel = info === null ? null : info.label;
      if (firstLabel === seedLabel) {
        throw new Error(
          `Tab-key smoke test: the first Tab press left focus on the seed control` +
            `${seedLabel !== null ? ` (${seedLabel})` : ""} instead of moving it — Tab did not move focus`,
        );
      }
    }

    if (info === null) continue;
    if (info.exempt === true) {
      if (visited.has(info.label)) break;
      visited.add(info.label);
      order.push(info.label);
      continue;
    }
    if (visited.has(info.label)) break;
    visited.add(info.label);
    order.push(info.label);
    expect(
      {
        outlineStyle: info.outlineStyle,
        outlineWidth: info.outlineWidth,
        outlineOffset: info.outlineOffset,
        outlineColor: info.outlineColor,
      },
      `Tab-focus ring on ${info.label}`,
    ).toEqual({
      outlineStyle: "solid",
      outlineWidth: "2px",
      outlineOffset: "1px",
      outlineColor: focusRing,
    });
  }

  return new Set(order);
}
