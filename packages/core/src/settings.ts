/**
 * The settings surface's pure vocabulary: the section registry that both the
 * renderer and the keyboard navigation draw their order from, and the fixed
 * search-engine catalog the general section and the command bar resolve
 * searches through. Electron-free — no state is stored here; main holds the
 * current search-engine choice and threads it in.
 */

/** The stable identifier of every settings section, in registry order. */
export type SettingsSectionId = "general" | "blocking" | "profiles" | "history";

/** One settings section: its stable {@link SettingsSectionId} and human title. */
export interface SettingsSection {
  id: SettingsSectionId;
  title: string;
}

/**
 * Every settings section, in fixed registry order. This is the single source
 * of the section order for the settings renderer's section list and for the
 * keyboard navigation ({@link nextSection}/{@link prevSection}).
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: "general", title: "General" },
  { id: "blocking", title: "Blocking" },
  { id: "profiles", title: "Profiles" },
  { id: "history", title: "History" },
];

/**
 * The section after `id` in {@link SETTINGS_SECTIONS} order, pure index math;
 * clamped at the last section (no wrap), so `nextSection("history")` is
 * `"history"`.
 */
export function nextSection(id: SettingsSectionId): SettingsSectionId {
  const index = SETTINGS_SECTIONS.findIndex((section) => section.id === id);
  const next = Math.min(index + 1, SETTINGS_SECTIONS.length - 1);
  return SETTINGS_SECTIONS[next]!.id;
}

/**
 * The section before `id` in {@link SETTINGS_SECTIONS} order, pure index math;
 * clamped at the first section (no wrap), so `prevSection("general")` is
 * `"general"`.
 */
export function prevSection(id: SettingsSectionId): SettingsSectionId {
  const index = SETTINGS_SECTIONS.findIndex((section) => section.id === id);
  const prev = Math.max(index - 1, 0);
  return SETTINGS_SECTIONS[prev]!.id;
}

/** The stable identifier of every catalog search engine. */
export type SearchEngineId =
  | "duckduckgo"
  | "google"
  | "bing"
  | "brave"
  | "startpage";

/**
 * One catalog search engine: its stable {@link SearchEngineId}, human `name`,
 * and `urlTemplate` — a query prefix a URL-encoded term is appended to.
 */
export interface SearchEngine {
  id: SearchEngineId;
  name: string;
  urlTemplate: string;
}

/**
 * The fixed search-engine catalog, in display order. Each `urlTemplate` is a
 * query prefix {@link searchUrl} appends `encodeURIComponent(query)` to.
 */
export const SEARCH_ENGINES: readonly SearchEngine[] = [
  { id: "duckduckgo", name: "DuckDuckGo", urlTemplate: "https://duckduckgo.com/?q=" },
  { id: "google", name: "Google", urlTemplate: "https://www.google.com/search?q=" },
  { id: "bing", name: "Bing", urlTemplate: "https://www.bing.com/search?q=" },
  { id: "brave", name: "Brave", urlTemplate: "https://search.brave.com/search?q=" },
  { id: "startpage", name: "Startpage", urlTemplate: "https://www.startpage.com/sp/search?query=" },
];

/**
 * The default search-engine id used when no choice has been persisted; its
 * template equals the historical hardcoded DuckDuckGo prefix, so behavior with
 * no stored choice is unchanged.
 */
export const DEFAULT_SEARCH_ENGINE_ID: SearchEngineId = "duckduckgo";

/**
 * The catalog entry for `id`, or `undefined` for an id not in the catalog.
 * `id` is a plain `string` so callers can validate an untrusted stored or
 * bridge-supplied value against the catalog.
 */
export function searchEngine(id: string): SearchEngine | undefined {
  return SEARCH_ENGINES.find((engine) => engine.id === id);
}

/**
 * Builds a search URL for `query` on engine `id`: the engine's `urlTemplate`
 * followed by `encodeURIComponent(query)`. `id` is a valid {@link SearchEngineId}
 * (a catalog id), so the lookup always resolves.
 */
export function searchUrl(id: SearchEngineId, query: string): string {
  return searchEngine(id)!.urlTemplate + encodeURIComponent(query);
}
