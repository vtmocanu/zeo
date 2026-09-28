import type { Page } from "@playwright/test";

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
 * §7's own named exemptions. `command-bar-input` and `find-input` are not
 * exempted from the floor by name — they are simply never listed as a §6
 * "control covered" on any surface (§6's overlay row names only
 * find-previous/find-next/find-close), so they are outside "every §6
 * control" that §7's floor binds.
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

/**
 * Asserts that every visible, non-exempt control on `page` measures at least
 * 28 × 28 px, per PRD 10.7 §7. Radio/checkbox inputs are measured via their
 * enclosing `<label>`. Throws one `Error` naming every failing control (its
 * `data-testid`, or else its class list) and its measured size, so a caller
 * never has to guess which control regressed.
 */
export async function assertHitTargets(page: Page): Promise<void> {
  const failures: HitTargetFailure[] = await page.evaluate(
    ({ selector, minSize, exemptTestIds }) => {
      function isVisible(el: Element): boolean {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") return false;
        if (parseFloat(style.opacity) === 0) return false;
        return true;
      }

      const out: HitTargetFailure[] = [];
      const elements = Array.from(document.querySelectorAll(selector));
      for (const el of elements) {
        const testid = el.getAttribute("data-testid");
        if (testid !== null && exemptTestIds.includes(testid)) continue;
        if (!isVisible(el)) continue;

        // A disabled control is not an interactive hit target.
        if ((el as HTMLButtonElement | HTMLInputElement).disabled === true) continue;

        let measured: Element = el;
        if (
          el instanceof HTMLInputElement &&
          (el.type === "radio" || el.type === "checkbox")
        ) {
          const label = el.closest("label");
          if (label !== null) measured = label;
        }

        const rect = measured.getBoundingClientRect();
        if (rect.width < minSize || rect.height < minSize) {
          const name =
            testid !== null
              ? `[data-testid="${testid}"]`
              : measured.className !== ""
                ? `.${String(measured.className).trim().split(/\s+/).join(".")}`
                : measured.tagName.toLowerCase();
          out.push({ name, width: rect.width, height: rect.height });
        }
      }
      return out;
    },
    { selector: SELECTOR, minSize: MIN_HIT_TARGET, exemptTestIds: EXEMPT_TESTIDS },
  );

  if (failures.length > 0) {
    const message = failures
      .map((f) => `${f.name} measured ${f.width.toFixed(1)}×${f.height.toFixed(1)}px`)
      .join("; ");
    throw new Error(`hit-target audit (PRD 10.7 §7): ${message}`);
  }
}
