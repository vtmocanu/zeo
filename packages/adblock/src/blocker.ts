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
 *
 * Beyond network blocking (PRD 5.1) the wrapper also applies `$csp` rules (an
 * `onHeadersReceived` hook that appends `Content-Security-Policy` directives)
 * and cosmetic filters (element-hiding CSS and scriptlets pushed into each
 * frame over the library's two IPC channels via a frame preload). All three
 * layers read the *current* engine at call time, so a refresh keeps working
 * with no re-attach. Session ownership and the IPC handlers are process-wide:
 * at most one blocker owns a given session's hooks/preload and at most one
 * holds the IPC handlers, so resources are handed over only after a
 * {@link Blocker.dispose | dispose}, never shared between live blockers.
 */
import { ElectronBlocker, Request } from "@ghostery/adblocker-electron";
import type { Session } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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
 * The Electron `ipcMain` seam the cosmetic channels are registered on, so the
 * package's unit tests run under plain Vitest with a fake instead of a real
 * Electron main process. Production resolves it lazily from `ipcMain` on the
 * first attach (never at module load).
 */
export interface BlockerIpc {
  /**
   * Registers `listener` for `channel` (mirrors `ipcMain.handle`). The `any`
   * here is justified: the listener shape is Electron's
   * `ipcMain.handle(channel, (event, ...args) => ...)`, whose event/args types
   * are not visible through this seam and differ per channel.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Electron ipcMain.handle seam (see above)
  handle(channel: string, listener: (...args: any[]) => any): void;
  /** Removes the handler for `channel` (mirrors `ipcMain.removeHandler`). */
  removeHandler(channel: string): void;
}

/**
 * The `inject-cosmetic-filters` message the preload sends after the first call:
 * the DOM tokens observed in the frame plus a lifecycle marker. Absent on the
 * first call per document (which carries only the url).
 */
interface CosmeticMessage {
  /** Unique class tokens observed in the frame. */
  classes?: string[];
  /** Unique element ids observed in the frame. */
  ids?: string[];
  /** Unique anchor `href` attributes observed in the frame. */
  hrefs?: string[];
  /** `"start"` for the DOMContentLoaded scan, `"dom-update"` for mutations. */
  lifecycle?: string;
}

/**
 * The subset of an Electron `WebFrameMain` the cosmetic handlers touch. Defined
 * as a seam (rather than reusing Electron's type) so unit tests pass plain
 * fakes and so the destroyed check is a readable boolean field.
 */
interface CosmeticFrame {
  /** The frame's current URL. */
  readonly url: string;
  /**
   * Whether the frame has been destroyed. A method (not a property) to match
   * Electron's real `WebFrameMain.isDestroyed()`; a plain `destroyed` field
   * would read `undefined` (falsy) against a real event and never reject a
   * genuinely destroyed frame.
   */
  isDestroyed(): boolean;
  /** Runs `code` in the frame with no user-gesture flag. */
  executeJavaScript(code: string): Promise<unknown>;
}

/** The subset of an Electron `WebContents` the cosmetic handlers touch. */
interface CosmeticSender {
  /** The session that issued the request; matched against the attached set. */
  readonly session: Session;
  /** The top frame, used to detect a top-frame sender for `insertCSS`. */
  readonly mainFrame: CosmeticFrame | null;
  /** Inserts a user-origin stylesheet into the top frame. */
  insertCSS(css: string, options?: { cssOrigin?: "user" | "author" }): Promise<string>;
  /** Removes a previously inserted stylesheet by its returned key. */
  removeInsertedCSS(key: string): Promise<void>;
}

/** The subset of an Electron IPC invoke event the cosmetic handlers read. */
interface CosmeticIpcEvent {
  /** The web contents that sent the message. */
  readonly sender: CosmeticSender;
  /** The frame that sent the message; `null` after navigation/destruction. */
  readonly senderFrame: CosmeticFrame | null;
  /** The renderer frame id, forwarded to the engine as caller context. */
  readonly frameId: number;
  /** The renderer process id, forwarded to the engine as caller context. */
  readonly processId: number;
}

/** The response headers shape the CSP callback reads and rewrites. */
interface CspDetails {
  /** The response's URL. */
  readonly url: string;
  /** The Electron resource type (e.g. `"mainFrame"`, `"subFrame"`, `"image"`). */
  readonly resourceType: string;
  /** The response status line, passed back through unchanged. */
  readonly statusLine: string;
  /** The response headers, keyed by name to a value array. */
  readonly responseHeaders?: Record<string, string[]>;
}

/** The `onHeadersReceived` callback shape the CSP hook invokes. */
type CspCallback = (response: {
  responseHeaders?: Record<string, string[]>;
  statusLine?: string;
}) => void;

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
   * Terminal transition: detaches every attached session (best-effort, first
   * error rethrown at the end) then removes the wrapper's IPC handlers, so a
   * detach failure can never leave a handler registered or block a replacement
   * blocker's first attach. After `dispose`, {@link Blocker.attach | attach}
   * throws and {@link Blocker.attachedSessions | attachedSessions} is empty.
   */
  dispose(): void;
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
  /** Electron `ipcMain` seam; resolved lazily from real `ipcMain` when absent. */
  ipc?: BlockerIpc;
  /** Path of the frame preload; defaults to the bundled `cosmetic-preload.cjs`. */
  preloadPath?: string;
  /** Scriptlet resource text applied to the engine with `updateResources`. */
  resources?: string;
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
 * The library's two cosmetic IPC channels, hardcoded to match the preload. The
 * preload invokes {@link INJECT_CHANNEL} to receive CSS/scriptlets and
 * {@link MUTATION_CHANNEL} to learn whether to start a MutationObserver.
 */
const INJECT_CHANNEL = "@ghostery/adblocker/inject-cosmetic-filters";
const MUTATION_CHANNEL = "@ghostery/adblocker/is-mutation-observer-enabled";

/**
 * Process-wide ownership shared across every blocker instance. `sessionOwners`
 * records which blocker owns a session's hooks and preload; `ipcHolder` records
 * which blocker holds the IPC handlers; `preloadRegistry` records the single
 * preload id registered for each session's process lifetime, so a session
 * carries at most one adblocker preload no matter how many blockers attach it.
 */
const sessionOwners = new Map<Session, BlockerImpl>();
let ipcHolder: BlockerImpl | null = null;
const preloadRegistry = new Map<Session, string>();

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
 * re-subscription. The CSP and cosmetic-injection callbacks likewise read
 * `this.engine` at call time, so they follow a refresh with no re-attach.
 */
class BlockerImpl implements Blocker {
  private engine: ElectronBlocker;
  public listVersion: string;
  private readonly attached = new Set<Session>();
  private readonly blockedListeners: Array<(event: BlockedEvent) => void> = [];
  private readonly internals: BlockerInternals;
  /**
   * Per-sender record of the last top-frame stylesheet inserted via
   * `insertCSS`, so a mutation-driven rescan returning identical CSS is not
   * inserted again (Electron keeps each sheet until navigation or
   * `removeInsertedCSS`). Keyed weakly by the sending WebContents.
   */
  private readonly insertedCss = new WeakMap<CosmeticSender, { css: string; key: string }>();
  /** Absolute path of the frame preload registered on every attached session. */
  private readonly preloadPath: string;
  /** The resolved IPC seam, set on the first attach that registers handlers. */
  private ipc: BlockerIpc | null = null;
  /** Set by {@link BlockerImpl.dispose}; a disposed blocker refuses to attach. */
  private disposed = false;

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
    this.preloadPath =
      internals.preloadPath ??
      fileURLToPath(new URL("../preload/cosmetic-preload.cjs", import.meta.url));
    this.engine.on("request-blocked", this.bridge);
  }

  /**
   * Resolves the IPC seam: the injected one when present, otherwise lazily from
   * Electron's `ipcMain`. Only invoked on the first attach, so under Vitest —
   * which always injects `internals.ipc` — the `electron` require never runs.
   */
  private resolveIpc(): BlockerIpc {
    if (this.internals.ipc !== undefined) {
      return this.internals.ipc;
    }
    const { ipcMain } = createRequire(import.meta.url)("electron") as typeof import("electron");
    return {
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      removeHandler: (channel) => ipcMain.removeHandler(channel),
    };
  }

  /**
   * Enables blocking on `session`; idempotent per session. Registers, on an
   * unattached session and in order: (0) ownership; (1) the IPC handlers on the
   * blocker's first attach ever; (2) `onBeforeRequest`; (3) `onHeadersReceived`
   * (the CSP hook); (4) the frame preload (once per session for the life of the
   * process). Failure-atomic: if any step throws, the steps already done for
   * this session are undone in reverse (the IPC handlers stay once registered)
   * and the error is rethrown, so `attachedSessions()` never lists a session
   * with partial hooks. The wrapper is the sole owner of `onBeforeRequest` and
   * `onHeadersReceived` on every attached session.
   */
  public attach(session: Electron.Session): void {
    if (this.disposed) {
      throw new Error("adblock: cannot attach a disposed blocker");
    }
    if (this.attached.has(session)) {
      return;
    }

    // STEP 0: claim ownership before touching the session or the IPC seam, so a
    // conflicting attach throws with nothing registered.
    const owner = sessionOwners.get(session);
    if (owner !== undefined && owner !== this) {
      throw new Error("adblock: session is owned by another blocker");
    }
    if (ipcHolder !== null && ipcHolder !== this) {
      throw new Error("adblock: IPC handlers are held by another blocker");
    }
    const tookOwnership = owner === undefined;
    sessionOwners.set(session, this);

    const undo: Array<() => void> = [];
    try {
      // STEP 1: register the IPC handlers on the first attach ever. They stay
      // registered for the blocker's lifetime, so there is no undo entry.
      if (ipcHolder === null) {
        const ipc = this.resolveIpc();
        ipc.handle(INJECT_CHANNEL, this.onInject);
        ipc.handle(MUTATION_CHANNEL, this.onMutation);
        this.ipc = ipc;
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- module-level registry of the single blocker holding the IPC handlers
        ipcHolder = this;
      }

      // STEP 2: network blocking, delegating to the current engine.
      session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
        this.engine.onBeforeRequest(details, callback);
      });
      undo.push(() => session.webRequest.onBeforeRequest(null));

      // STEP 3: CSP injection.
      session.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, this.onHeadersReceived);
      undo.push(() => session.webRequest.onHeadersReceived(null));

      // STEP 4: the frame preload, registered at most once per session process.
      if (!preloadRegistry.has(session)) {
        const id = session.registerPreloadScript({ type: "frame", filePath: this.preloadPath });
        preloadRegistry.set(session, id);
        undo.push(() => {
          session.unregisterPreloadScript(id);
          preloadRegistry.delete(session);
        });
      }

      // STEP 5: the session is now fully attached.
      this.attached.add(session);
    } catch (err) {
      for (let i = undo.length - 1; i >= 0; i -= 1) {
        try {
          undo[i]!();
        } catch {
          // Best-effort rollback: swallow so the original error surfaces.
        }
      }
      if (tookOwnership) {
        sessionOwners.delete(session);
      }
      throw err;
    }
  }

  /**
   * Disables blocking on `session`; idempotent. Removes exactly what attach
   * installed, in reverse order, best-effort: every removal is attempted even
   * when an earlier one throws, the session leaves the attached set and
   * ownership either way, and the first error is rethrown at the end. A failed
   * preload unregister keeps the registry entry so the preload is reused rather
   * than duplicated by the next attach of that session.
   */
  public detach(session: Electron.Session): void {
    if (!this.attached.has(session)) {
      return;
    }
    let firstErr: unknown;
    try {
      const id = preloadRegistry.get(session);
      if (id !== undefined) {
        // A throwing unregister must NOT delete the registry entry: keeping it
        // makes the next attach reuse the id instead of duplicating the preload.
        session.unregisterPreloadScript(id);
        preloadRegistry.delete(session);
      }
    } catch (e) {
      firstErr ??= e;
    }
    try {
      session.webRequest.onHeadersReceived(null);
    } catch (e) {
      firstErr ??= e;
    }
    try {
      session.webRequest.onBeforeRequest(null);
    } catch (e) {
      firstErr ??= e;
    }
    this.attached.delete(session);
    sessionOwners.delete(session);
    if (firstErr !== undefined) {
      throw firstErr;
    }
  }

  /**
   * Terminal transition; see {@link Blocker.dispose}. Every step is attempted
   * even when an earlier one throws, and the first error is rethrown at the end.
   */
  public dispose(): void {
    let firstErr: unknown;
    for (const s of [...this.attached]) {
      try {
        this.detach(s);
      } catch (e) {
        firstErr ??= e;
      }
    }
    if (ipcHolder === this) {
      try {
        this.ipc?.removeHandler(INJECT_CHANNEL);
      } catch (e) {
        firstErr ??= e;
      }
      try {
        this.ipc?.removeHandler(MUTATION_CHANNEL);
      } catch (e) {
        firstErr ??= e;
      }
      ipcHolder = null;
    }
    this.disposed = true;
    if (firstErr !== undefined) {
      throw firstErr;
    }
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
   * The CSP hook, a stable field reading the current engine at call time. For a
   * `mainFrame`/`subFrame` response it asks the engine for
   * `getCSPDirectives(request)` and, when directives are returned, appends them
   * as one additional value to the response's `Content-Security-Policy` header
   * array (creating the header when absent), leaving every other header —
   * including `Content-Security-Policy-Report-Only` and existing CSP values —
   * untouched. Any other resource type, or a frame response with no directives,
   * passes the original headers and status line straight through.
   */
  private readonly onHeadersReceived = (details: CspDetails, callback: CspCallback): void => {
    if (details.resourceType === "mainFrame" || details.resourceType === "subFrame") {
      // Both frame types are queried as a `main_frame` request: the library's
      // `getCSPDirectives` gates on `request.isMainFrame()` and returns
      // `undefined` for a `sub_frame` request, so a subframe is normalized to a
      // main-frame request to be "treated like a main frame" — otherwise a
      // `$csp` rule would never reach any subframe document response.
      const directives = this.engine.getCSPDirectives(
        Request.fromRawDetails({ url: details.url, type: "main_frame" }),
      );
      if (directives !== undefined) {
        const headers: Record<string, string[]> = { ...(details.responseHeaders ?? {}) };
        const existingKey = Object.keys(headers).find(
          (name) => name.toLowerCase() === "content-security-policy",
        );
        if (existingKey !== undefined) {
          headers[existingKey] = [...headers[existingKey]!, directives];
        } else {
          headers["Content-Security-Policy"] = [directives];
        }
        callback({ responseHeaders: headers, statusLine: details.statusLine });
        return;
      }
    }
    // Non-frame response, or no matching directives: pass the original headers
    // and status line through unchanged, never an empty object.
    callback({ responseHeaders: details.responseHeaders, statusLine: details.statusLine });
  };

  /**
   * The `inject-cosmetic-filters` handler, a stable field reading the current
   * engine at call time. Validates the sender, asks the engine for the frame's
   * cosmetic filters, and injects styles (top frame via `insertCSS`, child
   * frame via a `<style data-zeo-cosmetic>` element) plus each scriptlet through
   * the sending frame's one-argument `executeJavaScript`. Rejected senders
   * inject nothing and resolve `undefined`.
   */
  private readonly onInject = async (
    event: CosmeticIpcEvent,
    url: string,
    msg?: CosmeticMessage,
  ): Promise<void> => {
    const frame = event.senderFrame;
    if (frame === null || frame.isDestroyed()) {
      return;
    }
    if (!this.attached.has(event.sender.session)) {
      return;
    }
    if (url !== frame.url) {
      return;
    }

    const isFirstRun = msg === undefined;
    const request = Request.fromRawDetails({ url });
    const { active, styles, scripts } = this.engine.getCosmeticsFilters({
      url,
      hostname: request.hostname,
      domain: request.domain,
      classes: msg?.classes,
      ids: msg?.ids,
      hrefs: msg?.hrefs,
      getBaseRules: isFirstRun,
      getInjectionRules: isFirstRun,
      getExtendedRules: false,
      getRulesFromHostname: isFirstRun,
      getRulesFromDOM: !isFirstRun,
      callerContext: {
        frameId: event.frameId,
        processId: event.processId,
        lifecycle: msg?.lifecycle,
      },
    });

    if (!active) {
      return;
    }

    if (styles.length > 0) {
      if (frame === event.sender.mainFrame) {
        // Electron keeps every inserted sheet until navigation, so a
        // mutation-driven rescan returning identical CSS would stack duplicate
        // sheets. Skip an unchanged rescan, and remove the previous sheet before
        // inserting a changed one.
        const prev = this.insertedCss.get(event.sender);
        if (prev === undefined || prev.css !== styles) {
          if (prev !== undefined) {
            await event.sender.removeInsertedCSS(prev.key);
          }
          const key = await event.sender.insertCSS(styles, { cssOrigin: "user" });
          this.insertedCss.set(event.sender, { css: styles, key });
        }
      } else {
        // Child frames have no insertCSS; append a single, reused <style>
        // element to the frame's head, replacing its contents on updates.
        await frame.executeJavaScript(styleElementScript(styles));
      }
    }

    for (const script of scripts) {
      // One argument only, so a scriptlet cannot reach gesture-gated APIs. A
      // scriptlet that throws must not reject the handler (which would surface as
      // a rejected invoke in the sending frame and skip the remaining scriptlets),
      // so each runs in its own try/catch, matching the library.
      try {
        await frame.executeJavaScript(script);
      } catch (err) {
        console.error("[adblock] cosmetic scriptlet failed:", err);
      }
    }
  };

  /**
   * The `is-mutation-observer-enabled` handler, a stable field. Validates the
   * sender (no url check) and returns the current engine's
   * `enableMutationObserver`; a rejected sender resolves `false`.
   */
  private readonly onMutation = async (event: CosmeticIpcEvent): Promise<boolean> => {
    const frame = event.senderFrame;
    if (frame === null || frame.isDestroyed()) {
      return false;
    }
    if (!this.attached.has(event.sender.session)) {
      return false;
    }
    return this.engine.config.enableMutationObserver;
  };

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
    // Resource text is engine-scoped: the rebuilt engine has none, so re-apply
    // the configured scriptlet resources before the swap or `##+js(...)` rules
    // stop resolving after the first refresh.
    if (this.internals.resources !== undefined) {
      newEngine.updateResources(this.internals.resources, "zeo");
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

/**
 * Builds the child-frame `<style data-zeo-cosmetic>` injection script. The
 * element is found-or-created once and its `textContent` is replaced (not
 * duplicated) on later update calls; `styles` is embedded with `JSON.stringify`
 * so arbitrary CSS cannot break out of the string literal.
 */
function styleElementScript(styles: string): string {
  return `(() => {
  const id = "data-zeo-cosmetic";
  let el = document.head && document.head.querySelector("style[" + id + "]");
  if (!el) {
    el = document.createElement("style");
    el.setAttribute(id, "");
    (document.head || document.documentElement).appendChild(el);
  }
  el.textContent = ${JSON.stringify(styles)};
})();`;
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
  /**
   * Electron/cosmetic seams. `ipc` overrides the lazy `ipcMain` resolution,
   * `preloadPath` overrides the bundled frame preload, and `resources` is
   * scriptlet resource text applied to the initial engine with
   * `updateResources`. All are for tests and the fixture path.
   */
  internals?: { ipc?: BlockerIpc; preloadPath?: string; resources?: string };
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

  const internals = options.internals ?? {};
  if (internals.resources !== undefined) {
    engine.updateResources(internals.resources, "zeo");
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
    ipc: internals.ipc,
    preloadPath: internals.preloadPath,
    resources: internals.resources,
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
 * `"fixture"` when omitted. The optional `internals` supplies the Electron/
 * cosmetic seams; when `internals.resources` is set it is applied to the parsed
 * engine with `updateResources` before the blocker is constructed, so fixture
 * scriptlets resolve.
 */
export function createBlockerFromFilters(
  filters: string,
  listVersion = "fixture",
  internals: { ipc?: BlockerIpc; preloadPath?: string; resources?: string } = {},
): Blocker {
  const engine = ElectronBlocker.parse(filters);
  if (internals.resources !== undefined) {
    engine.updateResources(internals.resources, "zeo");
  }
  return new BlockerImpl(engine, listVersion, {
    ipc: internals.ipc,
    preloadPath: internals.preloadPath,
    resources: internals.resources,
  });
}
