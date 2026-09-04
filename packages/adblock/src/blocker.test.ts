import { afterEach, describe, expect, test, vi } from "vitest";
import { ElectronBlocker } from "@ghostery/adblocker-electron";
import type { Session } from "electron";
import {
  createBlocker,
  createBlockerFromFilters,
  type Blocker,
  type BlockerFs,
  type BlockerIpc,
} from "./blocker.js";

/**
 * Awaits the background refresh `createBlocker` starts. `ready` is a
 * non-interface field on the resolved object (see `createBlocker`'s docs), so
 * tests reach it through a narrow cast.
 */
function awaitReady(blocker: Blocker): Promise<boolean> {
  return (blocker as unknown as { ready: Promise<boolean> }).ready;
}

/** A filter that blocks any request to the `ads.example.com` host. */
const AD_FILTER = "||ads.example.com^";
/** A URL the {@link AD_FILTER} matches. */
const BLOCKED_URL = "https://ads.example.com/tracker.js";
/** A URL the {@link AD_FILTER} does not match. */
const ALLOWED_URL = "https://cdn.example.com/app.js";

/** The library's two cosmetic IPC channels (hardcoded to match the wrapper). */
const INJECT = "@ghostery/adblocker/inject-cosmetic-filters";
const MUTATION = "@ghostery/adblocker/is-mutation-observer-enabled";

/** A hostname-specific element-hiding rule, so the first invoke returns styles. */
const HIDE_FILTER = "example.com##.ad-slot";
/** A hostname-specific scriptlet rule resolved by {@link RESOURCES}. */
const SCRIPTLET_FILTER = "example.com##+js(zeo-mark)";
/** Library resources JSON defining the `zeo-mark` scriptlet. */
const RESOURCES = JSON.stringify({
  scriptlets: [
    {
      name: "zeo-mark.js",
      aliases: [],
      body: "document.documentElement.dataset.zeoScriptlet = 'ran';",
      dependencies: [],
    },
  ],
  redirects: [],
});
/** The stylesheet the engine produces for {@link HIDE_FILTER}. */
const HIDE_STYLES = ".ad-slot { display: none !important; }";
/** A URL the cosmetic fixtures match. */
const PAGE_URL = "https://example.com/";

/** The details shape the wrapper's `onBeforeRequest` hook forwards to the engine. */
interface FakeDetails {
  id: number;
  url: string;
  resourceType: string;
  webContentsId: number;
}
/** The `webRequest.onBeforeRequest` listener signature the wrapper registers. */
type BeforeRequestListener = (
  details: FakeDetails,
  callback: (response: { cancel?: boolean }) => void,
) => void;

/** The response-headers shape the wrapper's CSP hook reads and rewrites. */
interface HeadersDetails {
  url: string;
  resourceType: string;
  statusLine: string;
  responseHeaders?: Record<string, string[]>;
}
/** The `webRequest.onHeadersReceived` listener signature the wrapper registers. */
type HeadersListener = (
  details: HeadersDetails,
  callback: (response: { responseHeaders?: Record<string, string[]>; statusLine?: string }) => void,
) => void;

/** Everything a fake session records about what the wrapper registered on it. */
interface SessionState {
  captured?: BeforeRequestListener;
  registrations: number;
  capturedHeaders?: HeadersListener;
  headerRegistrations: number;
  /** Number of preload scripts currently registered (register minus unregister). */
  preloadCount: number;
  /** Total `registerPreloadScript` calls that returned an id. */
  registerCalls: number;
  /** Total `unregisterPreloadScript` calls attempted. */
  unregisterCalls: number;
  registerThrows: boolean;
  unregisterThrows: boolean;
  nextId: number;
}

/**
 * A hand-written fake `Session` recording the wrapper's `onBeforeRequest` and
 * `onHeadersReceived` listeners plus the preload scripts it registered.
 */
function makeFakeSession(): { session: Session; state: SessionState } {
  const state: SessionState = {
    captured: undefined,
    registrations: 0,
    capturedHeaders: undefined,
    headerRegistrations: 0,
    preloadCount: 0,
    registerCalls: 0,
    unregisterCalls: 0,
    registerThrows: false,
    unregisterThrows: false,
    nextId: 1,
  };
  const session = {
    webRequest: {
      onBeforeRequest(filterOrNull: unknown, listener?: BeforeRequestListener): void {
        if (filterOrNull === null) {
          state.captured = undefined;
          return;
        }
        state.captured = listener;
        state.registrations += 1;
      },
      onHeadersReceived(filterOrNull: unknown, listener?: HeadersListener): void {
        if (filterOrNull === null) {
          state.capturedHeaders = undefined;
          return;
        }
        state.capturedHeaders = listener;
        state.headerRegistrations += 1;
      },
    },
    registerPreloadScript(): string {
      if (state.registerThrows) {
        throw new Error("registerPreloadScript failed");
      }
      state.registerCalls += 1;
      state.preloadCount += 1;
      return String(state.nextId++);
    },
    unregisterPreloadScript(): void {
      state.unregisterCalls += 1;
      if (state.unregisterThrows) {
        // Throw before decrementing: a failed unregister keeps the script
        // registered (and the registry entry), so the next attach reuses it.
        throw new Error("unregisterPreloadScript failed");
      }
      state.preloadCount -= 1;
    },
  };
  return { session: session as unknown as Session, state };
}

/**
 * A fake {@link BlockerIpc} recording handled channels and how many times
 * handlers were added/removed, plus a way to invoke a registered handler.
 */
function makeFakeIpc(): {
  ipc: BlockerIpc;
  // The listener shape is Electron's `ipcMain.handle` seam; `any` mirrors it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the BlockerIpc seam
  handlers: Map<string, (...args: any[]) => any>;
  stats: { handle: number; remove: number };
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the BlockerIpc seam
  const handlers = new Map<string, (...args: any[]) => any>();
  const stats = { handle: 0, remove: 0 };
  const ipc: BlockerIpc = {
    handle(channel, listener) {
      stats.handle += 1;
      handlers.set(channel, listener);
    },
    removeHandler(channel) {
      stats.remove += 1;
      handlers.delete(channel);
    },
  };
  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      return Promise.reject(new Error(`no handler for ${channel}`));
    }
    return Promise.resolve(handler(...args));
  };
  return { ipc, handlers, stats, invoke };
}

