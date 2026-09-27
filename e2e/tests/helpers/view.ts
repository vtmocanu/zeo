import { expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";

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
 * Driving the command bar while a tab view is still loading is flaky: when
 * that load finishes, the tab view's `did-finish-load` handler calls
 * `onStateApplied` and re-ranks the (still open) command bar, resetting
 * `selectedIndex` and bumping `revision` out from under an in-flight test
 * step; separately, the load can also steal native focus from the overlay,
 * which fires the overlay's `blur` handler and closes the bar entirely. The
 * two are separate events, but both happen while the view is still loading
 * (`did-finish-load` fires before `isLoading()` turns false), so settling on
 * `!isLoading()` before opening or driving the bar lands after both.
 * `isLoading()` is a deterministic gate here because a view
 * starts loading synchronously on creation/navigation (so it's never
 * momentarily "not loading yet" right after `tabs.create`), and it also goes
 * false on a failed load, not just a successful one, so this can't hang on a
 * broken URL.
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
