/**
 * The pure content-blocking state and its reducers. This module owns the
 * blocking slice that main attaches to the broadcast snapshot: whether blocking
 * is enabled, the active list version, and the per-tab blocked-request counts
 * (plus a bucket for requests that could not be attributed to a tab).
 *
 * The reducers are free functions (not store methods) and treat their input as
 * immutable: each returns a NEW state object rather than mutating the argument,
 * matching the existing store's immutable-update style.
 */

/**
 * The content-blocking slice of the broadcast state: whether blocking is
 * `enabled`, the active `listVersion`, the per-tab blocked-request counts keyed
 * by tab id, `blockedUnattributed` for requests not tied to a tab, and the
 * per-site `allowlist` of hosts that bypass blocking (kept sorted by
 * `localeCompare` with no duplicates).
 */
export interface BlockingState {
  enabled: boolean;
  listVersion: string;
  blockedByTab: Record<string, number>;
  blockedUnattributed: number;
  allowlist: readonly string[];
}

/** Returns a sorted (`localeCompare`), de-duplicated copy of `hosts`. */
function normalizeAllowlist(hosts: readonly string[]): string[] {
  return [...new Set(hosts)].sort((a, b) => a.localeCompare(b));
}

/**
 * A fresh {@link BlockingState} with the given `enabled` flag, `listVersion`,
 * and `allowlist` (normalized to sorted + de-duplicated), no per-tab counts, and
 * a zero unattributed count.
 */
export function initialBlockingState(
  enabled: boolean,
  listVersion: string,
  allowlist: readonly string[] = [],
): BlockingState {
  return {
    enabled,
    listVersion,
    blockedByTab: {},
    blockedUnattributed: 0,
    allowlist: normalizeAllowlist(allowlist),
  };
}

/**
 * Returns a new state with `tabId`'s blocked count incremented by one (starting
 * from 0 when the tab has no entry yet). The input `state` is not mutated.
 */
export function applyBlockedRequest(
  state: BlockingState,
  tabId: string,
): BlockingState {
  return {
    ...state,
    blockedByTab: {
      ...state.blockedByTab,
      [tabId]: (state.blockedByTab[tabId] ?? 0) + 1,
    },
  };
}

/**
 * Returns a new state with `tabId`'s entry REMOVED from `blockedByTab`, so a
 * reset tab shows no shield. When the tab has no entry, the original `state` is
 * returned unchanged (same reference).
 */
export function resetBlockedCount(
  state: BlockingState,
  tabId: string,
): BlockingState {
  if (!(tabId in state.blockedByTab)) {
    return state;
  }
  const rest = { ...state.blockedByTab };
  delete rest[tabId];
  return { ...state, blockedByTab: rest };
}

/**
 * Returns a new state with `blockedUnattributed` incremented by one, used for a
 * blocked request that could not be tied to a tab (a view already torn down, or
 * a non-tab renderer). The input `state` is not mutated.
 */
export function applyUnattributedBlock(state: BlockingState): BlockingState {
  return { ...state, blockedUnattributed: state.blockedUnattributed + 1 };
}

/**
 * Returns a new state with `tabId`'s entry dropped from `blockedByTab`, used
 * when a tab is removed. When the tab has no entry, the original `state` is
 * returned unchanged (same reference).
 */
export function dropBlockedTab(
  state: BlockingState,
  tabId: string,
): BlockingState {
  if (!(tabId in state.blockedByTab)) {
    return state;
  }
  const rest = { ...state.blockedByTab };
  delete rest[tabId];
  return { ...state, blockedByTab: rest };
}

/**
 * Returns a new state with `host` inserted into `allowlist`, keeping it sorted
 * (`localeCompare`) with no duplicates. When `host` is already present the
 * original `state` is returned unchanged (same reference). Blocked counts are
 * untouched.
 */
export function addAllowlistHost(
  state: BlockingState,
  host: string,
): BlockingState {
  if (state.allowlist.includes(host)) {
    return state;
  }
  return { ...state, allowlist: normalizeAllowlist([...state.allowlist, host]) };
}

/**
 * Returns a new state with `host` removed from `allowlist`. When `host` is
 * absent the original `state` is returned unchanged (same reference). Blocked
 * counts are untouched.
 */
export function removeAllowlistHost(
  state: BlockingState,
  host: string,
): BlockingState {
  if (!state.allowlist.includes(host)) {
    return state;
  }
  return {
    ...state,
    allowlist: state.allowlist.filter((entry) => entry !== host),
  };
}