/** Cosmetic seams for a blocker under test: a fresh fake ipc plus a fake path. */
function cosmeticInternals(): { ipc: BlockerIpc; preloadPath: string } {
  return { ipc: makeFakeIpc().ipc, preloadPath: "fake-preload.cjs" };
}

/** A fake `WebFrameMain`, as the cosmetic handlers read it. */
interface FakeFrame {
  url: string;
  destroyed: boolean;
  isDestroyed: () => boolean;
  executeJavaScript: ReturnType<typeof vi.fn>;
}

/** A fake IPC invoke event whose sender records `insertCSS`/`executeJavaScript`. */
function makeFakeEvent(options: {
  session: Session;
  frameUrl: string;
  kind: "top" | "child";
  destroyed?: boolean;
  senderFrameNull?: boolean;
}): {
  event: unknown;
  insertCSS: ReturnType<typeof vi.fn>;
  removeInsertedCSS: ReturnType<typeof vi.fn>;
  frame: FakeFrame;
} {
  // Return a distinct non-empty key per call so the wrapper's dedup logic has a
  // real key to track and later pass to removeInsertedCSS.
  let nextKey = 0;
  const insertCSS = vi.fn(() => Promise.resolve(`key-${(nextKey += 1)}`));
  const removeInsertedCSS = vi.fn(() => Promise.resolve());
  const mainFrame: FakeFrame = {
    url: options.kind === "top" ? options.frameUrl : "https://top.example/",
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
  };
  const child: FakeFrame = {
    url: options.frameUrl,
    destroyed: options.destroyed ?? false,
    isDestroyed() {
      return this.destroyed;
    },
    executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
  };
  const frame = options.kind === "top" ? mainFrame : child;
  frame.destroyed = options.destroyed ?? false;
  const senderFrame = options.senderFrameNull === true ? null : frame;
  const event = {
    sender: { session: options.session, mainFrame, insertCSS, removeInsertedCSS },
    senderFrame,
    frameId: 7,
    processId: 3,
  };
  return { event, insertCSS, removeInsertedCSS, frame };
}

/**
 * Drives a captured session listener for `url` and returns the response the
 * engine passed back (`{ cancel: true }` when blocked, `{}` when allowed).
 */
function requestThrough(listener: BeforeRequestListener, url: string): { cancel?: boolean } {
  let response: { cancel?: boolean } = {};
  listener({ id: 1, url, resourceType: "image", webContentsId: 42 }, (r) => {
    response = r;
  });
  return response;
}

/** Drives a captured CSP listener and returns the response it produced. */
function headersThrough(
  listener: HeadersListener,
  details: HeadersDetails,
): { responseHeaders?: Record<string, string[]>; statusLine?: string } {
  let response: { responseHeaders?: Record<string, string[]>; statusLine?: string } = {};
  listener(details, (r) => {
    response = r;
  });
  return response;
}

/** A fetch that always rejects, standing in for an unreachable network. */
const rejectingFetch: typeof fetch = async () => {
  throw new Error("no network in unit tests");
};

/**
 * A fetch returning filter `text` for list URLs and an empty JSON object for
 * the library's `resources.json` request (which it downloads alongside the
 * lists and JSON-parses).
 */
function fetchReturning(text: string): typeof fetch {
  return async (input) => {
    const url = String(input);
    return url.endsWith("resources.json") ? new Response("{}") : new Response(text);
  };
}

/**
 * Process-wide ownership in `blocker.ts` persists across tests, so every blocker
 * created in a test is disposed afterwards to release its session ownership and
 * IPC handlers. Dispose is best-effort here: a test that intentionally leaves a
 * throwing session may make `dispose` throw, which is swallowed.
 */
let tracked: Blocker[] = [];
function track<T extends Blocker>(blocker: T): T {
  tracked.push(blocker);
  return blocker;
}
afterEach(() => {
  for (const blocker of tracked) {
    try {
      blocker.dispose();
    } catch {
      // Already-disposed or throwing-detach blockers are fine to ignore here.
    }
  }
  tracked = [];
});

/** Attaches a fresh fake session to `blocker` and returns its handle. */
function attachSession(blocker: Blocker): { session: Session; state: SessionState } {
  const handle = makeFakeSession();
  blocker.attach(handle.session);
  return handle;
}

describe("createBlockerFromFilters", () => {
  test("blocks a targeted request and passes an untargeted one", () => {
    const blocker = track(createBlockerFromFilters(AD_FILTER, "fixture", cosmeticInternals()));
    const { session, state } = makeFakeSession();
    blocker.attach(session);

    expect(requestThrough(state.captured!, BLOCKED_URL)).toEqual({
      cancel: true,
    });
    expect(requestThrough(state.captured!, ALLOWED_URL)).toEqual({});
    expect(blocker.listVersion).toBe("fixture");
  });
});

