import { resolveInput } from "./resolve-input.js";
import { historyKey, historyTerms } from "./history.js";
import { searchEngine } from "./settings.js";
import { DOWNLOADS_CAP, downloadDetail } from "./downloads.js";
import type { HistoryEntry } from "./history.js";
import type { Download } from "./downloads.js";
import type { CommandBarMode } from "./command-bar.js";
import type { CommandId } from "./commands.js";
import type { SearchEngineId } from "./settings.js";

/**
 * One row the command bar can show and act on. `navigate`/`search` are the
 * text action for the typed query (row 0); `tab`/`archived-tab`/`space`/
 * `history`/`download` are catalog matches (a `history` row is a recorded url
 * with its title, lifetime visit count, and last-visit time; a `download` row
 * is a tracked download with its filename, human-readable `detail`, and state).
 * The renderer draws these and hands the chosen row's index back to main; main
 * performs the action.
 */
export type Suggestion =
  | { kind: "navigate"; url: string; label: string }
  | { kind: "search"; url: string; label: string }
  | { kind: "tab"; tabId: string; spaceId: string; title: string; url: string; spaceName: string }
  | { kind: "archived-tab"; tabId: string; spaceId: string; title: string; url: string; spaceName: string }
  | { kind: "space"; spaceId: string; name: string }
  | { kind: "command"; id: CommandId; title: string; accelerator: string | null }
  | { kind: "history"; url: string; title: string; visitCount: number; lastVisitedAt: number }
  | { kind: "download"; id: string; filename: string; detail: string; state: Download["state"] };

/**
 * The plain, store-free input {@link suggest} ranks over. Main builds this from
 * its {@link SpaceStore} on every keystroke: every space (with its `active`
 * flag), every open tab (with `lastActiveAt`), and every archived tab (with
 * `archivedAt`), each carrying its owning space id and name. `history` is the
 * database-filtered {@link HistoryEntry} list for the current query (already
 * ranked/limited by the database; empty in `commands` mode and when the query
 * does not consult history). `downloads` is the in-memory {@link Download} list
 * main supplies already newest first (`startedAt` desc, `id` desc), consulted
 * only in `downloads` mode. `suggest` reads only this — it never touches a
 * store.
 */
export interface SuggestCatalog {
  spaces: { id: string; name: string; active: boolean }[];
  tabs: { tabId: string; spaceId: string; title: string; url: string; spaceName: string; lastActiveAt: number }[];
  archived: { tabId: string; spaceId: string; title: string; url: string; spaceName: string; archivedAt: number }[];
  commands: { id: CommandId; title: string; keywords: string[]; accelerator: string | null; enabled: boolean }[];
  history: HistoryEntry[];
  downloads: Download[];
}

/**
 * The non-catalog inputs to {@link suggest}: the bar `mode` (drives the
 * empty-query recent-tabs list), the `activeTabId` (excluded from matches and
 * from the recent list), and the `searchEngine` (the chosen default engine
 * main threads in — drives the row-0 search url and label).
 */
export interface SuggestOptions {
  mode: CommandBarMode;
  activeTabId: string | null;
  searchEngine: SearchEngineId;
}

/** Cap on catalog rows returned after row 0 (and on the recent-tabs list). */
const MAX_MATCHES = 8;

/** Leading `scheme://` prefix, stripped from a url before it joins a haystack. */
const SCHEME_PREFIX_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Whitespace or Unicode punctuation — the char classes that start a word. */
const WORD_BOUNDARY_RE = /[\s\p{P}]/u;

/** Removes a leading `scheme://` prefix from `url`, leaving host and path. */
function schemeStripped(url: string): string {
  return url.replace(SCHEME_PREFIX_RE, "");
}

/** The lowercased host of `url`, or `""` when `url` does not parse as a URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Whether `term` begins a word in `haystack`: it occurs at the start of the
 * string or immediately after whitespace or punctuation. Scans every
 * occurrence and tests the preceding char explicitly (JS `\b` is deliberately
 * avoided — it treats `_` and non-ASCII letters unlike the intended rule).
 * Both arguments are expected pre-lowercased.
 */
function startsWord(haystack: string, term: string): boolean {
  if (term.length === 0) {
    return false;
  }
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(term, from);
    if (idx === -1) {
      return false;
    }
    if (idx === 0 || WORD_BOUNDARY_RE.test(haystack[idx - 1]!)) {
      return true;
    }
    from = idx + 1;
  }
}

