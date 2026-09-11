/**
 * The data-integrity core of the main-process downloads feature, factored out of
 * `index.ts` so it can be unit-tested with injected collaborators (`index.ts`
 * itself exports no handlers). Each function takes its collaborators — the
 * in-memory {@link DownloadsState} getter/setter, the SQLite row helpers, the
 * live-item registry, the removal guard, and `broadcast` — as arguments, so the
 * production wiring passes the real ones and the tests pass stubs.
 *
 * The two invariants these helpers enforce (PRD 6.2 §3):
 *  - the removal guard: a `remove(id)` while in-flight suppresses every later
 *    event for that id, so a still-live item can never resurrect a removed record;
 *  - the finished-record invariant: a record already in a terminal state is never
 *    reverted, re-persisted, re-broadcast, or has its filename re-released.
 */
import {
  removeDownload,
  upsertDownload,
  isFinished,
  type Download,
  type DownloadsState,
} from "@zeo/core";

/** The minimal shape of a live Electron `DownloadItem` these helpers act on: a
 *  cancel. Electron's `DownloadItem` satisfies it structurally, and tests pass a
 *  spy. Generic so the registry keeps its concrete item type at each call site. */
export interface CancelableItem {
  cancel(): void;
}

/**
 * A live-item registry entry: the cancelable {@link DownloadItem} for an active
 * download plus the id of the profile session its `will-download` fired on.
 */
export interface DownloadRegistryEntry<I extends CancelableItem = CancelableItem> {
  item: I;
  profileId: string;
}

/** Reads/writes the single in-memory {@link DownloadsState} main owns. */
interface StateAccess {
  getState(): DownloadsState;
  setState(next: DownloadsState): void;
}

/** Collaborators for {@link removeDownloadSequenced}. */
export interface RemoveDownloadDeps<I extends CancelableItem> extends StateAccess {
  /** Deletes the SQLite row; a throw aborts the whole operation (commit-first). */
  deleteRow(id: string): void;
  downloadItems: Map<string, DownloadRegistryEntry<I>>;
  removedDownloadIds: Set<string>;
  /** The `broadcast({ persist: false })` to mirror the new state to the renderer. */
  broadcast(): void;
}

/**
 * The commit-first `remove(id)` sequence (PRD 6.2 §4). An id absent from BOTH the
 * state and the registry short-circuits as a no-op that touches nothing. Otherwise
 * the ordering is: (1) delete the SQLite row FIRST — a throw rejects with no
 * in-memory, guard, cancel, or broadcast change; (2) only on a clean delete, and
 * synchronously with no intervening `await`, drop the record from memory, and —
 * when the id resolves to a live item — add it to the removal guard BEFORE
 * cancelling it (so its later events are suppressed), then broadcast.
 */
export async function removeDownloadSequenced<I extends CancelableItem>(
  id: string,
  deps: RemoveDownloadDeps<I>,
): Promise<void> {
  const inState = deps.getState().items.some((d) => d.id === id);
  const inRegistry = deps.downloadItems.has(id);
  if (!inState && !inRegistry) {
    // Unknown id: resolve without touching the database.
    return;
  }
  // (1) Commit-first: a throw here propagates as a rejection with nothing changed.
  deps.deleteRow(id);
  // (2) Synchronous, no intervening await, so no download event can interleave.
  deps.setState(removeDownload(deps.getState(), id));
  const entry = deps.downloadItems.get(id);
  if (entry !== undefined) {
    // Guard BEFORE cancel: the item's later updated/done (and any pending
    // throttled write) are suppressed, so the record is never recreated.
    deps.removedDownloadIds.add(id);
    entry.item.cancel();
  }
  deps.broadcast();
}

/** Collaborators for {@link applyDownloadEvent}. */
export interface ApplyDownloadEventDeps extends StateAccess {
  removedDownloadIds: Set<string>;
}

/**
 * The shared `updated`/`done` application logic, carrying BOTH terminal guards
 * (PRD 6.2 §3). Returns the updated record when the patch is applied, or `null`
 * when the event is suppressed — the id is removal-guarded, its record is absent,
 * or its current record is already finished (terminal). The caller persists and
 * broadcasts only for a non-null return, so a late event on a removed or
 * terminalized record mutates, persists, broadcasts, and releases nothing.
 */
export function applyDownloadEvent(
  id: string,
  patch: Partial<Omit<Download, "id">>,
  deps: ApplyDownloadEventDeps,
): Download | null {
  if (deps.removedDownloadIds.has(id)) {
    return null;
  }
  const current = deps.getState().items.find((d) => d.id === id);
  if (current === undefined || isFinished(current)) {
    return null;
  }
  const next: Download = { ...current, ...patch };
  deps.setState(upsertDownload(deps.getState(), next));
  return next;
}

/** A timer handle, parameterized so tests can inject a fake scheduler. */
type TimerHandle = ReturnType<typeof setTimeout>;