describe("createBlocker", () => {
  test("prefers the cache and blocks the cached filter's target", async () => {
    const cached = ElectronBlocker.parse(AD_FILTER).serialize();
    const fs: BlockerFs = {
      readFile: async () => cached,
      writeFile: vi.fn(),
    };
    const blocker = track(
      await createBlocker({
        cacheFile: "engine.bin",
        fetch: rejectingFetch,
        fs,
        internals: cosmeticInternals(),
      }),
    );
    await blocker.refresh(); // remote unreachable; cache must survive

    expect(blocker.listVersion).toBe("cache");
    const { session, state } = makeFakeSession();
    blocker.attach(session);
    expect(requestThrough(state.captured!, BLOCKED_URL)).toEqual({
      cancel: true,
    });
  });

  test("degrades to none when there is no cache", async () => {
    const fs: BlockerFs = {
      readFile: async () => {
        throw new Error("ENOENT");
      },
      writeFile: vi.fn(),
    };
    const blocker = track(
      await createBlocker({
        cacheFile: "engine.bin",
        fetch: rejectingFetch,
        fs,
        internals: cosmeticInternals(),
      }),
    );
    await blocker.refresh();

    expect(blocker.listVersion).toBe("none");
    const { session, state } = makeFakeSession();
    blocker.attach(session);
    expect(requestThrough(state.captured!, BLOCKED_URL)).toEqual({});
  });

  test("writes the cache after a successful refresh", async () => {
    const writeFile = vi.fn<BlockerFs["writeFile"]>();
    const fs: BlockerFs = {
      readFile: async () => {
        throw new Error("ENOENT");
      },
      writeFile,
    };
    const blocker = track(
      await createBlocker({
        cacheFile: "engine.bin",
        fetch: fetchReturning(AD_FILTER),
        lists: ["https://example.test/list.txt"],
        fs,
        internals: cosmeticInternals(),
      }),
    );

    expect(await awaitReady(blocker)).toBe(true);
    expect(blocker.listVersion).toBe("remote");
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, data] = writeFile.mock.calls[0]!;
    expect(path).toBe("engine.bin");
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.byteLength).toBeGreaterThan(0);
  });

  test("resolves true and swaps in the engine even when the cache write fails", async () => {
    // A rejecting writeFile must not reject refresh(): createBlocker starts the
    // background refresh un-awaited, so a rejection would become an
    // unhandledRejection in the Electron main process.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const fs: BlockerFs = {
        readFile: async () => {
          throw new Error("ENOENT");
        },
        writeFile: async () => {
          throw new Error("EACCES");
        },
      };
      const blocker = track(
        await createBlocker({
          cacheFile: "engine.bin",
          fetch: fetchReturning(AD_FILTER),
          lists: ["https://example.test/list.txt"],
          fs,
          internals: cosmeticInternals(),
        }),
      );

      expect(await awaitReady(blocker)).toBe(true);
      expect(blocker.listVersion).toBe("remote");
      // The swapped-in engine still blocks the newly built filter's target.
      const { session, state } = makeFakeSession();
      blocker.attach(session);
      expect(requestThrough(state.captured!, BLOCKED_URL)).toEqual({
        cancel: true,
      });

      // Let any stray rejection surface on the microtask/macrotask queues.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("fails the build when a list response's content-length exceeds the cap", async () => {
    const oversizedFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("resources.json")) {
        return new Response("{}");
      }
      return new Response(AD_FILTER, {
        headers: { "content-length": String(65 * 1024 * 1024) },
      });
    };
    const fs: BlockerFs = {
      readFile: async () => {
        throw new Error("ENOENT");
      },
      writeFile: vi.fn(),
    };
    const blocker = track(
      await createBlocker({
        cacheFile: "engine.bin",
        fetch: oversizedFetch,
        lists: ["https://example.test/list.txt"],
        fs,
        internals: cosmeticInternals(),
      }),
    );

    // The oversized response aborts the build, so refresh fails and nothing is
    // swapped in (the startup cache miss leaves listVersion at "none").
    expect(await awaitReady(blocker)).toBe(false);
    expect(blocker.listVersion).toBe("none");
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  test("keeps the old engine on a failed refresh", async () => {
    const cached = ElectronBlocker.parse(AD_FILTER).serialize();
    const fs: BlockerFs = {
      readFile: async () => cached,
      writeFile: vi.fn(),
    };
    const blocker = track(
      await createBlocker({
        cacheFile: "engine.bin",
        fetch: rejectingFetch,
        lists: ["https://example.test/list.txt"],
        fs,
        internals: cosmeticInternals(),
      }),
    );

    expect(await blocker.refresh()).toBe(false);
    expect(blocker.listVersion).toBe("cache");
    const { session, state } = makeFakeSession();
    blocker.attach(session);
    expect(requestThrough(state.captured!, BLOCKED_URL)).toEqual({
      cancel: true,
    });
  });

  test("keeps every attached session attached across a refresh", async () => {
    const fs: BlockerFs = {
      readFile: async () => {
        throw new Error("ENOENT");
      },
      writeFile: vi.fn(),
    };
    const blocker = track(
      await createBlocker({
        cacheFile: "engine.bin",
        fetch: fetchReturning(AD_FILTER),
        lists: ["https://example.test/list.txt"],
        fs,
        internals: cosmeticInternals(),
      }),
    );
    const first = makeFakeSession();
    const second = makeFakeSession();
    blocker.attach(first.session);
    blocker.attach(second.session);

    expect(await awaitReady(blocker)).toBe(true);
    expect(blocker.attachedSessions()).toEqual([first.session, second.session]);
    // Each session's hook was registered exactly once (never re-registered).
    expect(first.state.registrations).toBe(1);
    expect(second.state.registrations).toBe(1);
    // Requests now block per the swapped-in engine.
    expect(requestThrough(first.state.captured!, BLOCKED_URL)).toEqual({
      cancel: true,
    });
    expect(requestThrough(second.state.captured!, BLOCKED_URL)).toEqual({
      cancel: true,
    });
  });

  test("delivers blocked events to a listener registered before refresh", async () => {
    const fs: BlockerFs = {
      readFile: async () => {
        throw new Error("ENOENT");
      },
      writeFile: vi.fn(),
    };
    const blocker = track(
      await createBlocker({
        cacheFile: "engine.bin",
        fetch: fetchReturning(AD_FILTER),
        lists: ["https://example.test/list.txt"],
        fs,
        internals: cosmeticInternals(),
      }),
    );
    const { session, state } = makeFakeSession();
    blocker.attach(session);
    const spy = vi.fn();
    blocker.onBlocked(spy);

    expect(await awaitReady(blocker)).toBe(true);
    requestThrough(state.captured!, BLOCKED_URL);
    // The library dispatches 'request-blocked' on a microtask; let it drain.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      webContentsId: 42,
      url: BLOCKED_URL,
    });
  });

  test("detach clears the session hook and drops the session", () => {
    const blocker = track(createBlockerFromFilters(AD_FILTER, "fixture", cosmeticInternals()));
    const { session, state } = makeFakeSession();
    blocker.attach(session);
    expect(state.captured).toBeDefined();
    expect(blocker.attachedSessions()).toEqual([session]);

    blocker.detach(session);

    // makeFakeSession's onBeforeRequest(null) path clears the captured listener.
    expect(state.captured).toBeUndefined();
    expect(blocker.attachedSessions()).toEqual([]);
  });

  test("onBlocked unsubscribe stops delivery for only that listener", async () => {
    const blocker = track(createBlockerFromFilters(AD_FILTER, "fixture", cosmeticInternals()));
    const { session, state } = makeFakeSession();
    blocker.attach(session);
    const kept = vi.fn();
    const removed = vi.fn();
    blocker.onBlocked(kept);
    const unsubscribe = blocker.onBlocked(removed);

    unsubscribe();
    requestThrough(state.captured!, BLOCKED_URL);
    // The library dispatches 'request-blocked' on a microtask; let it drain.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
    expect(kept).toHaveBeenCalledWith({ webContentsId: 42, url: BLOCKED_URL });
  });
});

