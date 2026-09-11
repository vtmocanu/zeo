import { describe, expect, test } from "vitest";
import {
  DOWNLOADS_CAP,
  clearFinishedDownloads,
  downloadDetail,
  isActive,
  isFinished,
  removeDownload,
  safeFilename,
  stripUrlCredentials,
  uniqueFilename,
  upsertDownload,
} from "./downloads.js";
import type { Download, DownloadsState } from "./downloads.js";

/** A minimal download record with sensible, overridable defaults. */
function download(over: Partial<Download> & { id: string }): Download {
  return {
    url: "https://example.test/file.bin",
    filename: "file.bin",
    path: "/downloads/file.bin",
    totalBytes: 0,
    receivedBytes: 0,
    state: "progressing",
    startedAt: 0,
    completedAt: null,
    spaceId: null,
    ...over,
  };
}

describe("upsertDownload", () => {
  test("inserts an item newest first by startedAt descending", () => {
    let state: DownloadsState = { items: [] };
    state = upsertDownload(state, download({ id: "a", startedAt: 1 }));
    state = upsertDownload(state, download({ id: "b", startedAt: 3 }));
    state = upsertDownload(state, download({ id: "c", startedAt: 2 }));
    expect(state.items.map((d) => d.id)).toEqual(["b", "c", "a"]);
  });

  test("does not mutate its input", () => {
    const state: DownloadsState = { items: [download({ id: "a", startedAt: 1 })] };
    const next = upsertDownload(state, download({ id: "b", startedAt: 2 }));
    expect(state.items.map((d) => d.id)).toEqual(["a"]);
    expect(next).not.toBe(state);
    expect(next.items).not.toBe(state.items);
  });

  test("updates an existing item in place without reordering", () => {
    let state: DownloadsState = { items: [] };
    state = upsertDownload(state, download({ id: "a", startedAt: 1 }));
    state = upsertDownload(state, download({ id: "b", startedAt: 2 }));
    state = upsertDownload(state, download({ id: "c", startedAt: 3 }));
    expect(state.items.map((d) => d.id)).toEqual(["c", "b", "a"]);
    // Update `b`'s received bytes; startedAt and id are immutable, so position holds.
    state = upsertDownload(
      state,
      download({ id: "b", startedAt: 2, receivedBytes: 500 }),
    );
    expect(state.items.map((d) => d.id)).toEqual(["c", "b", "a"]);
    expect(state.items.find((d) => d.id === "b")?.receivedBytes).toBe(500);
  });

  test("orders the higher id first on an equal startedAt (id desc tie-break)", () => {
    let state: DownloadsState = { items: [] };
    state = upsertDownload(state, download({ id: "a", startedAt: 5 }));
    state = upsertDownload(state, download({ id: "c", startedAt: 5 }));
    state = upsertDownload(state, download({ id: "b", startedAt: 5 }));
    expect(state.items.map((d) => d.id)).toEqual(["c", "b", "a"]);
  });

  test("enforces the 100 cap by dropping the oldest entry", () => {
    let state: DownloadsState = { items: [] };
    for (let i = 0; i < DOWNLOADS_CAP; i += 1) {
      state = upsertDownload(state, download({ id: `d${i}`, startedAt: i }));
    }
    expect(state.items).toHaveLength(DOWNLOADS_CAP);
    // The oldest (startedAt 0) is the last in the order.
    expect(state.items[state.items.length - 1]?.startedAt).toBe(0);
    // A newer insert pushes past the cap; the oldest is dropped.
    state = upsertDownload(state, download({ id: "newest", startedAt: 1000 }));
    expect(state.items).toHaveLength(DOWNLOADS_CAP);
    expect(state.items[0]?.id).toBe("newest");
    expect(state.items.some((d) => d.startedAt === 0)).toBe(false);
  });
});

describe("removeDownload", () => {
  test("drops the item with the matching id", () => {
    const state: DownloadsState = {
      items: [download({ id: "a" }), download({ id: "b" }), download({ id: "c" })],
    };
    const next = removeDownload(state, "b");
    expect(next.items.map((d) => d.id)).toEqual(["a", "c"]);
  });

  test("is a no-op on a missing id (equal item set)", () => {
    const state: DownloadsState = {
      items: [download({ id: "a" }), download({ id: "b" })],
    };
    const next = removeDownload(state, "missing");
    expect(next.items.map((d) => d.id)).toEqual(["a", "b"]);
  });
});

describe("clearFinishedDownloads", () => {
  test("keeps active and drops finished, order preserved", () => {
    const state: DownloadsState = {
      items: [
        download({ id: "a", startedAt: 4, state: "progressing" }),
        download({ id: "b", startedAt: 3, state: "completed", completedAt: 10 }),
        download({ id: "c", startedAt: 2, state: "paused" }),
        download({ id: "d", startedAt: 1, state: "cancelled", completedAt: 11 }),
      ],
    };
    const next = clearFinishedDownloads(state);
    expect(next.items.map((d) => d.id)).toEqual(["a", "c"]);
  });

  test("returns the state unchanged when nothing is finished", () => {
    const state: DownloadsState = {
      items: [
        download({ id: "a", state: "progressing" }),
        download({ id: "b", state: "paused" }),
      ],
    };
    expect(clearFinishedDownloads(state)).toBe(state);
  });
});

