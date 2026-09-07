/**
 * The command registry: one declarative list of every action the application
 * exposes, with a stable {@link CommandId}, a title, search keywords, an
 * optional accelerator, and the application-menu it belongs to. The menu is
 * generated from this list, the command bar offers matching commands as
 * suggestions, and main dispatches all of them through a single handler map.
 */

import { DEFAULT_ZOOM_FACTOR } from "./zoom.js";

/** The stable identifier of every registered command. */
export type CommandId =
  | "tab.new"
  | "tab.close"
  | "tab.pin"
  | "tab.unpin"
  | "tab.archive"
  | "tab.copy-url"
  | "tab.reload"
  | "tab.back"
  | "tab.forward"
  | "space.new"
  | "space.rename"
  | "space.delete"
  | "bar.open-location"
  | "bar.open-commands"
  | "blocking.toggle"
  | "blocking.allowSite"
  | "blocking.disallowSite"
  | "settings.open"
  | "settings.close"
  | "history.open"
  | "history.clear"
  | "zoom.in"
  | "zoom.out"
  | "zoom.reset"
  | "settings.openGeneral"
  | "settings.openProfiles"
  | "settings.openHistory";

/**
 * One registry entry: its {@link CommandId}, human title, search `keywords`,
 * Electron `accelerator` (or `null` when the command has no shortcut), and the
 * application submenu (`menu`) it appears in (`null` for none).
 */
export interface CommandDescriptor {
  id: CommandId;
  title: string;
  keywords: string[];
  accelerator: string | null;
  menu: "tabs" | "spaces" | "view" | null;
}

/**
 * The enablement inputs {@link isCommandEnabled} reads: the active tab's pin and
 * navigation-history flags plus its allowlist state — `siteHost` (the allowlist
 * key from `siteKeyForUrl(tab.url)`, or `null` for a non-http(s) tab) and
 * `siteAllowlisted` (whether that host is covered by the allowlist) — and
 * `zoomFactor`, the active tab's host's current zoom factor
 * (`TabsState.zoom.byHost[siteHost]`, or `1.0`/{@link DEFAULT_ZOOM_FACTOR} when
 * the host has no entry or the tab is non-http(s)) — or `null` when no tab is
 * active; the number of spaces; and `settingsOpen`, whether the settings view is
 * currently open.
 */
export interface CommandContext {
  activeTab: {
    pinned: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    siteHost: string | null;
    siteAllowlisted: boolean;
    zoomFactor: number;
  } | null;
  spaceCount: number;
  settingsOpen: boolean;
}

/**
 * Every command, in registry order, one entry per {@link CommandId}. Titles,
 * keywords, accelerators, and menus are the authoritative source the menu and
 * bar draw from. `tab.pin` and `tab.unpin` deliberately share one accelerator;
 * at most one is enabled at a time.
 */
