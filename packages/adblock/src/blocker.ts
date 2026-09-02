/**
 * The `@zeo/adblock` content-blocking wrapper. This is the only package that
 * imports `@ghostery/adblocker-electron`. It owns a single mutable engine
 * reference plus the set of attached Electron sessions and the blocked-event
 * listeners, so an engine {@link Blocker.refresh | refresh} can swap the engine
 * in a single synchronous step without re-registering session hooks or asking
 * callers to re-subscribe.
 *
 * The session `webRequest` hooks are owned by this wrapper and delegate to the
 * *current* engine, and a single stable bridge is moved from the old engine to
 * the new one on swap. This deliberately avoids the library's
 * `enableBlockingInSession`, which binds a session's hooks to one specific
 * engine instance and would leave a session pointing at a stale engine after a
 * rebuild.
 */
import { ElectronBlocker } from "@ghostery/adblocker-electron";
import type { Request } from "@ghostery/adblocker-electron";
import type { Session } from "electron";
import { readFile, writeFile } from "node:fs/promises";

/** A single request the engine blocked, mapped to zeo's attribution keys. */
export interface BlockedEvent {
  /** The Electron `webContents.id` that issued the blocked request. */
  webContentsId: number;
  /** The URL of the blocked request. */
  url: string;
}

/**
 * Minimal filesystem seam used for the engine cache, so unit tests can inject
 * fakes instead of touching disk. Mirrors the shape of `node:fs/promises`
 * `readFile`/`writeFile` for the calls this package makes.
 */
export interface BlockerFs {
  /** Reads the serialized engine cache at `path`. */
  readFile: (path: string) => Promise<Uint8Array | Buffer>;
  /** Writes the serialized engine `data` to `path`. */
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
}

/**
 * A long-lived content blocker. One instance lives for the whole app lifetime;
 * it owns exactly one engine at a time plus the attached sessions and the
 * listener list, and {@link Blocker.refresh | refresh} swaps the engine
 * atomically while sessions and listeners stay registered.
 */
export interface Blocker {
  /** Enables blocking on `session`; idempotent per session. */
  attach(session: Electron.Session): void;
  /** Disables blocking on `session`; idempotent. */
  detach(session: Electron.Session): void;
  /** The sessions currently attached, in insertion order. */
  attachedSessions(): readonly Electron.Session[];
  /**
   * Registers `listener` for every blocked request; returns an unsubscribe
   * function. Listeners registered before a refresh keep receiving events after
   * it with no re-subscription.
   */
  onBlocked(listener: (event: BlockedEvent) => void): () => void;
  /**
   * Rebuilds the engine from the configured lists off to the side (bounded by a
   * 15s timeout) and swaps it in on success. A failed build — a fetch error, the
   * 15s timeout, or a response exceeding the size guard — leaves the current
   * engine, sessions, listeners, and {@link Blocker.listVersion} untouched and
   * resolves `false`. A successful build swaps the engine and resolves `true`
   * even if writing the on-disk cache then fails: the swap already succeeded, so
   * the cache-write error is logged and ignored (the cache is only a
   * startup optimization).
   */
  refresh(): Promise<boolean>;
  /**
   * The active engine's origin: `"cache"`, `"remote"`, `"none"`, or a
   * `"fixture"`-prefixed value. Changes on a successful swap.
   */
  listVersion: string;
}

/** Internal construction options for {@link BlockerImpl}. */
interface BlockerInternals {
  /**
   * Builds a fresh engine from the remote lists; absent for the no-op variant.
   * Receives the refresh's {@link AbortController} so its fetches can be
   * cancelled on timeout or a size-guard trip.
   */
  remoteBuild?: (controller: AbortController) => Promise<ElectronBlocker>;
  /** Cache path to serialize a refreshed engine to, when `fs` is also set. */
  cacheFile?: string;
  /** Filesystem seam used to persist the engine cache. */
  fs?: BlockerFs;
}

/** How long a remote engine build may run before a refresh is abandoned. */
const REFRESH_TIMEOUT_MS = 15_000;

/**
 * Cap on a remote list response's declared size (64 MiB). Defense-in-depth
 * against a hostile/oversized list host: a response whose `content-length`
 * exceeds this is refused before it is buffered.
 */
const MAX_LIST_BYTES = 64 * 1024 * 1024;

