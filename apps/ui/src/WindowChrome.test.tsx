import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_CHROME_STATE,
  SIDEBAR_HIDE_DELAY_MS,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_REVEAL_EDGE,
  SINGLE_LAYOUT,
  contentRect,
  splitPaneBounds,
  type ChromeState,
} from "@zeo/core";
import { Icon } from "./icons.js";
import {
  SidebarResizeHandle,
  SidebarRevealController,
  WindowCards,
  WindowRow,
  type SidebarRevealState,
} from "./WindowChrome.js";

const COLLAPSED: ChromeState = { ...DEFAULT_CHROME_STATE, sidebarCollapsed: true };

/** The `.window-card` divs of the markup: [whole tag, class, data-pane]. */
function cardTags(html: string): { tag: string; className: string; pane: string | null }[] {
  return [...html.matchAll(/<div class="(window-card[^"]*)"[^>]*>/g)].map((m) => ({
    tag: m[0],
    className: m[1]!,
    pane: /data-pane="(\w+)"/.exec(m[0])?.[1] ?? null,
  }));
}

describe("WindowCards", () => {
  test("single layout: one unfocused card at contentRect, no data-pane", () => {
    const html = renderToStaticMarkup(
      <WindowCards width={1280} height={800} chrome={DEFAULT_CHROME_STATE} layout={SINGLE_LAYOUT} />,
    );
    const cards = cardTags(html);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.className).toBe("window-card");
    expect(cards[0]!.pane).toBeNull();
    expect(cards[0]!.tag).toContain("left:240px;top:8px;width:1032px;height:784px");
    const collapsed = renderToStaticMarkup(
      <WindowCards width={1280} height={800} chrome={COLLAPSED} layout={SINGLE_LAYOUT} />,
    );
    expect(cardTags(collapsed)[0]!.tag).toContain(`left:${contentRect(1280, 800, COLLAPSED).x}px`);
  });

  test("split layout: left and right cards at splitPaneBounds, only the focused one ringed", () => {
    const layout = { mode: "split", left: "a", right: "b", ratio: 0.5, focused: "right" } as const;
    const bounds = splitPaneBounds(1280, 800, DEFAULT_CHROME_STATE, 0.5);
    const cards = cardTags(
      renderToStaticMarkup(
        <WindowCards width={1280} height={800} chrome={DEFAULT_CHROME_STATE} layout={layout} />,
      ),
    );
    expect(cards.map((card) => [card.className, card.pane])).toEqual([
      ["window-card", "left"],
      ["window-card window-card--focused", "right"],
    ]);
    expect(cards[0]!.tag).toContain(`left:${bounds.left.x}px`);
    expect(cards[1]!.tag).toContain(`left:${bounds.right.x}px;top:${bounds.right.y}px`);

    const leftFocused = cardTags(
      renderToStaticMarkup(
        <WindowCards
          width={1280}
          height={800}
          chrome={DEFAULT_CHROME_STATE}
          layout={{ ...layout, focused: "left" }}
        />,
      ),
    );
    expect(leftFocused.map((card) => card.className)).toEqual([
      "window-card window-card--focused",
      "window-card",
    ]);
  });
});