/**
 * The score tier of a single term against a candidate: 1 when the term is a
 * prefix of `primaryLower` (the lowercased title or space name) or of `host`
 * (tabs/archived only; `null` for spaces); 2 when it starts a word in
 * `primaryLower`; 3 for any other match. Lower is better.
 */
function termTier(term: string, primaryLower: string, host: string | null): 1 | 2 | 3 {
  if (primaryLower.startsWith(term)) {
    return 1;
  }
  if (host !== null && host !== "" && host.startsWith(term)) {
    return 1;
  }
  if (startsWord(primaryLower, term)) {
    return 2;
  }
  return 3;
}

/** An internal candidate row plus every key the ranking sort orders by. */
interface Candidate {
  suggestion: Suggestion;
  /** Worst (largest) term tier — the candidate's score, ascending. */
  score: number;
  /**
   * Kind rank: open tab 0, space 1, history 2, command 3, archived tab 4,
   * download 5. Downloads mode is isolated (its own early return), so the
   * `download` rank only needs to be distinct and stable — no download
   * candidate ever joins the mixed navigate/new-tab list.
   */
  kindRank: number;
  /** 0 for a tab in the active space (and for every non-tab), 1 otherwise. */
  activeRank: number;
  /**
   * `lastActiveAt` (open) / `lastVisitedAt` (history) / `archivedAt`
   * (archived), descending; 0 for spaces and commands.
   */
  recency: number;
  /** Catalog gather order — the deterministic final tiebreak. */
  order: number;
}

/** Projects a catalog open-tab entry to a `tab` {@link Suggestion}. */
function tabSuggestion(t: SuggestCatalog["tabs"][number]): Suggestion {
  return { kind: "tab", tabId: t.tabId, spaceId: t.spaceId, title: t.title, url: t.url, spaceName: t.spaceName };
}

/** Projects a catalog archived-tab entry to an `archived-tab` {@link Suggestion}. */
function archivedSuggestion(t: SuggestCatalog["archived"][number]): Suggestion {
  return { kind: "archived-tab", tabId: t.tabId, spaceId: t.spaceId, title: t.title, url: t.url, spaceName: t.spaceName };
}

/** Whether every `term` is a substring of `haystack` (case handled by caller). */
function matchesAll(haystack: string, terms: string[]): boolean {
  return terms.every((term) => haystack.includes(term));
}

/** Projects a catalog command entry to a `command` {@link Suggestion}. */
function commandSuggestion(c: SuggestCatalog["commands"][number]): Suggestion {
  return { kind: "command", id: c.id, title: c.title, accelerator: c.accelerator };
}

/** Projects a catalog history entry to a `history` {@link Suggestion}. */
function historySuggestion(e: HistoryEntry): Suggestion {
  return {
    kind: "history",
    url: e.url,
    title: e.title,
    visitCount: e.visitCount,
    lastVisitedAt: e.lastVisitedAt,
  };
}

/** Projects a catalog download entry to a `download` {@link Suggestion}. */
function downloadSuggestion(d: Download): Suggestion {
  return {
    kind: "download",
    id: d.id,
    filename: d.filename,
    detail: downloadDetail(d),
    state: d.state,
  };
}

/**
 * The worst (largest) {@link termTier} of `terms` against a history entry's
 * lowercased `title` and url host. With no terms (an empty history-mode query)
 * every check is vacuous, so this returns `0` and the caller keeps catalog
 * (database) order.
 */
function historyScore(entry: HistoryEntry, terms: string[]): number {
  if (terms.length === 0) {
    return 0;
  }
  const titleLower = entry.title.toLowerCase();
  const host = hostOf(entry.url);
  return Math.max(...terms.map((term) => termTier(term, titleLower, host)));
}

/**
 * Ranks the command-bar suggestion list for `query`. Row 0 is the text action
 * ({@link resolveInput} mapped to a `navigate` or `search` row), omitted when
 * the query is empty/whitespace. On an empty query the list is the eight most
 * recently active open tabs (excluding the active tab) in `new-tab` mode and
 * empty in `navigate` mode. Otherwise catalog rows whose haystack contains
 * every whitespace-separated term are scored (see {@link termTier}, worst tier
 * wins), sorted by score, then kind (open tab, space, history, command,
 * archived tab), then active-space-first for tabs, then recency descending,
 * then catalog order, and capped at eight before row 0 is prepended. A history
 * candidate is skipped when an open tab shares its {@link historyKey} (the tab
 * row wins). `commands` mode ignores history entirely; `history` mode returns
 * only history rows and `downloads` mode returns only download rows (each with
 * no row 0 and no other kinds). Pure — reads only its arguments.
 */