/**
 * Races `promise` against a timer that rejects after `ms`. On timeout the shared
 * `controller` is aborted so any in-flight fetch is actually cancelled instead
 * of downloading in the background after refresh has returned; the timer is
 * cleared on both branches so a completed build never leaves a dangling handle.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("adblock refresh timed out"));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Wraps `fetchImpl` so every request it issues (the library fetches each list
 * URL and a `resources.json`) carries `controller.signal`, and rejects — after
 * aborting the whole build — any response whose declared `content-length`
 * exceeds {@link MAX_LIST_BYTES}. A lying `Content-Length` that streams under
 * the cap and the refresh timeout is an accepted residual: this is a header
 * guard, not full streaming byte-counting.
 */
function guardedFetch(fetchImpl: typeof fetch, controller: AbortController): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_LIST_BYTES) {
      controller.abort();
      throw new Error(`adblock list response exceeds ${MAX_LIST_BYTES} bytes`);
    }
    return response;
  };
}

/**
 * Concrete {@link Blocker}. The session hooks close over `this.engine` (mutable)
 * and a single `bridge` is subscribed to the current engine's `request-blocked`
 * event, so a refresh only reassigns `this.engine`, moves the bridge, and
 * updates `listVersion` — no session re-registration and no caller
 * re-subscription.
 */
class BlockerImpl implements Blocker {
  private engine: ElectronBlocker;
  public listVersion: string;
  private readonly attached = new Set<Session>();
  private readonly blockedListeners: Array<(event: BlockedEvent) => void> = [];
  private readonly internals: BlockerInternals;

  /**
   * The stable bridge subscribed to the current engine's `request-blocked`
   * event. It maps the library `Request` to a {@link BlockedEvent} and fans out
   * to the wrapper's own listener array.
   */
  private readonly bridge: (request: Request) => void = (request) => {
    const event: BlockedEvent = {
      webContentsId: request.tabId,
      url: request.url,
    };
    for (const listener of this.blockedListeners) {
      listener(event);
    }
  };

  /**
   * The in-flight background refresh started by {@link createBlocker}, exposed
   * so unit tests can deterministically await it. Resolves `false` for blockers
   * with no remote source (e.g. {@link createBlockerFromFilters}).
   */
  public ready: Promise<boolean> = Promise.resolve(false);

  /**
   * Wraps `engine` (already built) with the given `listVersion` and refresh
   * `internals`, subscribing the bridge to `engine`.
   */
  public constructor(engine: ElectronBlocker, listVersion: string, internals: BlockerInternals) {
    this.engine = engine;
    this.listVersion = listVersion;
    this.internals = internals;
    this.engine.on("request-blocked", this.bridge);
  }

  /** Enables blocking on `session`; idempotent per session. */
  public attach(session: Electron.Session): void {
    if (this.attached.has(session)) {
      return;
    }
    session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      this.engine.onBeforeRequest(details, callback);
    });
    this.attached.add(session);
  }

  /** Disables blocking on `session`; idempotent. */
  public detach(session: Electron.Session): void {
    if (!this.attached.has(session)) {
      return;
    }
    session.webRequest.onBeforeRequest(null);
    this.attached.delete(session);
  }

  /** The sessions currently attached, in insertion order. */
  public attachedSessions(): readonly Electron.Session[] {
    return [...this.attached];
  }

  /**
   * Registers `listener` for every blocked request; returns an unsubscribe
   * function that removes exactly this listener.
   */
  public onBlocked(listener: (event: BlockedEvent) => void): () => void {
    this.blockedListeners.push(listener);
    return () => {
      const index = this.blockedListeners.indexOf(listener);
      if (index >= 0) {
        this.blockedListeners.splice(index, 1);
      }
    };
  }

  /**
   * Rebuilds the engine from the remote lists and swaps it in atomically on
   * success. Returns `false` immediately for blockers with no remote source, and
   * on a failed build — a fetch error, the 15s timeout (which aborts the
   * in-flight fetch), or a response tripping the size guard — with the current
   * engine, sessions, listeners, and `listVersion` left untouched. On a
   * successful build it swaps the engine and resolves `true` even if writing the
   * on-disk cache then fails: the swap already succeeded, so the write error is
   * logged and ignored rather than rejecting (which would surface as an
   * unhandledRejection in the un-awaited startup refresh).
   */
  public async refresh(): Promise<boolean> {
    const build = this.internals.remoteBuild;
    if (build === undefined) {
      return false;
    }
    const controller = new AbortController();
    let newEngine: ElectronBlocker;
    try {
      newEngine = await withTimeout(build(controller), REFRESH_TIMEOUT_MS, controller);
    } catch {
      return false;
    }
    // Atomic swap: move the bridge old->new, repoint the engine, bump the
    // version. Session hooks read `this.engine`, so they follow with no work.
    this.engine.unsubscribe("request-blocked", this.bridge);
    newEngine.on("request-blocked", this.bridge);
    this.engine = newEngine;
    this.listVersion = "remote";
    const { cacheFile, fs } = this.internals;
    if (cacheFile !== undefined && fs !== undefined) {
      // The engine swap above already succeeded; the on-disk cache is only a
      // startup optimization, so a serialize/write failure is logged and
      // swallowed. Rethrowing here would reject the un-awaited startup refresh
      // and become an unhandledRejection in the Electron main process.
      try {
        await fs.writeFile(cacheFile, newEngine.serialize());
      } catch (err) {
        console.warn("[adblock] failed to write engine cache:", err);
      }
    }
    return true;
  }
}