describe("Icon", () => {
  test("renders a decorative 16px line icon in currentColor", () => {
    const html = renderToStaticMarkup(<Icon name="back" />);
    expect(html).toContain('class="icon"');
    expect(html).toContain('viewBox="0 0 16 16"');
    expect(html).toContain('fill="none"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('stroke-width="1.5"');
    expect(html).toContain('stroke-linecap="round"');
    expect(html).toContain('stroke-linejoin="round"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('d="M10 3.5 5.5 8l4.5 4.5"');
  });

  test("sidebar and reload carry both of their shapes", () => {
    const sidebar = renderToStaticMarkup(<Icon name="sidebar" />);
    expect(sidebar).toContain('<rect x="2" y="3" width="12" height="10" rx="2.2">');
    expect(sidebar).toContain('d="M6.2 3v10"');
    const reload = renderToStaticMarkup(<Icon name="reload" />);
    expect(reload).toContain('d="M12.8 8.6A4.9 4.9 0 1 1 11.4 4.3"');
    expect(reload).toContain('d="M11.8 1.8v2.9H8.9"');
  });
});

describe("WindowRow", () => {
  test("renders the four labelled icon buttons in order", () => {
    const html = renderToStaticMarkup(<WindowRow />);
    expect(html).toContain('data-testid="window-row"');
    const ids = [...html.matchAll(/data-testid="(sidebar-toggle|nav-[a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["sidebar-toggle", "nav-back", "nav-forward", "nav-reload"]);
    for (const label of ["Toggle sidebar", "Back", "Forward", "Reload"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
  });
});

describe("SidebarResizeHandle", () => {
  test("is a focusable vertical separator carrying the width range", () => {
    const html = renderToStaticMarkup(<SidebarResizeHandle width={272} />);
    expect(SIDEBAR_MIN_WIDTH).toBe(200);
    expect(SIDEBAR_MAX_WIDTH).toBe(360);
    expect(html).toContain('data-testid="sidebar-resize-handle"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="Resize sidebar"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-valuemin="200"');
    expect(html).toContain('aria-valuemax="360"');
    expect(html).toContain('aria-valuenow="272"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('class="sidebar__resize-handle"');
  });
});

describe("SidebarRevealController", () => {
  const REVEALED: SidebarRevealState = {
    sidebarCollapsed: true,
    sidebarRevealed: true,
    sidebarWidth: 240,
  };
  let calls: boolean[];
  let controller: SidebarRevealController;

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    controller = new SidebarRevealController(() => ({
      setSidebarRevealed: (revealed: boolean) => {
        calls.push(revealed);
        return Promise.resolve();
      },
    }));
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
  });

  test("touching the edge of a hidden sidebar reveals it once per touch", () => {
    controller.update({ ...REVEALED, sidebarRevealed: false });
    controller.pointerMove(0);
    controller.pointerMove(SIDEBAR_REVEAL_EDGE - 1);
    expect(calls).toEqual([true]);
    controller.pointerMove(SIDEBAR_REVEAL_EDGE + 20);
    controller.pointerMove(0);
    expect(calls).toEqual([true, true]);
  });

  test("hides the hide delay after the pointer leaves, not before", () => {
    controller.update(REVEALED);
    controller.pointerLeave();
    vi.advanceTimersByTime(SIDEBAR_HIDE_DELAY_MS - 1);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([false]);
  });

  test("a width change mid-delay keeps the pending hide on its original schedule", () => {
    controller.update(REVEALED);
    controller.pointerLeave();
    vi.advanceTimersByTime(SIDEBAR_HIDE_DELAY_MS / 2);
    controller.update({ ...REVEALED, sidebarWidth: 300 });
    expect(controller.hidePending).toBe(true);
    vi.advanceTimersByTime(SIDEBAR_HIDE_DELAY_MS / 2);
    expect(calls).toEqual([false]);
  });

  test("moving right of the sidebar schedules a hide; moving back over it cancels", () => {
    controller.update(REVEALED);
    controller.pointerMove(REVEALED.sidebarWidth + 10);
    expect(controller.hidePending).toBe(true);
    controller.pointerMove(REVEALED.sidebarWidth - 10);
    expect(controller.hidePending).toBe(false);
    vi.advanceTimersByTime(SIDEBAR_HIDE_DELAY_MS * 2);
    expect(calls).toEqual([]);
  });

  test("un-collapsing, hiding and dispose all clear a pending hide", () => {
    controller.update(REVEALED);
    controller.pointerLeave();
    controller.update({ ...REVEALED, sidebarCollapsed: false, sidebarRevealed: false });
    expect(controller.hidePending).toBe(false);

    controller.update(REVEALED);
    controller.pointerLeave();
    controller.update({ ...REVEALED, sidebarRevealed: false });
    expect(controller.hidePending).toBe(false);

    controller.update(REVEALED);
    controller.pointerLeave();
    controller.dispose();
    expect(controller.hidePending).toBe(false);

    vi.advanceTimersByTime(SIDEBAR_HIDE_DELAY_MS * 2);
    expect(calls).toEqual([]);
  });

  test("does nothing while the sidebar is not collapsed", () => {
    controller.update({ ...REVEALED, sidebarCollapsed: false, sidebarRevealed: false });
    controller.pointerMove(0);
    controller.pointerLeave();
    vi.advanceTimersByTime(SIDEBAR_HIDE_DELAY_MS * 2);
    expect(calls).toEqual([]);
  });
});