export const COMMANDS: readonly CommandDescriptor[] = [
  { id: "tab.new", title: "New Tab", keywords: ["new", "tab", "create"], accelerator: "CmdOrCtrl+T", menu: "tabs" },
  { id: "tab.close", title: "Close Tab", keywords: ["close", "tab"], accelerator: "CmdOrCtrl+W", menu: "tabs" },
  { id: "tab.pin", title: "Pin Tab", keywords: ["pin", "tab", "favorite"], accelerator: "CmdOrCtrl+Shift+P", menu: "tabs" },
  { id: "tab.unpin", title: "Unpin Tab", keywords: ["unpin", "pin", "tab"], accelerator: "CmdOrCtrl+Shift+P", menu: "tabs" },
  { id: "tab.archive", title: "Archive Tab", keywords: ["archive", "tab", "hide"], accelerator: "CmdOrCtrl+Shift+W", menu: "tabs" },
  { id: "tab.copy-url", title: "Copy URL", keywords: ["copy", "url", "link", "address"], accelerator: "CmdOrCtrl+Shift+C", menu: "tabs" },
  { id: "tab.reload", title: "Reload Page", keywords: ["reload", "refresh", "page"], accelerator: "CmdOrCtrl+R", menu: "view" },
  { id: "tab.back", title: "Go Back", keywords: ["back", "history", "previous"], accelerator: "CmdOrCtrl+[", menu: "view" },
  { id: "tab.forward", title: "Go Forward", keywords: ["forward", "history", "next"], accelerator: "CmdOrCtrl+]", menu: "view" },
  { id: "space.new", title: "New Space", keywords: ["new", "space", "workspace", "create"], accelerator: "CmdOrCtrl+Shift+N", menu: "spaces" },
  { id: "space.rename", title: "Rename Space", keywords: ["rename", "space", "workspace"], accelerator: null, menu: "spaces" },
  { id: "space.delete", title: "Delete Space", keywords: ["delete", "remove", "space", "workspace"], accelerator: null, menu: "spaces" },
  { id: "bar.open-location", title: "Open Location", keywords: ["open", "location", "url", "address", "go"], accelerator: "CmdOrCtrl+L", menu: "view" },
  { id: "bar.open-commands", title: "Run Command", keywords: ["run", "command", "palette", "actions"], accelerator: "CmdOrCtrl+K", menu: "view" },
  { id: "blocking.toggle", title: "Toggle Content Blocking", keywords: ["block", "ads", "tracking", "adblock"], accelerator: null, menu: "view" },
  { id: "blocking.allowSite", title: "Disable Blocking on This Site", keywords: ["allow", "whitelist", "allowlist", "site", "ads"], accelerator: null, menu: "view" },
  { id: "blocking.disallowSite", title: "Enable Blocking on This Site", keywords: ["block", "allowlist", "site", "ads"], accelerator: null, menu: "view" },
  { id: "settings.open", title: "Open Settings", keywords: ["settings", "preferences", "options"], accelerator: "CmdOrCtrl+,", menu: "view" },
  { id: "settings.close", title: "Close Settings", keywords: ["settings"], accelerator: null, menu: null },
  { id: "history.open", title: "Show History", keywords: ["history", "recent", "visited"], accelerator: "CmdOrCtrl+Y", menu: "view" },
  { id: "history.clear", title: "Clear Browsing History", keywords: ["history", "clear", "delete"], accelerator: null, menu: "view" },
  { id: "zoom.in", title: "Zoom In", keywords: ["zoom", "in", "larger", "bigger"], accelerator: "CmdOrCtrl+=", menu: "view" },
  { id: "zoom.out", title: "Zoom Out", keywords: ["zoom", "out", "smaller"], accelerator: "CmdOrCtrl+-", menu: "view" },
  { id: "zoom.reset", title: "Actual Size", keywords: ["zoom", "reset", "actual", "default", "100"], accelerator: "CmdOrCtrl+0", menu: "view" },
  { id: "settings.openGeneral", title: "Open General Settings", keywords: ["settings", "general", "search", "engine", "preferences"], accelerator: null, menu: null },
  { id: "settings.openProfiles", title: "Open Profile Settings", keywords: ["settings", "profiles", "profile"], accelerator: null, menu: null },
  { id: "settings.openHistory", title: "Open History Settings", keywords: ["settings", "history", "clear"], accelerator: null, menu: null },
];

/**
 * Whether command `id` is enabled in `context`, pure. Always enabled:
 * `tab.new`, `space.new`, `space.rename`, `bar.open-location`,
 * `bar.open-commands`, `blocking.toggle`, `settings.open`, `history.open`,
 * `history.clear`, `settings.openGeneral`, `settings.openProfiles`,
 * `settings.openHistory`. Every other
 * `tab.*` needs an active tab; on top of that `tab.pin` needs it unpinned,
 * `tab.unpin` pinned, `tab.archive` unpinned, and `tab.back` / `tab.forward`
 * the matching history flag. `space.delete` needs more than one space.
 * `blocking.allowSite` needs an active tab with an http(s) `siteHost` that is
 * not yet allowlisted; `blocking.disallowSite` needs an active tab whose site
 * is allowlisted; `settings.close` needs the settings view open. `zoom.in` and
 * `zoom.out` need an active tab with a non-null http(s) `siteHost`; `zoom.reset`
 * needs that too AND a current `zoomFactor` other than the default `1.0` (there
 * is nothing to reset when the host is already at actual size).
 */