/** Collaborators for {@link createThrottledPersister}. */
export interface ThrottledPersisterDeps {
  /** Reads the CURRENT in-memory record for `id` (never a captured snapshot). */
  getRecord(id: string): Download | undefined;
  /** Persists the record through the update helper (e.g. `updateDownload`). */
  persist(record: Download): void;
  removedDownloadIds: Set<string>;
  /** Throttle window per download, default 1000 ms. */
  intervalMs?: number;
  now?(): number;
  setTimer?(callback: () => void, ms: number): TimerHandle;
  clearTimer?(handle: TimerHandle): void;
}

/** A per-download throttled row persister (PRD 6.2 §3): at most one write per
 *  `intervalMs` per id, each write reading the record LIVE at fire time. */
export interface ThrottledPersister {
  /** Persists `id`'s current record now when the interval has elapsed, else arms
   *  a boundary timer that reads the record live and re-checks the removal guard. */
  schedule(id: string): void;
  /** Cancels any pending timer for `id` without persisting (called on `done`
   *  before the caller's bypass-the-throttle final flush). */
  cancel(id: string): void;
}

/**
 * Builds a {@link ThrottledPersister}. A write fires immediately when at least
 * `intervalMs` has elapsed since the last write for that id; otherwise a single
 * boundary timer is armed and, at fire time, re-checks the removal guard and reads
 * the record LIVE — so it can never persist a `state` older than the live record,
 * and for a terminalized record it merely re-persists the same terminal row.
 */
export function createThrottledPersister(
  deps: ThrottledPersisterDeps,
): ThrottledPersister {
  const intervalMs = deps.intervalMs ?? 1000;
  const now = deps.now ?? ((): number => Date.now());
  const setTimer = deps.setTimer ?? ((cb, ms): TimerHandle => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h): void => clearTimeout(h));
  const lastWrite = new Map<string, number>();
  const timers = new Map<string, TimerHandle>();

  function persistNow(id: string): void {
    // Re-check the guard at fire time: the record may have been removed after the
    // timer was armed; never resurrect a removed record.
    if (deps.removedDownloadIds.has(id)) {
      return;
    }
    const record = deps.getRecord(id);
    if (record === undefined) {
      return;
    }
    lastWrite.set(id, now());
    deps.persist(record);
  }

  return {
    schedule(id: string): void {
      if (deps.removedDownloadIds.has(id) || timers.has(id)) {
        return;
      }
      const last = lastWrite.get(id);
      const elapsed = last === undefined ? Number.POSITIVE_INFINITY : now() - last;
      if (elapsed >= intervalMs) {
        persistNow(id);
        return;
      }
      const handle = setTimer(() => {
        timers.delete(id);
        persistNow(id);
      }, intervalMs - elapsed);
      timers.set(id, handle);
    },
    cancel(id: string): void {
      const handle = timers.get(id);
      if (handle !== undefined) {
        clearTimer(handle);
        timers.delete(id);
      }
    },
  };
}

/** Collaborators for {@link terminalizeProfileDownloads}. */
export interface TerminalizeProfileDeps<I extends CancelableItem> extends StateAccess {
  updateRow(record: Download): void;
  downloadItems: Map<string, DownloadRegistryEntry<I>>;
  /** Releases one in-flight basename reservation (`reservedFilenames.delete`). */
  releaseFilename(filename: string): void;
}

/**
 * Deterministically terminalizes every active download on a deleted profile
 * (PRD 6.2 §3 Cleanup), without waiting for `done`. In one synchronous pass, for
 * each registry entry whose `profileId` matches: set the record `interrupted` with
 * `completedAt = teardownTime`, persist it through the update helper, release its
 * reserved filename once, cancel the live item, and drop the registry entry. It
 * does NOT add ids to the removal guard — the finished-record invariant in
 * {@link applyDownloadEvent} suppresses the cancel's later events instead — and it
 * does NOT broadcast: the `IPC.profilesDelete` handler's own `broadcast()` (run
 * right after) mirrors the terminal state, covering the no-active-download case
 * too.
 */
export function terminalizeProfileDownloads<I extends CancelableItem>(
  profileId: string,
  teardownTime: number,
  deps: TerminalizeProfileDeps<I>,
): void {
  for (const [id, entry] of [...deps.downloadItems]) {
    if (entry.profileId !== profileId) {
      continue;
    }
    const current = deps.getState().items.find((d) => d.id === id);
    if (current !== undefined && !isFinished(current)) {
      const terminal: Download = {
        ...current,
        state: "interrupted",
        completedAt: teardownTime,
      };
      deps.setState(upsertDownload(deps.getState(), terminal));
      deps.updateRow(terminal);
      deps.releaseFilename(current.filename);
    }
    entry.item.cancel();
    deps.downloadItems.delete(id);
  }
}