describe("isFinished / isActive", () => {
  test("partition the five states", () => {
    expect(isFinished(download({ id: "a", state: "completed" }))).toBe(true);
    expect(isFinished(download({ id: "a", state: "cancelled" }))).toBe(true);
    expect(isFinished(download({ id: "a", state: "interrupted" }))).toBe(true);
    expect(isFinished(download({ id: "a", state: "progressing" }))).toBe(false);
    expect(isFinished(download({ id: "a", state: "paused" }))).toBe(false);
    expect(isActive(download({ id: "a", state: "progressing" }))).toBe(true);
    expect(isActive(download({ id: "a", state: "paused" }))).toBe(true);
    expect(isActive(download({ id: "a", state: "completed" }))).toBe(false);
  });
});

describe("uniqueFilename", () => {
  test("returns the name when it is free", () => {
    expect(uniqueFilename("report.bin", () => false)).toBe("report.bin");
  });

  test("appends an incrementing suffix on successive clashes", () => {
    const taken = new Set(["report.bin"]);
    const first = uniqueFilename("report.bin", (c) => taken.has(c));
    expect(first).toBe("report (1).bin");
    taken.add(first);
    const second = uniqueFilename("report.bin", (c) => taken.has(c));
    expect(second).toBe("report (2).bin");
  });

  test("splits a multi-dot name at the final dot only", () => {
    const taken = new Set(["archive.tar.gz"]);
    expect(uniqueFilename("archive.tar.gz", (c) => taken.has(c))).toBe(
      "archive.tar (1).gz",
    );
  });

  test("treats a leading-dot name as an empty extension", () => {
    const taken = new Set([".gitignore"]);
    expect(uniqueFilename(".gitignore", (c) => taken.has(c))).toBe(
      ".gitignore (1)",
    );
  });

  test("treats a dotless name as an empty extension", () => {
    const taken = new Set(["README"]);
    expect(uniqueFilename("README", (c) => taken.has(c))).toBe("README (1)");
  });
});

describe("safeFilename", () => {
  test("strips a path prefix to the basename", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("C:\\Windows\\system32\\evil.exe")).toBe("evil.exe");
  });

  test("removes NUL and other control characters", () => {
    expect(safeFilename("re\u0000port\u001f.bin\u007f")).toBe("report.bin");
  });

  test("maps empty, whitespace-only, '.' and '..' to the default name", () => {
    expect(safeFilename("")).toBe("download");
    expect(safeFilename("   ")).toBe("download");
    expect(safeFilename(".")).toBe("download");
    expect(safeFilename("..")).toBe("download");
  });

  test("trims trailing dots and spaces", () => {
    expect(safeFilename("report.bin. ")).toBe("report.bin");
  });

  test("neutralizes a bare platform-reserved name", () => {
    expect(safeFilename("CON")).toBe("_CON");
    expect(safeFilename("nul.txt")).toBe("_nul.txt");
    expect(safeFilename("COM9")).toBe("_COM9");
  });

  test("passes an ordinary name through unchanged", () => {
    expect(safeFilename("report.bin")).toBe("report.bin");
  });
});

describe("stripUrlCredentials", () => {
  test("removes the userinfo component, retaining query and fragment", () => {
    expect(stripUrlCredentials("https://u:p@host/f?q#h")).toBe(
      "https://host/f?q#h",
    );
  });

  test("returns a non-URL input unchanged", () => {
    expect(stripUrlCredentials("not a url")).toBe("not a url");
  });

  test("leaves a credential-free url intact", () => {
    expect(stripUrlCredentials("https://host/f?q#h")).toBe("https://host/f?q#h");
  });
});

describe("downloadDetail", () => {
  test("shows received / total with a percentage for an active download", () => {
    const detail = downloadDetail(
      download({
        id: "a",
        state: "progressing",
        receivedBytes: 3 * 1024 * 1024,
        totalBytes: 10 * 1024 * 1024,
      }),
    );
    expect(detail).toBe("3.0 MB / 10.0 MB (30%)");
  });

  test("shows just the received size when the total is unknown", () => {
    const detail = downloadDetail(
      download({
        id: "a",
        state: "progressing",
        receivedBytes: 1_258_291,
        totalBytes: 0,
      }),
    );
    expect(detail).toBe("1.2 MB");
  });

  test("shows the final size and a label for a finished download", () => {
    expect(
      downloadDetail(
        download({
          id: "a",
          state: "completed",
          completedAt: 1,
          receivedBytes: 4_194_304,
          totalBytes: 4_194_304,
        }),
      ),
    ).toBe("4.0 MB · Completed");
  });

  test("shows just the state label for a finished download with no bytes", () => {
    expect(
      downloadDetail(
        download({ id: "a", state: "cancelled", completedAt: 1, receivedBytes: 0 }),
      ),
    ).toBe("Cancelled");
  });
});