describe("attach/detach registration and ownership", () => {
  test("attach registers two request hooks, one preload, and both IPC handlers", () => {
    const ipc = makeFakeIpc();
    const blocker = track(
      createBlockerFromFilters(AD_FILTER, "fixture", { ipc: ipc.ipc, preloadPath: "p.cjs" }),
    );
    const { state } = attachSession(blocker);

    expect(state.registrations).toBe(1);
    expect(state.headerRegistrations).toBe(1);
    expect(state.preloadCount).toBe(1);
    expect(state.registerCalls).toBe(1);
    expect([...ipc.handlers.keys()].sort()).toEqual([INJECT, MUTATION].sort());
    expect(ipc.stats.handle).toBe(2);
  });

  test("a second attach of the same session registers nothing more", () => {
    const ipc = makeFakeIpc();
    const blocker = track(
      createBlockerFromFilters(AD_FILTER, "fixture", { ipc: ipc.ipc, preloadPath: "p.cjs" }),
    );
    const { session, state } = makeFakeSession();
    blocker.attach(session);
    blocker.attach(session);

    expect(state.registrations).toBe(1);
    expect(state.headerRegistrations).toBe(1);
    expect(state.registerCalls).toBe(1);
    expect(ipc.stats.handle).toBe(2);
  });

  test("attaching a second session registers its hooks and preload but no second IPC handler", () => {
    const ipc = makeFakeIpc();
    const blocker = track(
      createBlockerFromFilters(AD_FILTER, "fixture", { ipc: ipc.ipc, preloadPath: "p.cjs" }),
    );
    attachSession(blocker);
    const second = attachSession(blocker);

    expect(second.state.registrations).toBe(1);
    expect(second.state.headerRegistrations).toBe(1);
    expect(second.state.preloadCount).toBe(1);
    // Still exactly two handlers, registered once, for the first attach only.
    expect(ipc.stats.handle).toBe(2);
    expect(ipc.handlers.size).toBe(2);
  });

  test("detaching one of two sessions removes only its hooks and preload", () => {
    const blocker = track(createBlockerFromFilters(AD_FILTER, "fixture", cosmeticInternals()));
    const first = attachSession(blocker);
    const second = attachSession(blocker);

    blocker.detach(first.session);

    expect(first.state.captured).toBeUndefined();
    expect(first.state.capturedHeaders).toBeUndefined();
    expect(first.state.preloadCount).toBe(0);
    // The other session is untouched.
    expect(second.state.captured).toBeDefined();
    expect(second.state.capturedHeaders).toBeDefined();
    expect(second.state.preloadCount).toBe(1);
    expect(blocker.attachedSessions()).toEqual([second.session]);
  });

  test("detaching the last session keeps both handlers", () => {
    const ipc = makeFakeIpc();
    const blocker = track(
      createBlockerFromFilters(AD_FILTER, "fixture", { ipc: ipc.ipc, preloadPath: "p.cjs" }),
    );
    const { session } = attachSession(blocker);
    blocker.detach(session);

    expect(blocker.attachedSessions()).toEqual([]);
    expect(ipc.handlers.size).toBe(2);
    expect(ipc.stats.remove).toBe(0);
  });

  test("a second blocker attaching a session the first still owns throws, touching nothing", () => {
    const ipc1 = makeFakeIpc();
    const ipc2 = makeFakeIpc();
    const first = track(
      createBlockerFromFilters(AD_FILTER, "fixture", { ipc: ipc1.ipc, preloadPath: "p.cjs" }),
    );
    const second = track(
      createBlockerFromFilters(AD_FILTER, "fixture", { ipc: ipc2.ipc, preloadPath: "p.cjs" }),
    );
    const { session, state } = makeFakeSession();
    first.attach(session);

    expect(() => second.attach(session)).toThrow();

    // The second blocker touched neither the session nor its own ipc.
    expect(ipc2.stats.handle).toBe(0);
    expect(ipc2.handlers.size).toBe(0);
    // The first blocker is unchanged.
    expect(state.registrations).toBe(1);
    expect(state.headerRegistrations).toBe(1);
    expect(state.preloadCount).toBe(1);
    expect(first.attachedSessions()).toEqual([session]);
    expect(ipc1.handlers.size).toBe(2);
  });

  test("a second blocker attaching an unowned session while the first holds handlers throws, touching nothing", () => {
    const ipc1 = makeFakeIpc();
    const ipc2 = makeFakeIpc();
    const first = track(
      createBlockerFromFilters(AD_FILTER, "fixture", { ipc: ipc1.ipc, preloadPath: "p.cjs" }),
    );
    const second = track(
      createBlockerFromFilters(AD_FILTER, "fixture", { ipc: ipc2.ipc, preloadPath: "p.cjs" }),
    );
    const owned = makeFakeSession();
    first.attach(owned.session);
    const other = makeFakeSession();

    expect(() => second.attach(other.session)).toThrow();

    // The unowned session and the second ipc were never touched.
    expect(other.state.registrations).toBe(0);
    expect(other.state.headerRegistrations).toBe(0);
    expect(other.state.preloadCount).toBe(0);
    expect(ipc2.stats.handle).toBe(0);
    expect(ipc2.handlers.size).toBe(0);
    // The first blocker still holds its handlers.
    expect(ipc1.handlers.size).toBe(2);
  });

  test("after the first blocker disposes, the second attaches that session with one new preload and its own handlers", () => {
    const ipc1 = makeFakeIpc();
    const ipc2 = makeFakeIpc();
    const first = track(
      createBlockerFromFilters(AD_FILTER, "fixture", { ipc: ipc1.ipc, preloadPath: "p.cjs" }),
    );
    const { session, state } = makeFakeSession();
    first.attach(session);
    first.dispose();

    expect(ipc1.handlers.size).toBe(0);
    expect(state.preloadCount).toBe(0);

    const second = track(
      createBlockerFromFilters(AD_FILTER, "fixture", { ipc: ipc2.ipc, preloadPath: "p.cjs" }),
    );
    second.attach(session);

    expect(ipc2.handlers.size).toBe(2);
    expect(state.registerCalls).toBe(2); // one per blocker
    expect(state.preloadCount).toBe(1);
    expect(second.attachedSessions()).toEqual([session]);
  });

  test("dispose detaches remaining sessions, removes both handlers, and a later attach throws", () => {
    const ipc = makeFakeIpc();
    const blocker = track(
      createBlockerFromFilters(AD_FILTER, "fixture", { ipc: ipc.ipc, preloadPath: "p.cjs" }),
    );
    const first = attachSession(blocker);
    const second = attachSession(blocker);

    blocker.dispose();

    expect(blocker.attachedSessions()).toEqual([]);
    expect(first.state.preloadCount).toBe(0);
    expect(second.state.preloadCount).toBe(0);
    expect(ipc.handlers.size).toBe(0);
    const late = makeFakeSession();
    expect(() => blocker.attach(late.session)).toThrow();
  });

  test("dispose where one detach throws still detaches the others, removes handlers, and rethrows", () => {
    const ipc = makeFakeIpc();
    const blocker = track(
      createBlockerFromFilters(AD_FILTER, "fixture", { ipc: ipc.ipc, preloadPath: "p.cjs" }),
    );
    const first = attachSession(blocker);
    const second = attachSession(blocker);
    first.state.unregisterThrows = true;

    expect(() => blocker.dispose()).toThrow("unregisterPreloadScript failed");

    // The good session was fully detached and both handlers removed.
    expect(second.state.captured).toBeUndefined();
    expect(second.state.capturedHeaders).toBeUndefined();
    expect(second.state.preloadCount).toBe(0);
    expect(ipc.handlers.size).toBe(0);
    // The failing session still cleared its request hooks and left the set.
    expect(first.state.captured).toBeUndefined();
    expect(first.state.capturedHeaders).toBeUndefined();
    expect(blocker.attachedSessions()).toEqual([]);
  });

  test("after a dispose whose preload-unregister threw, a replacement reuses the preload and injects once", async () => {
    const ipc1 = makeFakeIpc();
    const doomed = track(
      createBlockerFromFilters(AD_FILTER, "fixture", { ipc: ipc1.ipc, preloadPath: "p.cjs" }),
    );
    const { session, state } = makeFakeSession();
    doomed.attach(session);
    state.unregisterThrows = true;
    expect(() => doomed.dispose()).toThrow();

    // The fake still reports one registered preload (unregister threw).
    expect(state.preloadCount).toBe(1);

    const ipc2 = makeFakeIpc();
    const replacement = track(
      createBlockerFromFilters(HIDE_FILTER, "fixture", { ipc: ipc2.ipc, preloadPath: "p.cjs" }),
    );
    replacement.attach(session);

    // No second preload registered — the registry entry was reused.
    expect(state.registerCalls).toBe(1);

    const { event, insertCSS } = makeFakeEvent({ session, frameUrl: PAGE_URL, kind: "top" });
    await ipc2.invoke(INJECT, event, PAGE_URL, undefined);

    expect(insertCSS).toHaveBeenCalledTimes(1);
  });

  test("detaching an unattached session is a no-op", () => {
    const blocker = track(createBlockerFromFilters(AD_FILTER, "fixture", cosmeticInternals()));
    const { session, state } = makeFakeSession();

    expect(() => blocker.detach(session)).not.toThrow();
    expect(state.unregisterCalls).toBe(0);
    expect(blocker.attachedSessions()).toEqual([]);
  });

  test("attach where registerPreloadScript throws clears both request hooks, leaves the session unattached, and rethrows", () => {
    const ipc = makeFakeIpc();
    const blocker = track(
      createBlockerFromFilters(AD_FILTER, "fixture", { ipc: ipc.ipc, preloadPath: "p.cjs" }),
    );
    const { session, state } = makeFakeSession();
    state.registerThrows = true;

    expect(() => blocker.attach(session)).toThrow("registerPreloadScript failed");

    expect(state.captured).toBeUndefined();
    expect(state.capturedHeaders).toBeUndefined();
    expect(state.preloadCount).toBe(0);
    expect(blocker.attachedSessions()).toEqual([]);
    // Handlers stay registered once installed.
    expect(ipc.handlers.size).toBe(2);
  });

  test("detach where unregisterPreloadScript throws clears hooks, drops the session, rethrows, and the next attach reuses the preload", () => {
    const blocker = track(createBlockerFromFilters(AD_FILTER, "fixture", cosmeticInternals()));
    const { session, state } = makeFakeSession();
    blocker.attach(session);
    expect(state.registerCalls).toBe(1);

    state.unregisterThrows = true;
    expect(() => blocker.detach(session)).toThrow("unregisterPreloadScript failed");

    expect(state.captured).toBeUndefined();
    expect(state.capturedHeaders).toBeUndefined();
    expect(blocker.attachedSessions()).toEqual([]);

    // A following attach reuses the still-registered preload id.
    state.unregisterThrows = false;
    blocker.attach(session);
    expect(state.registerCalls).toBe(1);
    expect(state.captured).toBeDefined();
    expect(state.capturedHeaders).toBeDefined();
    expect(blocker.attachedSessions()).toEqual([session]);
  });
});