export function suggest(query: string, catalog: SuggestCatalog, options: SuggestOptions): Suggestion[] {
  if (options.mode === "commands") {
    // Commands mode is command-only: spaces, tabs, and archived tabs are never
    // consulted, so there is never a row-0 text action (navigate/search).
    // `bar.open-commands` (the bar is already open in this mode) and disabled
    // commands are excluded. An empty/whitespace query lists every remaining
    // enabled command in registry (catalog) order, uncapped. A non-empty query
    // applies the same PRD 4.2 tier/match rules the mixed command block uses,
    // ranked by score then registry order and capped at MAX_MATCHES.
    const enabledCommands = catalog.commands.filter(
      (c) => c.enabled && c.id !== "bar.open-commands",
    );

    if (query.trim() === "") {
      return enabledCommands.map(commandSuggestion);
    }

    const terms = query.trim().toLowerCase().split(/\s+/);
    const ranked: { suggestion: Suggestion; score: number; order: number }[] = [];
    let order = 0;
    for (const command of enabledCommands) {
      const titleLower = command.title.toLowerCase();
      const haystack = `${command.title} ${command.keywords.join(" ")}`.toLowerCase();
      if (matchesAll(haystack, terms)) {
        const score = Math.max(...terms.map((term) => termTier(term, titleLower, null)));
        ranked.push({ suggestion: commandSuggestion(command), score, order: order++ });
      }
    }
    ranked.sort((a, b) => a.score - b.score || a.order - b.order);
    return ranked.slice(0, MAX_MATCHES).map((c) => c.suggestion);
  }

  if (options.mode === "history") {
    // History mode is history-only: no row-0 text action and no tabs, spaces,
    // commands or archived tabs. `catalog.history` is the database-ranked list
    // for the query (or, on an empty query, the recent entries in last-visited
    // order); this scores each row by the same termTier rules as the mixed
    // history block and returns the top MAX_MATCHES, keeping the database
    // (catalog) order within equal-score ties. With an empty query the terms
    // are empty, so every score is 0 and the catalog order is preserved.
    const terms = historyTerms(query);
    const ranked: { suggestion: Suggestion; score: number; order: number }[] = [];
    let order = 0;
    for (const entry of catalog.history) {
      ranked.push({ suggestion: historySuggestion(entry), score: historyScore(entry, terms), order: order++ });
    }
    ranked.sort((a, b) => a.score - b.score || a.order - b.order);
    return ranked.slice(0, MAX_MATCHES).map((c) => c.suggestion);
  }

  if (options.mode === "downloads") {
    // Downloads mode is download-only: no row-0 text action and no tabs,
    // spaces, commands, archived tabs, or history. `catalog.downloads` is
    // supplied newest first (startedAt desc, id desc). An empty/whitespace
    // query lists every download in that order, up to the in-memory cap (100)
    // — NOT capped at MAX_MATCHES. A non-empty query keeps the rows whose
    // filename OR url contains the query (case-insensitive), order preserved,
    // then caps at MAX_MATCHES.
    const trimmed = query.trim();
    if (trimmed === "") {
      return catalog.downloads.slice(0, DOWNLOADS_CAP).map(downloadSuggestion);
    }
    const needle = trimmed.toLowerCase();
    return catalog.downloads
      .filter(
        (d) =>
          d.filename.toLowerCase().includes(needle) ||
          d.url.toLowerCase().includes(needle),
      )
      .slice(0, MAX_MATCHES)
      .map(downloadSuggestion);
  }

  const resolved = resolveInput(query, options.searchEngine);

  if (resolved === null) {
    // Empty/whitespace query: no row 0. new-tab lists recent open tabs.
    if (options.mode !== "new-tab") {
      return [];
    }
    return catalog.tabs
      .filter((t) => t.tabId !== options.activeTabId)
      .slice()
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, MAX_MATCHES)
      .map(tabSuggestion);
  }

  const row0: Suggestion =
    resolved.kind === "url"
      ? { kind: "navigate", url: resolved.url, label: resolved.url }
      : {
          kind: "search",
          url: resolved.url,
          label: `Search ${searchEngine(options.searchEngine)!.name} for "${query.trim()}"`,
        };

  const terms = query.trim().toLowerCase().split(/\s+/);
  const activeSpaceId = catalog.spaces.find((s) => s.active)?.id ?? null;
  // Cross-kind dedupe: a history entry whose key matches an open tab's is
  // dropped below (the tab row wins).
  const openTabKeys = new Set(catalog.tabs.map((tab) => historyKey(tab.url)));

  const candidates: Candidate[] = [];
  let order = 0;

  for (const space of catalog.spaces) {
    const nameLower = space.name.toLowerCase();
    if (matchesAll(nameLower, terms)) {
      const score = Math.max(...terms.map((term) => termTier(term, nameLower, null)));
      candidates.push({
        suggestion: { kind: "space", spaceId: space.id, name: space.name },
        score,
        kindRank: 1,
        activeRank: 0,
        recency: 0,
        order: order++,
      });
    }
  }

  for (const tab of catalog.tabs) {
    if (tab.tabId === options.activeTabId) {
      continue;
    }
    const haystack = `${tab.title} ${schemeStripped(tab.url)}`.toLowerCase();
    if (matchesAll(haystack, terms)) {
      const titleLower = tab.title.toLowerCase();
      const host = hostOf(tab.url);
      const score = Math.max(...terms.map((term) => termTier(term, titleLower, host)));
      candidates.push({
        suggestion: tabSuggestion(tab),
        score,
        kindRank: 0,
        activeRank: activeSpaceId !== null && tab.spaceId === activeSpaceId ? 0 : 1,
        recency: tab.lastActiveAt,
        order: order++,
      });
    }
  }

  for (const entry of catalog.history) {
    // The database already filtered `catalog.history` to the query; score it
    // and drop any entry an open tab already covers (the tab row wins).
    if (openTabKeys.has(historyKey(entry.url))) {
      continue;
    }
    candidates.push({
      suggestion: historySuggestion(entry),
      score: historyScore(entry, terms),
      kindRank: 2,
      activeRank: 0,
      recency: entry.lastVisitedAt,
      order: order++,
    });
  }

  for (const command of catalog.commands) {
    if (!command.enabled) {
      continue;
    }
    const titleLower = command.title.toLowerCase();
    const haystack = `${command.title} ${command.keywords.join(" ")}`.toLowerCase();
    if (matchesAll(haystack, terms)) {
      const score = Math.max(...terms.map((term) => termTier(term, titleLower, null)));
      candidates.push({
        suggestion: {
          kind: "command",
          id: command.id,
          title: command.title,
          accelerator: command.accelerator,
        },
        score,
        kindRank: 3,
        activeRank: 0,
        recency: 0,
        order: order++,
      });
    }
  }

  for (const tab of catalog.archived) {
    if (tab.tabId === options.activeTabId) {
      continue;
    }
    const haystack = `${tab.title} ${schemeStripped(tab.url)}`.toLowerCase();
    if (matchesAll(haystack, terms)) {
      const titleLower = tab.title.toLowerCase();
      const host = hostOf(tab.url);
      const score = Math.max(...terms.map((term) => termTier(term, titleLower, host)));
      candidates.push({
        suggestion: archivedSuggestion(tab),
        score,
        kindRank: 4,
        activeRank: 0,
        recency: tab.archivedAt,
        order: order++,
      });
    }
  }

  candidates.sort(
    (a, b) =>
      a.score - b.score ||
      a.kindRank - b.kindRank ||
      a.activeRank - b.activeRank ||
      b.recency - a.recency ||
      a.order - b.order,
  );

  const matches = candidates.slice(0, MAX_MATCHES).map((c) => c.suggestion);
  return [row0, ...matches];
}

/**
 * The selected index after moving `delta` (`+1`/`-1`) from `current` in a list
 * of `length` rows, wrapping at both ends. Returns `-1` for an empty list —
 * the "no selection" sentinel main keeps when there are no rows.
 */
export function nextSelectedIndex(current: number, length: number, delta: number): number {
  if (length === 0) {
    return -1;
  }
  return (current + delta + length) % length;
}
