import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { Download, Favorite, Space } from "@zeo/core";
import { BottomBar, SpaceItem, spaceEditLabel, summarizeDownloads } from "./BottomBar.js";
import { Favicon, faviconLetter } from "./Favicon.js";
import { FavoritesGrid, tileDropEdge } from "./FavoritesGrid.js";
import { Icon } from "./icons.js";
import { URL_PILL_PLACEHOLDER, UrlPill } from "./UrlPill.js";

function favorite(id: string, title = id): Favorite {
  return { id, url: `https://${id}.test/`, title, faviconUrl: null, position: 0, createdAt: 0 };
}

function space(id: string, name: string): Space {
  return { id, name, profileId: "p1", createdAt: 0, theme: null };
}

function download(state: Download["state"], receivedBytes: number, totalBytes: number): Download {
  return {
    id: `d-${state}-${receivedBytes}`,
    url: "https://files.test/a",
    filename: "a",
    path: "/tmp/a",
    totalBytes,
    receivedBytes,
    state,
    startedAt: 0,
    completedAt: null,
    spaceId: null,
  };
}

/** Text content of static markup: tags stripped, entities left alone. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

describe("Icon", () => {
  test("size sets width and height and keeps the 16-unit viewBox", () => {
    const html = renderToStaticMarkup(<Icon name="close" size={12} />);
    expect(html).toContain('width="12"');
    expect(html).toContain('height="12"');
    expect(html).toContain('viewBox="0 0 16 16"');
  });

  test.each(["plus", "close", "download", "archive", "shield", "shield-off", "chevron-down"] as const)(
    "%s draws a path in currentColor",
    (name) => {
      const html = renderToStaticMarkup(<Icon name={name} />);
      expect(html).toContain('stroke="currentColor"');
      expect(html).toMatch(/<(path|rect)/);
    },
  );
});

describe("Favicon", () => {
  test("24px fallback is the upper-cased first letter of the title", () => {
    expect(faviconLetter("  github")).toBe("G");
    expect(faviconLetter("")).toBe("◦");
    const html = renderToStaticMarkup(<Favicon url={null} title="mail" size={24} />);
    expect(html).toContain("favicon--letter");
    expect(text(html)).toBe("M");
  });

  test("16px keeps the tab-row markup", () => {
    expect(renderToStaticMarkup(<Favicon url="https://x/icon.png" title="x" />)).toContain(
      'class="tab-item__favicon"',
    );
  });
});

describe("UrlPill", () => {
  test("shows the domain only, the full URL in title", () => {
    const html = renderToStaticMarkup(<UrlPill url="https://www.github.com/vtmocanu/zeo" />);
    expect(html).toContain('data-testid="sidebar-url-pill"');
    expect(html).toContain('title="https://www.github.com/vtmocanu/zeo"');
    expect(text(html)).toBe("github.com");
  });

  test("falls back to the placeholder", () => {
    expect(text(renderToStaticMarkup(<UrlPill url={null} />))).toBe(URL_PILL_PLACEHOLDER);
    expect(text(renderToStaticMarkup(<UrlPill url="about:blank" />))).toBe(URL_PILL_PLACEHOLDER);
  });
});

describe("FavoritesGrid", () => {
  test("renders nothing without favorites", () => {
    const html = renderToStaticMarkup(
      <FavoritesGrid favorites={[]} activeFavoriteId={null} openFavoriteIds={new Set()} sidebarWidth={240} />,
    );
    expect(html).toBe("");
  });

  test("tiles carry id, open state, label and the active marker", () => {
    const html = renderToStaticMarkup(
      <FavoritesGrid
        favorites={[favorite("a", "Alpha"), favorite("b", "Beta")]}
        activeFavoriteId="b"
        openFavoriteIds={new Set(["b"])}
        sidebarWidth={240}
      />,
    );
    expect(html).toContain('data-testid="favorites-grid"');
    expect(html).toContain("--favorite-columns:2");
    expect(html.match(/data-testid="favorite-tile"/g)).toHaveLength(2);
    expect(html).toMatch(/data-favorite-id="a" data-open="false" aria-label="Alpha"/);
    expect(html).toMatch(
      /class="favorite-tile favorite-tile--active"[^>]*data-favorite-id="b" data-open="true" aria-current="true"/,
    );
  });

  test("tileDropEdge marks the tile before the slot, or the last tile's trailing edge", () => {
    expect(tileDropEdge(0, 3, null)).toBeNull();
    expect(tileDropEdge(1, 3, 1)).toBe("before");
    expect(tileDropEdge(0, 3, 1)).toBeNull();
    expect(tileDropEdge(2, 3, 3)).toBe("after");
    expect(tileDropEdge(1, 3, 3)).toBeNull();
  });
});

describe("BottomBar", () => {
  test("summarizeDownloads keeps the indicator's wording", () => {
    expect(summarizeDownloads([]).label).toBe("Downloads");
    expect(summarizeDownloads([download("completed", 5, 5)]).label).toBe("Downloads (1)");
    expect(
      summarizeDownloads([download("progressing", 20, 100), download("paused", 20, 0), download("completed", 1, 1)])
        .label,
    ).toBe("Downloading 2 · 40%");
    const unknown = summarizeDownloads([download("progressing", 10, 0)]);
    expect(unknown).toMatchObject({ indeterminate: true, label: "Downloading 1…" });
  });

  test("renders downloads, archived, one dot per space and new space", () => {
    const html = renderToStaticMarkup(
      <BottomBar
        spaces={[space("s1", "Personal"), space("s2", "Work")]}
        activeSpaceId="s2"
        downloads={[]}
        archivedCount={3}
        archivedOpen={false}
        onToggleArchived={() => {}}
        onRenameSpace={() => {}}
        onNewSpace={() => {}}
      />,
    );
    expect(html).toContain('data-testid="downloads-indicator"');
    expect(html).toContain('title="Downloads"');
    expect(html).toMatch(/data-testid="archived-toggle" aria-expanded="false" title="Archived \(3\)"/);
    expect(html).toContain('<span class="visually-hidden">Archived (3)</span>');
    expect(html.match(/data-space-id=/g)).toHaveLength(2);
    expect(html).toMatch(/data-space-id="s2" aria-current="true"/);
    expect(html).toContain('aria-label="New space"');
    expect(html).not.toContain("progress-ring");
  });

  test("an active download adds the ring", () => {
    const html = renderToStaticMarkup(
      <BottomBar
        spaces={[]}
        activeSpaceId=""
        downloads={[download("progressing", 40, 100)]}
        archivedCount={0}
        archivedOpen={false}
        onToggleArchived={() => {}}
        onRenameSpace={() => {}}
        onNewSpace={() => {}}
      />,
    );
    expect(html).toContain("downloads-indicator--active");
    expect(html).toContain('stroke-dasharray="40 100"');
  });

  test("a space item's text is only its name", () => {
    const html = renderToStaticMarkup(
      <SpaceItem space={space("s1", "Personal")} isActive onActivate={() => {}} onRename={() => {}} onContextMenu={() => {}} />,
    );
    expect(text(html)).toBe("Personal");
    expect(html).toContain('title="Personal"');
    expect(html).toContain('data-testid="space-dot"');
  });

  test("the name editor is labelled per mode", () => {
    expect(spaceEditLabel({ mode: "create" })).toBe("New space name");
    expect(spaceEditLabel({ mode: "rename", spaceId: "s" })).toBe("Rename space");
    expect(spaceEditLabel({ mode: "new-profile", spaceId: "s" })).toBe("New profile name");
  });
});