export function isCommandEnabled(id: CommandId, context: CommandContext): boolean {
  switch (id) {
    case "tab.new":
    case "space.new":
    case "space.rename":
    case "bar.open-location":
    case "bar.open-commands":
    case "blocking.toggle":
    case "settings.open":
    case "history.open":
    case "history.clear":
    case "settings.openGeneral":
    case "settings.openProfiles":
    case "settings.openHistory":
      return true;
    case "space.delete":
      return context.spaceCount > 1;
    case "blocking.allowSite":
      return (
        context.activeTab !== null &&
        context.activeTab.siteHost !== null &&
        !context.activeTab.siteAllowlisted
      );
    case "blocking.disallowSite":
      return context.activeTab !== null && context.activeTab.siteAllowlisted;
    case "settings.close":
      return context.settingsOpen;
    case "tab.close":
    case "tab.copy-url":
    case "tab.reload":
      return context.activeTab !== null;
    case "tab.pin":
      return context.activeTab !== null && !context.activeTab.pinned;
    case "tab.unpin":
      return context.activeTab !== null && context.activeTab.pinned;
    case "tab.archive":
      return context.activeTab !== null && !context.activeTab.pinned;
    case "tab.back":
      return context.activeTab !== null && context.activeTab.canGoBack;
    case "tab.forward":
      return context.activeTab !== null && context.activeTab.canGoForward;
    case "zoom.in":
    case "zoom.out":
      return context.activeTab !== null && context.activeTab.siteHost !== null;
    case "zoom.reset":
      return (
        context.activeTab !== null &&
        context.activeTab.siteHost !== null &&
        context.activeTab.zoomFactor !== DEFAULT_ZOOM_FACTOR
      );
    default: {
      const exhaustive: never = id;
      return exhaustive;
    }
  }
}

/**
 * One generated application-menu item: the command it dispatches (`id`), its
 * displayed `label`, its `accelerator` (or `null`), and whether it is
 * `enabled` in the current context.
 */
export interface MenuEntry {
  id: CommandId;
  label: string;
  accelerator: string | null;
  enabled: boolean;
}

/**
 * The application-menu entries for `commands` in `context`, pure. Iterates in
 * order; commands sharing a non-null accelerator collapse into ONE entry at the
 * first member's position, taking its `id`/`label`/`enabled` from the first
 * member enabled in `context` (or the first member, disabled, when none is).
 * Commands with a `null` accelerator are never grouped. `commands` is assumed
 * pre-filtered by menu — this does not read the `menu` field.
 */
export function menuEntries(commands: readonly CommandDescriptor[], context: CommandContext): MenuEntry[] {
  const entries: MenuEntry[] = [];
  const groupIndexByAccelerator = new Map<string, number>();

  for (const command of commands) {
    const enabled = isCommandEnabled(command.id, context);

    if (command.accelerator === null) {
      entries.push({ id: command.id, label: command.title, accelerator: null, enabled });
      continue;
    }

    const existing = groupIndexByAccelerator.get(command.accelerator);
    if (existing === undefined) {
      groupIndexByAccelerator.set(command.accelerator, entries.length);
      entries.push({ id: command.id, label: command.title, accelerator: command.accelerator, enabled });
      continue;
    }

    // A later member of the same accelerator group: adopt it only when the
    // group's chosen entry is not yet enabled and this member is.
    const chosen = entries[existing]!;
    if (!chosen.enabled && enabled) {
      entries[existing] = { id: command.id, label: command.title, accelerator: command.accelerator, enabled };
    }
  }

  return entries;
}

/** Electron accelerator modifier tokens mapped to their macOS glyphs. */
const ACCELERATOR_GLYPHS: Record<string, string> = {
  CmdOrCtrl: "⌘",
  Cmd: "⌘",
  Command: "⌘",
  Ctrl: "⌃",
  Control: "⌃",
  Shift: "⇧",
  Alt: "⌥",
  Option: "⌥",
};

/**
 * Renders an Electron `accelerator` string as macOS glyphs, pure. Each
 * `+`-separated modifier token maps to its glyph (CmdOrCtrl/Cmd/Command → ⌘,
 * Ctrl/Control → ⌃, Shift → ⇧, Alt/Option → ⌥); the final key is kept as-is.
 * Tokens join with no separator, e.g. `"CmdOrCtrl+Shift+P"` → `"⌘⇧P"`.
 */
export function formatAccelerator(accelerator: string): string {
  return accelerator
    .split("+")
    .map((token) => ACCELERATOR_GLYPHS[token] ?? token)
    .join("");
}