/** Options for {@link createBlocker}. */
export interface CreateBlockerOptions {
  /** Path the serialized engine is read from at startup and written to on refresh. */
  cacheFile: string;
  /** Fetch implementation used to download remote filter lists. */
  fetch: typeof fetch;
  /**
   * Remote filter-list URLs. When omitted, the library's prebuilt ads and
   * tracking set is used.
   */
  lists?: string[];
  /**
   * Filesystem seam for the engine cache; defaults to `node:fs/promises`.
   */
  fs?: BlockerFs;
}

/**
 * Builds a {@link Blocker} for production use. The returned promise resolves as
 * soon as the fast local step is done — deserializing `cacheFile`
 * (`listVersion` `"cache"`) or, on any error, an empty engine that blocks
 * nothing (`listVersion` `"none"`). The library ships no offline bundled lists,
 * so there is no `"bundled"` local path; only a remote fetch produces populated
 * lists.
 *
 * One background {@link Blocker.refresh | refresh} from the remote lists is
 * started but not awaited before resolving; its in-flight promise is exposed as
 * a non-interface `ready: Promise<boolean>` field on the returned object so
 * tests can await it deterministically with an injected `fetch`.
 */
export async function createBlocker(options: CreateBlockerOptions): Promise<Blocker> {
  const fs: BlockerFs = options.fs ?? {
    readFile: (path) => readFile(path),
    writeFile: (path, data) => writeFile(path, data),
  };

  let engine: ElectronBlocker;
  let listVersion: string;
  try {
    const bytes = await fs.readFile(options.cacheFile);
    engine = ElectronBlocker.deserialize(bytes);
    listVersion = "cache";
  } catch {
    engine = ElectronBlocker.empty();
    listVersion = "none";
  }

  const lists = options.lists;
  const remoteBuild = (controller: AbortController): Promise<ElectronBlocker> => {
    // Every fetch the build issues carries the refresh's abort signal and the
    // response size guard, so a timeout cancels in-flight downloads.
    const fetch = guardedFetch(options.fetch, controller);
    return lists !== undefined
      ? ElectronBlocker.fromLists(fetch, lists)
      : ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
  };

  const blocker = new BlockerImpl(engine, listVersion, {
    remoteBuild,
    cacheFile: options.cacheFile,
    fs,
  });
  // Kick off exactly one background refresh; do not await it before resolving.
  blocker.ready = blocker.refresh();
  return blocker;
}

/**
 * Builds a {@link Blocker} synchronously from raw `filters` text, with no cache,
 * no remote source, and a no-op {@link Blocker.refresh | refresh} that resolves
 * `false` (there is nothing to rebuild from). Used by unit tests and the e2e
 * fixture.
 *
 * The optional `listVersion` is a backward-compatible superset of the PRD's
 * `(filters)` signature: callers (e.g. main's `ZEO_ADBLOCK_FILTERS` path) pass
 * `fixture:<basename>` so the active origin is visible; it defaults to
 * `"fixture"` when omitted.
 */
export function createBlockerFromFilters(filters: string, listVersion = "fixture"): Blocker {
  const engine = ElectronBlocker.parse(filters);
  return new BlockerImpl(engine, listVersion, {});
}
