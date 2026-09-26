import { describe, expect, test } from "vitest";
import { parseChangelogSection } from "./release.js";

const CHANGELOG = `# Changelog

## [Unreleased]

Nothing yet.

## [1.2.0] - 2026-03-15

### Added
- Something new.

### Fixed
- A bug.

## [1.1.0] - 2026-01-01

Earlier notes.
`;

describe("parseChangelogSection", () => {
  test("returns the section with date and trimmed body for a well-formed entry", () => {
    expect(parseChangelogSection(CHANGELOG, "1.2.0")).toEqual({
      version: "1.2.0",
      date: "2026-03-15",
      body: "### Added\n- Something new.\n\n### Fixed\n- A bug.",
    });
  });

  test("returns null when the version has no section", () => {
    expect(parseChangelogSection(CHANGELOG, "9.9.9")).toBeNull();
  });

  test("never returns the [Unreleased] heading", () => {
    expect(parseChangelogSection(CHANGELOG, "Unreleased")).toBeNull();
  });

  test("returns null when the date is not YYYY-MM-DD", () => {
    const markdown = `## [1.0.0] - March 15, 2026\n\nBody.\n`;
    expect(parseChangelogSection(markdown, "1.0.0")).toBeNull();
  });

  test("returns null for an invalid calendar date", () => {
    const markdown = `## [1.0.0] - 2026-02-30\n\nBody.\n`;
    expect(parseChangelogSection(markdown, "1.0.0")).toBeNull();
  });

  test("returns null when the body is empty or whitespace", () => {
    const markdown = `## [1.0.0] - 2026-02-01\n\n   \n\n## [0.9.0] - 2026-01-01\n\nOlder.\n`;
    expect(parseChangelogSection(markdown, "1.0.0")).toBeNull();
  });

  test("excludes the next version's notes from the body", () => {
    const result = parseChangelogSection(CHANGELOG, "1.1.0");
    expect(result).not.toBeNull();
    expect(result!.body).toBe("Earlier notes.");
    expect(result!.body).not.toContain("Something new");
  });

  test("treats version dots as literal characters, not regex wildcards", () => {
    const markdown = `## [0x0y2] - 2026-01-01\n\nBody.\n`;
    expect(parseChangelogSection(markdown, "0.0.2")).toBeNull();
  });

  test("does not match a longer version sharing the same prefix", () => {
    const markdown = `## [0.0.20] - 2026-01-01\n\nBody.\n`;
    expect(parseChangelogSection(markdown, "0.0.2")).toBeNull();
  });

  test("handles CRLF input", () => {
    const crlf = CHANGELOG.replace(/\n/g, "\r\n");
    expect(parseChangelogSection(crlf, "1.1.0")).toEqual({
      version: "1.1.0",
      date: "2026-01-01",
      body: "Earlier notes.",
    });
  });
});
