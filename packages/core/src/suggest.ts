import { resolveInput } from "./resolve-input.js";
import type { CommandBarMode } from "./command-bar.js";

/**
 * One row the command bar can show and act on. `navigate`/`search` are the
 * text action for the typed query (row 0); `tab`/`archived-tab`/`space` are
 * catalog matches. The renderer draws these and hands the chosen row's index
 * back to main; main performs the action.
 */
export type Suggestion =
  | { kind: "navigate"; url: string; label: string }
  | { kind: "search"; url: string; label: string }
  | { kind: "tab"; tabId: string; spaceId: string; title: string; url: string; spaceName: string }
  | { kind: "archived-tab"; tabId: string; spaceId: string; title: string; url: string; spaceName: string }
  | { kind: "space"; spaceId: string; name: string };

/**
 * The plain, store-free input {@link suggest} ranks over. Main builds this from
 * its {@link SpaceStore} on every keystroke: every space (with its `active`
 * flag), every open tab (with `lastActiveAt`), and every archived tab (with
 * `archivedAt`), each carrying its owning space id and name. `suggest` reads
 * only this — it never touches a store.
 */
export interface SuggestCatalog {
  spaces: { id: string; name: string; active: boolean }[];
  tabs: { tabId: string; spaceId: string; title: string; url: string; spaceName: string; lastActiveAt: number }[];
  archived: { tabId: string; spaceId: string; title: string; url: string; spaceName: string; archivedAt: number }[];
}

/**
 * The non-catalog inputs to {@link suggest}: the bar `mode` (drives the
 * empty-query recent-tabs list) and the `activeTabId` (excluded from matches
 * and from the recent list).
 */
export interface SuggestOptions {
  mode: CommandBarMode;
  activeTabId: string | null;
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
  /** Kind rank: open tab 0, space 1, archived tab 2. */
  kindRank: number;
  /** 0 for a tab in the active space (and for every non-tab), 1 otherwise. */
  activeRank: number;
  /** `lastActiveAt` (open) / `archivedAt` (archived), descending; 0 for spaces. */
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

/**
 * Ranks the command-bar suggestion list for `query`. Row 0 is the text action
 * ({@link resolveInput} mapped to a `navigate` or `search` row), omitted when
 * the query is empty/whitespace. On an empty query the list is the eight most
 * recently active open tabs (excluding the active tab) in `new-tab` mode and
 * empty in `navigate` mode. Otherwise catalog rows whose haystack contains
 * every whitespace-separated term are scored (see {@link termTier}, worst tier
 * wins), sorted by score, then kind (open tab, space, archived tab), then
 * active-space-first for tabs, then recency descending, then catalog order,
 * and capped at eight before row 0 is prepended. Pure — reads only its
 * arguments.
 */
export function suggest(query: string, catalog: SuggestCatalog, options: SuggestOptions): Suggestion[] {
  const resolved = resolveInput(query);

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
      : { kind: "search", url: resolved.url, label: `Search DuckDuckGo for "${query.trim()}"` };

  const terms = query.trim().toLowerCase().split(/\s+/);
  const activeSpaceId = catalog.spaces.find((s) => s.active)?.id ?? null;

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
        kindRank: 2,
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
