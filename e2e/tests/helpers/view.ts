import { expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";

// PRD 9.1 — shared helpers that poll the LIVE view URL in the main process
// before a spec snapshots or asserts on it. Every helper takes the
// `ElectronApplication` handle the spec already holds and evaluates through
// `app.evaluate`, exactly as the inline probes these replace did. `webContents`
// and `session` inside each callback are typed from `typeof import("electron")`,
// so `wc`/`w` are `electron.WebContents` by inference — no `any`.

/**
 * Poll timeout for any assertion that waits on a WebContentsView being created,
 * destroyed, navigated, or moved between partitions. One constant so a future
 * runner slowdown is tuned in a single place (a cold macOS runner can exceed
 * Playwright's default 5 s tearing down and recreating a view — issue #66).
 */
export const VIEW_POLL_TIMEOUT_MS = 20_000;

/**
 * Poll the main process until some live WebContents has a URL containing
 * `urlSubstring`. Resolves on the first observation; rejects with the poll
 * failure when {@link VIEW_POLL_TIMEOUT_MS} elapses.
 */
export async function waitForViewUrl(
  app: ElectronApplication,
  urlSubstring: string,
): Promise<void> {
  await expect
    .poll(
      () =>
        app.evaluate(
          ({ webContents }, sub) =>
            webContents.getAllWebContents().some((w) => w.getURL().includes(sub)),
          urlSubstring,
        ),
      {
        timeout: VIEW_POLL_TIMEOUT_MS,
        message: `expected a live view URL to contain "${urlSubstring}"`,
      },
    )
    .toBe(true);
}

/**
 * Poll until some live WebContents has a URL containing `urlSubstring` AND runs
 * on `persist:<profileId>`'s Session by identity — the assertion shape the
 * profile-migration test uses (`wc.session === session.fromPartition(...)`).
 */
export async function waitForViewOnPartition(
  app: ElectronApplication,
  urlSubstring: string,
  profileId: string,
): Promise<void> {
  await expect
    .poll(
      () =>
        app.evaluate(
          ({ session, webContents }, data) => {
            const wc = webContents
              .getAllWebContents()
              .find((w) => w.getURL().includes(data.sub));
            return (
              wc !== undefined &&
              wc.session === session.fromPartition("persist:" + data.profileId)
            );
          },
          { sub: urlSubstring, profileId },
        ),
      {
        timeout: VIEW_POLL_TIMEOUT_MS,
        message: `expected a live view for "${urlSubstring}" on partition persist:${profileId}`,
      },
    )
    .toBe(true);
}

/**
 * Poll until NO live WebContents has a URL containing `urlSubstring`. A torn-down
 * WebContents can stay enumerable for a tick after `close()`, so polling to
 * absence is the assertion a "the view is gone" check means.
 */
export async function waitForViewGone(
  app: ElectronApplication,
  urlSubstring: string,
): Promise<void> {
  await expect
    .poll(
      () =>
        app.evaluate(
          ({ webContents }, sub) =>
            webContents.getAllWebContents().some((w) => w.getURL().includes(sub)),
          urlSubstring,
        ),
      {
        timeout: VIEW_POLL_TIMEOUT_MS,
        message: `expected no live view URL to contain "${urlSubstring}"`,
      },
    )
    .toBe(false);
}

/**
 * Poll until every live WebContents is either destroyed or not loading.
 *
 * For tests that deliberately depend on a load having FINISHED: page content,
 * a title or favicon that only lands on load, history recorded by the load,
 * `canGoBack` after it, blocking counts, or a later step that must not overlap
 * a still-running load (e.g. a focus assertion on a surface other than the
 * command bar). It is NOT needed just to drive the command bar: an open bar
 * keeps its selected row by identity across a background re-rank, remaps a row
 * click rendered against a background-superseded list, and takes focus back
 * from a loading tab view instead of closing (issue #179). A test that asserts
 * specific data should prefer the narrower wait for it (`waitForViewUrl`, a
 * title poll) over settling every view.
 *
 * `isLoading()` is a deterministic gate: a view starts loading synchronously on
 * creation/navigation (so it's never momentarily "not loading yet" right after
 * `tabs.create`), and it also goes false on a failed load, not just a
 * successful one, so this can't hang on a broken URL.
 */
export async function waitForViewsIdle(app: ElectronApplication): Promise<void> {
  await expect
    .poll(
      () =>
        app.evaluate(({ webContents }) =>
          webContents.getAllWebContents().every((w) => w.isDestroyed() || !w.isLoading()),
        ),
      {
        timeout: VIEW_POLL_TIMEOUT_MS,
        message: "expected all live views to finish loading",
      },
    )
    .toBe(true);
}

/**
 * Find the live view whose URL contains `currentUrlSubstring`, navigate it to
 * `url`, then wait until `getURL()` observably reports `url` so the caller's next
 * step runs only once the navigation is visible in the main process. A `data:`
 * URL is passed verbatim as the substring. Throws when no matching view exists.
 */
export async function loadViewUrl(
  app: ElectronApplication,
  currentUrlSubstring: string,
  url: string,
): Promise<void> {
  await app.evaluate(
    async ({ webContents }, data) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getURL().includes(data.sub));
      if (wc === undefined) {
        throw new Error(`live view for ${data.sub} not found`);
      }
      await wc.loadURL(data.url);
    },
    { sub: currentUrlSubstring, url },
  );
  await waitForViewUrl(app, url);
}

/**
 * The renderer window that hosts the command-bar overlay (the WebContentsView
 * loading `?view=command-bar`). Polls every open window for the one exposing
 * data-testid="command-bar", up to 15 s: `firstWindow()` cannot be trusted
 * because each tab view also surfaces as a window, and a navigating view can
 * momentarily lose its execution context. The overlay page always renders the
 * bar surface (main drives visibility by showing/hiding the hosting view), so
 * its DOM is queryable whether or not the bar is open. While the find surface is
 * active the overlay carries no `command-bar` element, so resolve it before
 * opening find.
 */
export async function commandBarWindow(app: ElectronApplication): Promise<Page> {
  await app.firstWindow();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if ((await w.getByTestId("command-bar").count()) > 0) {
          return w;
        }
      } catch {
        // A navigating WebContentsView can momentarily lose its execution
        // context; skip any window we can't query this pass.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error('No renderer window exposing data-testid="command-bar" was found within 15s');
}
