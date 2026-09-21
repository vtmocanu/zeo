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
