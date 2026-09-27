import { formatAccelerator } from "./commands.js";
import type { CommandBarMode } from "./command-bar.js";
import type { Suggestion } from "./suggest.js";

/** Identifier of one of the command bar's fixed result groups, in display order. */
export type SuggestionGroupId = "go" | "tabs" | "spaces" | "history" | "commands" | "downloads";

/**
 * The command bar's fixed groups, in display order. Each entry names the
 * {@link Suggestion} kinds it collects; {@link groupOf} inverts this to find a
 * suggestion's group from its kind.
 */
export const SUGGESTION_GROUPS: readonly {
  id: SuggestionGroupId;
  label: string;
  kinds: readonly Suggestion["kind"][];
}[] = [
  { id: "go", label: "Go to", kinds: ["navigate", "search"] },
  { id: "tabs", label: "Tabs", kinds: ["tab", "archived-tab"] },
  { id: "spaces", label: "Spaces", kinds: ["space"] },
  { id: "history", label: "History", kinds: ["history"] },
  { id: "commands", label: "Commands", kinds: ["command"] },
  { id: "downloads", label: "Downloads", kinds: ["download"] },
];

const GROUP_BY_KIND = new Map<Suggestion["kind"], SuggestionGroupId>(
  SUGGESTION_GROUPS.flatMap((group) => group.kinds.map((kind) => [kind, group.id] as const)),
);

/** Returns the {@link SuggestionGroupId} a suggestion kind belongs to. */
export function groupOf(kind: Suggestion["kind"]): SuggestionGroupId {
  const id = GROUP_BY_KIND.get(kind);
  if (id === undefined) {
    throw new Error(`no command bar group for suggestion kind "${kind}"`);
  }
  return id;
}

/**
 * A consecutive run of an already-grouped suggestion list that shares one
 * {@link groupOf} group, as produced by {@link suggestionGroups}. `start` is
 * the run's flat index into the grouped list (used for selection and accept).
 */
export interface SuggestionGroup {
  id: SuggestionGroupId;
  label: string;
  start: number;
  suggestions: Suggestion[];
}

/**
 * Stably partitions `suggestions` by {@link groupOf} into
 * {@link SUGGESTION_GROUPS} order: a new array holding every input row
 * exactly once, ordered by its group's index in {@link SUGGESTION_GROUPS}
 * and, within a group, in the input's relative order. It never re-ranks,
 * drops or adds rows — only the cross-kind interleaving changes.
 */
export function groupSuggestions(suggestions: readonly Suggestion[]): Suggestion[] {
  const buckets = new Map<SuggestionGroupId, Suggestion[]>(
    SUGGESTION_GROUPS.map((group) => [group.id, []]),
  );
  for (const suggestion of suggestions) {
    buckets.get(groupOf(suggestion.kind))?.push(suggestion);
  }
  return SUGGESTION_GROUPS.flatMap((group) => buckets.get(group.id) ?? []);
}

/**
 * Splits an already-{@link groupSuggestions grouped} list into consecutive
 * runs of equal {@link groupOf} group, in the input's run order (which is
 * {@link SUGGESTION_GROUPS} order for a grouped list). Empty groups never appear; an empty list returns `[]`.
 */
export function suggestionGroups(suggestions: readonly Suggestion[]): SuggestionGroup[] {
  const groups: SuggestionGroup[] = [];
  let current: SuggestionGroup | null = null;
  suggestions.forEach((suggestion, index) => {
    const id = groupOf(suggestion.kind);
    if (!current || current.id !== id) {
      const definition = SUGGESTION_GROUPS.find((group) => group.id === id);
      current = { id, label: definition?.label ?? id, start: index, suggestions: [] };
      groups.push(current);
    }
    current.suggestions.push(suggestion);
  });
  return groups;
}

/** Name of one of the command bar's 16px line icons. */
export type SuggestionIcon =
  | "arrow"
  | "search"
  | "globe"
  | "archive"
  | "grid"
  | "bolt"
  | "history"
  | "download";

/** The command bar row anatomy for one suggestion, pure and computed once per render. */
export interface SuggestionRowView {
  icon: SuggestionIcon;
  primary: string;
  secondary: string;
  hint: string;
  tone: "default" | "danger";
}

/** Returns `new URL(url).host`, or the raw `url` when it does not parse. */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Computes the row anatomy for a suggestion: its icon, primary and secondary
 * text, right-aligned hint, and tone. `hint` surfaces a command's accelerator,
 * or the selected row's mode-specific action hint (history's delete, or
 * downloads' open/reveal/remove) when `selected` and `mode` match; otherwise
 * it is empty. `tone` is `"danger"` for a cancelled or interrupted download,
 * else `"default"`.
 */
export function suggestionRowView(
  suggestion: Suggestion,
  mode: CommandBarMode,
  selected: boolean,
): SuggestionRowView {
  switch (suggestion.kind) {
    case "navigate":
      return { icon: "arrow", primary: suggestion.label, secondary: "", hint: "", tone: "default" };
    case "search":
      return { icon: "search", primary: suggestion.label, secondary: "", hint: "", tone: "default" };
    case "tab":
      return { icon: "globe", primary: suggestion.title, secondary: urlHost(suggestion.url), hint: "", tone: "default" };
    case "archived-tab":
      return {
        icon: "archive",
        primary: suggestion.title,
        secondary: `Archived · ${suggestion.spaceName}`,
        hint: "",
        tone: "default",
      };
    case "space":
      return { icon: "grid", primary: suggestion.name, secondary: "", hint: "", tone: "default" };
    case "history":
      return {
        icon: "history",
        primary: suggestion.title,
        secondary: urlHost(suggestion.url),
        hint: selected && mode === "history" ? "⌘⌫ Delete" : "",
        tone: "default",
      };
    case "command":
      return {
        icon: "bolt",
        primary: suggestion.title,
        secondary: "",
        hint: suggestion.accelerator !== null ? formatAccelerator(suggestion.accelerator) : "",
        tone: "default",
      };
    case "download":
      return {
        icon: "download",
        primary: suggestion.filename,
        secondary: suggestion.detail,
        hint: selected && mode === "downloads" ? "↵ Open · ⌘↵ Reveal · ⌘⌫ Remove" : "",
        tone: suggestion.state === "cancelled" || suggestion.state === "interrupted" ? "danger" : "default",
      };
  }
}
