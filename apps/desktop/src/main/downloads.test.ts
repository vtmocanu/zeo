import { describe, expect, test, vi } from "vitest";
import type { Download, DownloadsState } from "@zeo/core";
import {
  removeDownloadSequenced,
  applyDownloadEvent,
  createThrottledPersister,
  terminalizeProfileDownloads,
} from "./downloads.js";

/** Builds a {@link Download} with defaults, overridable per field. */
function makeDownload(overrides: Partial<Download> = {}): Download {
  return {
    id: "d1",
    url: "https://example.com/file.bin",
    filename: "file.bin",
    path: "/downloads/file.bin",
    totalBytes: 1000,
    receivedBytes: 0,
    state: "progressing",
    startedAt: 1000,
    completedAt: null,
    spaceId: null,
    ...overrides,
  };
}

describe("removeDownloadSequenced", () => {
  test("unknown id (absent from state and registry) is a no-op: no delete, no broadcast, resolves", async () => {
    let state: DownloadsState = { items: [] };
    const deleteRow = vi.fn();
    const broadcast = vi.fn();
    await removeDownloadSequenced("nope", {
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      deleteRow,
      downloadItems: new Map(),
      removedDownloadIds: new Set<string>(),
      broadcast,
    });
    expect(deleteRow).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(state.items).toEqual([]);
  });

  test("inactive record: a throwing deleteRow leaves the record, keeps the guard empty, never broadcasts, and rejects", async () => {
    const d = makeDownload({ id: "d1", state: "completed", completedAt: 5000 });
    let state: DownloadsState = { items: [d] };
    const removedDownloadIds = new Set<string>();
    const broadcast = vi.fn();
    await expect(
      removeDownloadSequenced("d1", {
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        deleteRow: () => {
          throw new Error("db fail");
        },
        downloadItems: new Map(),
        removedDownloadIds,
        broadcast,
      }),
    ).rejects.toThrow("db fail");
    // Record intact, guard empty, no broadcast: memory, disk, and guard stay consistent.
    expect(state.items).toEqual([d]);
    expect(removedDownloadIds.size).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  test("active record: a throwing deleteRow additionally does NOT cancel the live item and keeps the guard empty", async () => {
    const d = makeDownload({ id: "d1", state: "progressing" });
    let state: DownloadsState = { items: [d] };
    const cancel = vi.fn();
    const downloadItems = new Map([["d1", { item: { cancel }, profileId: "p1" }]]);
    const removedDownloadIds = new Set<string>();
    const broadcast = vi.fn();
    await expect(
      removeDownloadSequenced("d1", {
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        deleteRow: () => {
          throw new Error("db fail");
        },
        downloadItems,
        removedDownloadIds,
        broadcast,
      }),
    ).rejects.toThrow("db fail");
    expect(cancel).not.toHaveBeenCalled();
    expect(removedDownloadIds.size).toBe(0);
    expect(state.items).toEqual([d]);
    expect(downloadItems.has("d1")).toBe(true);
    expect(broadcast).not.toHaveBeenCalled();
  });

  test("success path: delete runs BEFORE removeDownload, and for an active id the guard is set BEFORE cancel", async () => {
    const d = makeDownload({ id: "d1", state: "progressing" });
    let state: DownloadsState = { items: [d] };
    const removedDownloadIds = new Set<string>();
    const order: string[] = [];
    const cancel = vi.fn(() => {
      order.push(`cancel(guard=${removedDownloadIds.has("d1")})`);
    });
    const downloadItems = new Map([["d1", { item: { cancel }, profileId: "p1" }]]);
    const broadcast = vi.fn(() => order.push("broadcast"));
    await removeDownloadSequenced("d1", {
      getState: () => state,
      setState: (next) => {
        state = next;
        order.push("removeDownload");
      },
      deleteRow: () => {
        order.push("deleteRow");
      },
      downloadItems,
      removedDownloadIds,
      broadcast,
    });
    // Commit-first, guard-before-cancel ordering.
    expect(order).toEqual([
      "deleteRow",
      "removeDownload",
      "cancel(guard=true)",
      "broadcast",
    ]);
    expect(state.items).toEqual([]);
    expect(removedDownloadIds.has("d1")).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("applyDownloadEvent", () => {
  test("applies a patch to a live progressing record and returns it", () => {
    const d = makeDownload({ id: "d1", state: "progressing", receivedBytes: 0 });
    let state: DownloadsState = { items: [d] };
    const result = applyDownloadEvent(
      "d1",
      { receivedBytes: 500 },
      {
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        removedDownloadIds: new Set<string>(),
      },
    );
    expect(result?.receivedBytes).toBe(500);
    expect(state.items[0]!.receivedBytes).toBe(500);
  });

  test("suppresses a removal-guarded id: returns null, mutates nothing", () => {
    const d = makeDownload({ id: "d1", state: "progressing" });
    let state: DownloadsState = { items: [d] };
    const result = applyDownloadEvent(
      "d1",
      { receivedBytes: 500 },
      {
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        removedDownloadIds: new Set<string>(["d1"]),
      },
    );
    expect(result).toBeNull();
    expect(state.items).toEqual([d]);
  });

  test("suppresses a late event on an already-finished record", () => {
    const d = makeDownload({ id: "d1", state: "completed", completedAt: 5000, receivedBytes: 1000 });
    let state: DownloadsState = { items: [d] };
    const result = applyDownloadEvent(
      "d1",
      { state: "progressing", receivedBytes: 1 },
      {
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        removedDownloadIds: new Set<string>(),
      },
    );
    expect(result).toBeNull();
    expect(state.items).toEqual([d]);
  });

  test("suppresses an event for an absent id", () => {
    let state: DownloadsState = { items: [] };
    const result = applyDownloadEvent(
      "gone",
      { receivedBytes: 1 },
      {
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        removedDownloadIds: new Set<string>(),
      },
    );
    expect(result).toBeNull();
  });
});

describe("terminalizeProfileDownloads", () => {
  test("no done delivered: an active record on the deleted profile becomes interrupted, persisted once, filename released once, item cancelled, registry entry dropped", () => {
    const d = makeDownload({ id: "d1", state: "progressing", filename: "f.bin", spaceId: "s1", receivedBytes: 10 });
    let state: DownloadsState = { items: [d] };
    const cancel = vi.fn();
    const downloadItems = new Map([["d1", { item: { cancel }, profileId: "p1" }]]);
    const updateRow = vi.fn();
    const releaseFilename = vi.fn();

    terminalizeProfileDownloads("p1", 7777, {
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      updateRow,
      downloadItems,
      releaseFilename,
    });

    expect(state.items[0]!.state).toBe("interrupted");
    expect(state.items[0]!.completedAt).toBe(7777);
    expect(updateRow).toHaveBeenCalledTimes(1);
    expect(updateRow.mock.calls[0]![0]).toMatchObject({
      id: "d1",
      state: "interrupted",
      completedAt: 7777,
    });
    expect(releaseFilename).toHaveBeenCalledTimes(1);
    expect(releaseFilename).toHaveBeenCalledWith("f.bin");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(downloadItems.has("d1")).toBe(false);
  });

  test("leaves registry entries for other profiles untouched", () => {
    const d = makeDownload({ id: "d1", state: "progressing" });
    let state: DownloadsState = { items: [d] };
    const cancel = vi.fn();
    const downloadItems = new Map([["d1", { item: { cancel }, profileId: "other" }]]);
    const updateRow = vi.fn();
    const releaseFilename = vi.fn();

    terminalizeProfileDownloads("p1", 7777, {
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      updateRow,
      downloadItems,
      releaseFilename,
    });

    expect(state.items[0]!.state).toBe("progressing");
    expect(cancel).not.toHaveBeenCalled();
    expect(updateRow).not.toHaveBeenCalled();
    expect(releaseFilename).not.toHaveBeenCalled();
    expect(downloadItems.has("d1")).toBe(true);
  });

  test("after terminalization, the cancel's late done is a no-op: no second release, no re-persist, stays interrupted", () => {
    const d = makeDownload({ id: "d1", state: "progressing", filename: "f.bin" });
    let state: DownloadsState = { items: [d] };
    const cancel = vi.fn();
    const downloadItems = new Map([["d1", { item: { cancel }, profileId: "p1" }]]);
    const updateRow = vi.fn();
    const releaseFilename = vi.fn();
    const removedDownloadIds = new Set<string>();

    terminalizeProfileDownloads("p1", 7777, {
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      updateRow,
      downloadItems,
      releaseFilename,
    });
    expect(updateRow).toHaveBeenCalledTimes(1);
    expect(releaseFilename).toHaveBeenCalledTimes(1);

    // The cancelled item now fires `done` → the shared helper runs against the
    // now-finished (interrupted) record. Teardown did NOT add it to the removal
    // guard; the finished-record invariant suppresses it instead.
    const result = applyDownloadEvent(
      "d1",
      { state: "cancelled", completedAt: 9999, receivedBytes: 123 },
      {
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        removedDownloadIds,
      },
    );

    expect(result).toBeNull();
    expect(state.items[0]!.state).toBe("interrupted"); // not reverted to cancelled
    expect(state.items[0]!.completedAt).toBe(7777);
    // The caller skips release/persist on a null return: no second release, no re-persist.
    expect(releaseFilename).toHaveBeenCalledTimes(1);
    expect(updateRow).toHaveBeenCalledTimes(1);
  });

  test("a trailing throttled write for the terminalized id re-persists only the interrupted row, never a progressing snapshot", () => {
    const d = makeDownload({ id: "d1", state: "progressing", filename: "f.bin", receivedBytes: 10 });
    let state: DownloadsState = { items: [d] };
    const removedDownloadIds = new Set<string>();
    const persisted: Download[] = [];
    let fire: (() => void) | null = null;
    let nowMs = 0;

    const persister = createThrottledPersister({
      getRecord: (id) => state.items.find((x) => x.id === id),
      persist: (record) => persisted.push(record),
      removedDownloadIds,
      intervalMs: 1000,
      now: () => nowMs,
      setTimer: (cb) => {
        fire = cb;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {
        fire = null;
      },
    });

    // First write at t=0 persists immediately (no prior write); snapshot is progressing.
    persister.schedule("d1");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.state).toBe("progressing");

    // A second schedule within the interval arms a boundary timer (no persist yet).
    nowMs = 500;
    persister.schedule("d1");
    expect(persisted).toHaveLength(1);
    expect(fire).not.toBeNull();

    // Profile teardown terminalizes the record BEFORE the boundary timer fires.
    const cancel = vi.fn();
    const downloadItems = new Map([["d1", { item: { cancel }, profileId: "p1" }]]);
    terminalizeProfileDownloads("p1", 7777, {
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      updateRow: () => {},
      downloadItems,
      releaseFilename: () => {},
    });
    expect(state.items[0]!.state).toBe("interrupted");

    // Fire the boundary timer: it reads the record LIVE (now interrupted), never the
    // progressing snapshot captured when it was scheduled.
    nowMs = 1000;
    fire!();
    expect(persisted).toHaveLength(2);
    expect(persisted[1]!.state).toBe("interrupted");
    expect(persisted[1]!.completedAt).toBe(7777);
  });

  test("the throttled persister skips a removed (guarded) id at fire time", () => {
    const d = makeDownload({ id: "d1", state: "progressing", receivedBytes: 10 });
    const state: DownloadsState = { items: [d] };
    const removedDownloadIds = new Set<string>();
    const persisted: Download[] = [];
    let fire: (() => void) | null = null;
    let nowMs = 0;

    const persister = createThrottledPersister({
      getRecord: (id) => state.items.find((x) => x.id === id),
      persist: (record) => persisted.push(record),
      removedDownloadIds,
      intervalMs: 1000,
      now: () => nowMs,
      setTimer: (cb) => {
        fire = cb;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {
        fire = null;
      },
    });

    persister.schedule("d1"); // immediate first write
    nowMs = 500;
    persister.schedule("d1"); // arms a boundary timer
    expect(persisted).toHaveLength(1);

    // The id is removed (remove(id)) before the boundary timer fires.
    removedDownloadIds.add("d1");
    nowMs = 1000;
    fire!();
    // Suppressed: no second write for a removed id.
    expect(persisted).toHaveLength(1);
  });
});