describe("CSP callback", () => {
  const CSP_FILTERS = ["none.example$csp=script-src 'none'", "self.example$csp=script-src 'self'"].join(
    "\n",
  );
  const OK = "HTTP/1.1 200 OK";

  function attachCsp(): HeadersListener {
    const blocker = track(createBlockerFromFilters(CSP_FILTERS, "fixture", cosmeticInternals()));
    const { state } = attachSession(blocker);
    return state.capturedHeaders!;
  }

  test("adds the filter directives as the sole CSP value when none exists", () => {
    const out = headersThrough(attachCsp(), {
      url: "https://none.example/",
      resourceType: "mainFrame",
      statusLine: OK,
      responseHeaders: { "x-other": ["keep"] },
    });

    expect(out.responseHeaders?.["Content-Security-Policy"]).toEqual(["script-src 'none'"]);
    expect(out.responseHeaders?.["x-other"]).toEqual(["keep"]);
    expect(out.statusLine).toBe(OK);
  });

  test("appends the directives as an extra value, leaving existing CSP and report-only untouched", () => {
    const responseHeaders = {
      "Content-Security-Policy": ["default-src 'self'", "img-src 'self'"],
      "Content-Security-Policy-Report-Only": ["report-uri /r"],
    };
    const out = headersThrough(attachCsp(), {
      url: "https://none.example/",
      resourceType: "mainFrame",
      statusLine: OK,
      responseHeaders,
    });

    expect(out.responseHeaders?.["Content-Security-Policy"]).toEqual([
      "default-src 'self'",
      "img-src 'self'",
      "script-src 'none'",
    ]);
    expect(out.responseHeaders?.["Content-Security-Policy-Report-Only"]).toEqual(["report-uri /r"]);
    // The input array was not mutated.
    expect(responseHeaders["Content-Security-Policy"]).toEqual(["default-src 'self'", "img-src 'self'"]);
  });

  test("keeps a stricter existing value as its own array entry (case-insensitive header match)", () => {
    const out = headersThrough(attachCsp(), {
      url: "https://self.example/",
      resourceType: "mainFrame",
      statusLine: OK,
      responseHeaders: { "content-security-policy": ["script-src 'none'"] },
    });

    // The existing lowercase key is reused, keeping 'none' and adding 'self'.
    expect(out.responseHeaders?.["content-security-policy"]).toEqual([
      "script-src 'none'",
      "script-src 'self'",
    ]);
  });

  test("treats a matching subFrame response like a main frame", () => {
    const out = headersThrough(attachCsp(), {
      url: "https://none.example/",
      resourceType: "subFrame",
      statusLine: OK,
      responseHeaders: {},
    });

    expect(out.responseHeaders?.["Content-Security-Policy"]).toEqual(["script-src 'none'"]);
  });

  test("passes an unmatched frame response and a matched non-frame response through unchanged", () => {
    const listener = attachCsp();

    const frameHeaders = { "x-a": ["1"] };
    const frameOut = headersThrough(listener, {
      url: "https://other.example/",
      resourceType: "mainFrame",
      statusLine: OK,
      responseHeaders: frameHeaders,
    });
    expect(frameOut.responseHeaders).toBe(frameHeaders);
    expect(frameOut.statusLine).toBe(OK);

    const imageHeaders = { "x-b": ["2"] };
    const imageOut = headersThrough(listener, {
      url: "https://none.example/", // host has a $csp rule, but image is not a frame
      resourceType: "image",
      statusLine: OK,
      responseHeaders: imageHeaders,
    });
    expect(imageOut.responseHeaders).toBe(imageHeaders);
    expect(imageOut.statusLine).toBe(OK);
  });
});

