import { describe, expect, test, vi } from "vitest";
import { ElectronBlocker } from "@ghostery/adblocker-electron";
import type { Session } from "electron";
import {
  createBlocker,
  createBlockerFromFilters,
  type Blocker,
  type BlockerFs,
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

/** The details shape the wrapper's session hook forwards to the engine. */
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

/**
 * A hand-written fake `Session` recording the currently registered
 * `onBeforeRequest` listener and how many times one was registered.
 */
function makeFakeSession(): {
  session: Session;
  state: { captured?: BeforeRequestListener; registrations: number };
} {
  const state: { captured?: BeforeRequestListener; registrations: number } = {
    captured: undefined,
    registrations: 0,
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
    },
  };
  return { session: session as unknown as Session, state };
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

describe("createBlockerFromFilters", () => {
  test("blocks a targeted request and passes an untargeted one", () => {
    const blocker = createBlockerFromFilters(AD_FILTER);
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
    const blocker = await createBlocker({
      cacheFile: "engine.bin",
      fetch: rejectingFetch,
      fs,
    });
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
    const blocker = await createBlocker({
      cacheFile: "engine.bin",
      fetch: rejectingFetch,
      fs,
    });
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
    const blocker = await createBlocker({
      cacheFile: "engine.bin",
      fetch: fetchReturning(AD_FILTER),
      lists: ["https://example.test/list.txt"],
      fs,
    });

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
      const blocker = await createBlocker({
        cacheFile: "engine.bin",
        fetch: fetchReturning(AD_FILTER),
        lists: ["https://example.test/list.txt"],
        fs,
      });

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
    const blocker = await createBlocker({
      cacheFile: "engine.bin",
      fetch: oversizedFetch,
      lists: ["https://example.test/list.txt"],
      fs,
    });

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
    const blocker = await createBlocker({
      cacheFile: "engine.bin",
      fetch: rejectingFetch,
      lists: ["https://example.test/list.txt"],
      fs,
    });

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
    const blocker = await createBlocker({
      cacheFile: "engine.bin",
      fetch: fetchReturning(AD_FILTER),
      lists: ["https://example.test/list.txt"],
      fs,
    });
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
    const blocker = await createBlocker({
      cacheFile: "engine.bin",
      fetch: fetchReturning(AD_FILTER),
      lists: ["https://example.test/list.txt"],
      fs,
    });
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
    const blocker = createBlockerFromFilters(AD_FILTER);
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
    const blocker = createBlockerFromFilters(AD_FILTER);
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
