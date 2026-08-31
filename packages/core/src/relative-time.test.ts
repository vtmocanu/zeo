import { describe, expect, test } from "vitest";
import { formatRelativeArchived } from "./relative-time.js";

describe("formatRelativeArchived", () => {
  test("a zero delta is 'just now'", () => {
    expect(formatRelativeArchived(1000, 1000)).toBe("just now");
  });

  test("one ms under a minute is still 'just now'", () => {
    expect(formatRelativeArchived(0, 59_999)).toBe("just now");
  });

  test("exactly one minute crosses into the minutes bucket", () => {
    expect(formatRelativeArchived(0, 60_000)).toBe("1m ago");
  });

  test("one ms under an hour is the top of the minutes bucket", () => {
    expect(formatRelativeArchived(0, 3_599_999)).toBe("59m ago");
  });

  test("exactly one hour crosses into the hours bucket", () => {
    expect(formatRelativeArchived(0, 3_600_000)).toBe("1h ago");
  });

  test("exactly one day crosses into the days bucket", () => {
    expect(formatRelativeArchived(0, 86_400_000)).toBe("1d ago");
  });

  test("a multi-day delta floors to whole days", () => {
    // 3 days plus a few hours -> 3d ago.
    expect(formatRelativeArchived(0, 3 * 86_400_000 + 5 * 3_600_000)).toBe(
      "3d ago",
    );
  });

  test("now earlier than archivedAt clamps to 'just now'", () => {
    expect(formatRelativeArchived(5000, 1000)).toBe("just now");
  });
});
