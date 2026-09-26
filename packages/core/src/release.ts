/**
 * Pure release helpers for the build tooling: extracting one version's dated
 * section from CHANGELOG markdown. `scripts/release-check.mjs` uses it as the
 * pre-tag changelog check and `scripts/changelog-section.mjs` prints the body
 * as the GitHub Release notes. Electron-free, so it is unit-tested here.
 */

/** One `## [<version>] - <date>` section of a CHANGELOG. */
export interface ChangelogSection {
  version: string;
  date: string; // ISO date, "YYYY-MM-DD"
  body: string; // section markdown below the heading, trimmed, non-empty
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `date` is `YYYY-MM-DD` AND a real calendar date. */
function isValidIsoDate(date: string): boolean {
  const match = ISO_DATE_RE.exec(date);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

/** Escapes `text` for literal use inside a `RegExp` pattern. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The `## [<version>] - <YYYY-MM-DD>` section for `version` from CHANGELOG
 * markdown, or null when that version has no section, the date is not a
 * valid ISO `YYYY-MM-DD`, or the body (up to the next `## ` heading) is
 * empty/whitespace. The `## [Unreleased]` heading (no date) never matches.
 */
export function parseChangelogSection(
  markdown: string,
  version: string,
): ChangelogSection | null {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const headingRe = new RegExp(
    `^## \\[${escapeRegExp(version)}\\] - (.+)$`,
  );

  let headingIndex = -1;
  let date = "";
  for (let i = 0; i < lines.length; i++) {
    const match = headingRe.exec(lines[i]!);
    if (match) {
      headingIndex = i;
      date = match[1]!.trim();
      break;
    }
  }

  if (headingIndex === -1 || !isValidIsoDate(date)) {
    return null;
  }

  const bodyLines: string[] = [];
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) {
      break;
    }
    bodyLines.push(lines[i]!);
  }
  const body = bodyLines.join("\n").trim();
  if (body === "") {
    return null;
  }

  return { version, date, body };
}