describe("cosmetic IPC handlers", () => {
  function makeCosmeticBlocker(ipc: BlockerIpc): Blocker {
    return track(
      createBlockerFromFilters([HIDE_FILTER, SCRIPTLET_FILTER].join("\n"), "fixture", {
        ipc,
        preloadPath: "p.cjs",
        resources: RESOURCES,
      }),
    );
  }

  test("an accepted top-frame sender gets insertCSS with cssOrigin user and scriptlets via executeJavaScript", async () => {
    const ipc = makeFakeIpc();
    const blocker = makeCosmeticBlocker(ipc.ipc);
    const { session } = attachSession(blocker);
    const { event, insertCSS, frame } = makeFakeEvent({ session, frameUrl: PAGE_URL, kind: "top" });

    const result = await ipc.invoke(INJECT, event, PAGE_URL, undefined);

    expect(result).toBeUndefined();
    expect(insertCSS).toHaveBeenCalledTimes(1);
    expect(insertCSS).toHaveBeenCalledWith(HIDE_STYLES, { cssOrigin: "user" });
    // The scriptlet runs through the sender frame with a single argument.
    expect(frame.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(frame.executeJavaScript.mock.calls[0]).toHaveLength(1);
    expect(String(frame.executeJavaScript.mock.calls[0]![0])).toContain("zeoScriptlet");
  });

  test("an accepted child-frame sender gets a style element and scriptlets via executeJavaScript, never insertCSS", async () => {
    const ipc = makeFakeIpc();
    const blocker = makeCosmeticBlocker(ipc.ipc);
    const { session } = attachSession(blocker);
    const { event, insertCSS, frame } = makeFakeEvent({ session, frameUrl: PAGE_URL, kind: "child" });

    await ipc.invoke(INJECT, event, PAGE_URL, undefined);

    expect(insertCSS).not.toHaveBeenCalled();
    // First the style element, then the scriptlet — both on the child frame.
    expect(frame.executeJavaScript).toHaveBeenCalledTimes(2);
    const styleCall = String(frame.executeJavaScript.mock.calls[0]![0]);
    expect(styleCall).toContain("data-zeo-cosmetic");
    expect(styleCall).toContain(".ad-slot");
    expect(String(frame.executeJavaScript.mock.calls[1]![0])).toContain("zeoScriptlet");
  });

  test("a destroyed sender frame injects nothing and resolves undefined then false", async () => {
    const ipc = makeFakeIpc();
    const blocker = makeCosmeticBlocker(ipc.ipc);
    const { session } = attachSession(blocker);
    const { event, insertCSS, frame } = makeFakeEvent({
      session,
      frameUrl: PAGE_URL,
      kind: "top",
      destroyed: true,
    });

    // Both handlers reject a destroyed frame before touching the engine.
    expect(await ipc.invoke(INJECT, event, PAGE_URL, undefined)).toBeUndefined();
    expect(await ipc.invoke(MUTATION, event)).toBe(false);
    expect(insertCSS).not.toHaveBeenCalled();
    expect(frame.executeJavaScript).not.toHaveBeenCalled();
  });

  test("a child-frame dom-update injects a DOM-matched class via a data-zeo-cosmetic style, never insertCSS", async () => {
    // A generic (host-less) class-hiding rule: the engine returns it only when
    // the class token arrives on a dom-update message (getRulesFromDOM), never
    // on the first run.
    const ipc = makeFakeIpc();
    const blocker = track(
      createBlockerFromFilters("##.some-class", "fixture", { ipc: ipc.ipc, preloadPath: "p.cjs" }),
    );
    const { session } = attachSession(blocker);
    const { event, insertCSS, frame } = makeFakeEvent({ session, frameUrl: PAGE_URL, kind: "child" });

    // First run carries no DOM tokens, so the generic rule yields no styles.
    await ipc.invoke(INJECT, event, PAGE_URL, undefined);
    expect(frame.executeJavaScript).not.toHaveBeenCalled();

    // The dom-update supplies the class token, so the rule now matches and is
    // written into the single reused <style data-zeo-cosmetic> element.
    await ipc.invoke(INJECT, event, PAGE_URL, {
      classes: ["some-class"],
      ids: [],
      hrefs: [],
      lifecycle: "dom-update",
    });

    expect(frame.executeJavaScript).toHaveBeenCalledTimes(1);
    const styleCall = String(frame.executeJavaScript.mock.calls[0]![0]);
    expect(styleCall).toContain("data-zeo-cosmetic");
    expect(styleCall).toContain(".some-class");
    expect(insertCSS).not.toHaveBeenCalled();
  });

  test("identical top-frame CSS on a rescan is not inserted a second time", async () => {
    const ipc = makeFakeIpc();
    const blocker = makeCosmeticBlocker(ipc.ipc);
    const { session } = attachSession(blocker);
    const { event, insertCSS, removeInsertedCSS } = makeFakeEvent({
      session,
      frameUrl: PAGE_URL,
      kind: "top",
    });

    // Two runs of the same host-scoped rule yield identical styles; the second
    // is deduped, so no second sheet is inserted and the first is not removed.
    await ipc.invoke(INJECT, event, PAGE_URL, undefined);
    await ipc.invoke(INJECT, event, PAGE_URL, undefined);

    expect(insertCSS).toHaveBeenCalledTimes(1);
    expect(insertCSS).toHaveBeenCalledWith(HIDE_STYLES, { cssOrigin: "user" });
    expect(removeInsertedCSS).not.toHaveBeenCalled();
  });

  test("changed top-frame CSS removes the previous sheet before inserting the new one", async () => {
    // A host-scoped rule (first run) and a generic class rule (dom-update) yield
    // different stylesheets, so the rescan must remove the first sheet by its
    // key before inserting the second.
    const ipc = makeFakeIpc();
    const blocker = track(
      createBlockerFromFilters("example.com##.ad-slot\n##.some-class", "fixture", {
        ipc: ipc.ipc,
        preloadPath: "p.cjs",
      }),
    );
    const { session } = attachSession(blocker);
    const { event, insertCSS, removeInsertedCSS } = makeFakeEvent({
      session,
      frameUrl: PAGE_URL,
      kind: "top",
    });

    await ipc.invoke(INJECT, event, PAGE_URL, undefined);
    const firstKey = await insertCSS.mock.results[0]!.value;
    await ipc.invoke(INJECT, event, PAGE_URL, {
      classes: ["some-class"],
      ids: [],
      hrefs: [],
      lifecycle: "dom-update",
    });

    expect(insertCSS).toHaveBeenCalledTimes(2);
    expect(insertCSS.mock.calls[0]![0]).toBe(HIDE_STYLES);
    expect(insertCSS.mock.calls[1]![0]).toBe(".some-class { display: none !important; }");
    expect(removeInsertedCSS).toHaveBeenCalledTimes(1);
    expect(removeInsertedCSS).toHaveBeenCalledWith(firstKey);
  });

  test("an accepted sender's mutation query returns the engine's setting", async () => {
    const ipc = makeFakeIpc();
    const blocker = makeCosmeticBlocker(ipc.ipc);
    const { session } = attachSession(blocker);
    const { event } = makeFakeEvent({ session, frameUrl: PAGE_URL, kind: "top" });

    expect(await ipc.invoke(MUTATION, event)).toBe(true);
  });

  test("rejects a sender whose session is not attached", async () => {
    const ipc = makeFakeIpc();
    const blocker = makeCosmeticBlocker(ipc.ipc);
    attachSession(blocker); // attaches a different session
    const stranger = makeFakeSession();
    const { event, insertCSS, frame } = makeFakeEvent({
      session: stranger.session,
      frameUrl: PAGE_URL,
      kind: "top",
    });

    expect(await ipc.invoke(INJECT, event, PAGE_URL, undefined)).toBeUndefined();
    expect(await ipc.invoke(MUTATION, event)).toBe(false);
    expect(insertCSS).not.toHaveBeenCalled();
    expect(frame.executeJavaScript).not.toHaveBeenCalled();
  });

  test("rejects a sender whose senderFrame is null", async () => {
    const ipc = makeFakeIpc();
    const blocker = makeCosmeticBlocker(ipc.ipc);
    const { session } = attachSession(blocker);
    const { event, insertCSS } = makeFakeEvent({
      session,
      frameUrl: PAGE_URL,
      kind: "top",
      senderFrameNull: true,
    });

    expect(await ipc.invoke(INJECT, event, PAGE_URL, undefined)).toBeUndefined();
    expect(await ipc.invoke(MUTATION, event)).toBe(false);
    expect(insertCSS).not.toHaveBeenCalled();
  });

  test("rejects a sender whose url differs from senderFrame.url", async () => {
    const ipc = makeFakeIpc();
    const blocker = makeCosmeticBlocker(ipc.ipc);
    const { session } = attachSession(blocker);
    const { event, insertCSS, frame } = makeFakeEvent({ session, frameUrl: PAGE_URL, kind: "top" });

    expect(await ipc.invoke(INJECT, event, "https://example.com/other", undefined)).toBeUndefined();
    expect(insertCSS).not.toHaveBeenCalled();
    expect(frame.executeJavaScript).not.toHaveBeenCalled();
  });

  test("after the last detach an invoke still resolves (handlers stay)", async () => {
    const ipc = makeFakeIpc();
    const blocker = makeCosmeticBlocker(ipc.ipc);
    const { session } = attachSession(blocker);
    blocker.detach(session);
    const { event, insertCSS } = makeFakeEvent({ session, frameUrl: PAGE_URL, kind: "top" });

    expect(ipc.handlers.size).toBe(2);
    expect(await ipc.invoke(INJECT, event, PAGE_URL, undefined)).toBeUndefined();
    expect(await ipc.invoke(MUTATION, event)).toBe(false);
    expect(insertCSS).not.toHaveBeenCalled();
  });

  test("a scriptlet whose executeJavaScript rejects does not reject the handler or skip the next scriptlet", async () => {
    // Two host-scoped scriptlet rules so the engine yields two scripts for the
    // accepted first-run sender; the first executeJavaScript rejects.
    const TWO_SCRIPTLETS = ["example.com##+js(zeo-mark)", "example.com##+js(zeo-mark2)"].join("\n");
    const TWO_RESOURCES = JSON.stringify({
      scriptlets: [
        {
          name: "zeo-mark.js",
          aliases: [],
          body: "document.documentElement.dataset.zeoScriptlet = 'ran';",
          dependencies: [],
        },
        {
          name: "zeo-mark2.js",
          aliases: [],
          body: "document.documentElement.dataset.zeoScriptlet2 = 'ran';",
          dependencies: [],
        },
      ],
      redirects: [],
    });
    const ipc = makeFakeIpc();
    const blocker = track(
      createBlockerFromFilters(TWO_SCRIPTLETS, "fixture", {
        ipc: ipc.ipc,
        preloadPath: "p.cjs",
        resources: TWO_RESOURCES,
      }),
    );
    const { session } = attachSession(blocker);
    const { event, frame } = makeFakeEvent({ session, frameUrl: PAGE_URL, kind: "top" });
    // First scriptlet rejects, the rest resolve. The handler must catch the
    // rejection per-scriptlet, so it resolves and still runs the second one.
    frame.executeJavaScript = vi
      .fn()
      .mockRejectedValueOnce(new Error("scriptlet boom"))
      .mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Resolves (not rejects) despite the first scriptlet throwing.
      expect(await ipc.invoke(INJECT, event, PAGE_URL, undefined)).toBeUndefined();
      // The second scriptlet still ran after the first threw.
      expect(frame.executeJavaScript).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("after dispose the fake ipc holds no handlers", () => {
    const ipc = makeFakeIpc();
    const blocker = makeCosmeticBlocker(ipc.ipc);
    attachSession(blocker);
    blocker.dispose();

    expect(ipc.handlers.size).toBe(0);
  });
});

describe("refresh keeps the same callbacks working against the new engine", () => {
  test("a $csp and an element-hiding rule present only in the new lists take effect with no re-attach", async () => {
    const newList = [HIDE_FILTER, "example.com$csp=script-src 'none'"].join("\n");
    const fs: BlockerFs = {
      readFile: async () => {
        throw new Error("ENOENT");
      },
      writeFile: vi.fn(),
    };
    const ipc = makeFakeIpc();
    const blocker = track(
      await createBlocker({
        cacheFile: "engine.bin",
        fetch: fetchReturning(newList),
        lists: ["https://example.test/list.txt"],
        fs,
        internals: { ipc: ipc.ipc, preloadPath: "p.cjs" },
      }),
    );
    const { session, state } = makeFakeSession();
    blocker.attach(session);

    // Before refresh the empty engine injects nothing.
    const before = headersThrough(state.capturedHeaders!, {
      url: PAGE_URL,
      resourceType: "mainFrame",
      statusLine: "HTTP/1.1 200 OK",
      responseHeaders: {},
    });
    expect(before.responseHeaders?.["Content-Security-Policy"]).toBeUndefined();

    expect(await awaitReady(blocker)).toBe(true);

    // The same captured CSP callback now sees the refreshed engine.
    const after = headersThrough(state.capturedHeaders!, {
      url: PAGE_URL,
      resourceType: "mainFrame",
      statusLine: "HTTP/1.1 200 OK",
      responseHeaders: {},
    });
    expect(after.responseHeaders?.["Content-Security-Policy"]).toEqual(["script-src 'none'"]);

    // And the same registered inject handler injects the new element-hiding rule.
    const { event, insertCSS } = makeFakeEvent({ session, frameUrl: PAGE_URL, kind: "top" });
    await ipc.invoke(INJECT, event, PAGE_URL, undefined);
    expect(insertCSS).toHaveBeenCalledWith(HIDE_STYLES, { cssOrigin: "user" });
  });

  test("scriptlet resources survive a refresh so ##+js rules still resolve", async () => {
    // The rebuilt engine has no resource text of its own (the fetched
    // resources.json is empty), so refresh must re-apply the configured
    // resources or the scriptlet rule stops resolving after the first refresh.
    const newList = [HIDE_FILTER, SCRIPTLET_FILTER].join("\n");
    const fs: BlockerFs = {
      readFile: async () => {
        throw new Error("ENOENT");
      },
      writeFile: vi.fn(),
    };
    const ipc = makeFakeIpc();
    const blocker = track(
      await createBlocker({
        cacheFile: "engine.bin",
        fetch: fetchReturning(newList),
        lists: ["https://example.test/list.txt"],
        fs,
        internals: { ipc: ipc.ipc, preloadPath: "p.cjs", resources: RESOURCES },
      }),
    );
    const { session } = attachSession(blocker);

    expect(await awaitReady(blocker)).toBe(true);
    expect(blocker.listVersion).toBe("remote");

    // The same registered inject handler runs the scriptlet against the rebuilt
    // engine, because refresh re-applied the resources before the swap.
    const { event, frame } = makeFakeEvent({ session, frameUrl: PAGE_URL, kind: "top" });
    await ipc.invoke(INJECT, event, PAGE_URL, undefined);
    const ran = frame.executeJavaScript.mock.calls.map((c) => String(c[0]!));
    expect(ran.some((code) => code.includes("zeoScriptlet"))).toBe(true);
  });
});
