/**
 * The pure in-page find session and its state reducers. This module owns the
 * {@link FindState} slice main attaches to the broadcast snapshot: the single
 * find session bound to the active tab, its committed query, the active-match
 * ordinal and total, and the outstanding Electron request id that gates which
 * `found-in-page` results are treated as authoritative.
 *
 * Everything here is Electron-free and total: `findInPage`, the `found-in-page`
 * listener, and `stopFindInPage` live in main, while every reducer treats its
 * input as immutable, each returning a NEW {@link FindState} rather than
 * mutating the argument, matching the existing reducers in `packages/core`.
 * Exactly one session exists at a time.
 */

/**
 * The find session slice of the broadcast state. `open` is whether the find bar
 * is showing; `query` is the committed search text; `activeMatch` is the 1-based
 * ordinal of the highlighted match (`0` when there is none); `matchCount` is the
 * total number of matches; `tabId` is the tab the session is bound to (`null`
 * when closed). `activeRequestId` is the Electron `found-in-page` request id of
 * the single `findInPage` call whose results this session currently treats as
 * authoritative, or `null` when none is outstanding (the session is closed or
 * freshly opened, the query is empty or whitespace-only, or the bound tab has
 * just navigated); it gates {@link applyFindResult} and is never rendered.
 */
export interface FindState {
  open: boolean;
  query: string;
  activeMatch: number;
  matchCount: number;
  tabId: string | null;
  activeRequestId: number | null;
}

/**
 * Opens a fresh find session bound to `tabId`: when `state.open` is false,
 * returns an empty session (`query: ""`, `0/0`, no outstanding request). When
 * find is already open, returns `state` unchanged — re-opening is a focus/select
 * concern handled in main, not a state change. The input `state` is not mutated.
 */
export function openFind(state: FindState, tabId: string): FindState {
  if (state.open) {
    return state;
  }
  return {
    open: true,
    query: "",
    activeMatch: 0,
    matchCount: 0,
    tabId,
    activeRequestId: null,
  };
}

/**
 * Sets `query`. On a non-empty query (`query.trim().length > 0`) it leaves
 * `activeMatch`, `matchCount`, and `activeRequestId` unchanged — main issues the
 * new search and records its id via {@link beginFindRequest} in the same
 * handler. When `query` is empty or whitespace-only it also resets `activeMatch`
 * and `matchCount` to `0` and `activeRequestId` to `null`, so the counter shows
 * `0/0` and a delayed result for the cleared query is rejected. The input
 * `state` is not mutated.
 */
export function setFindQuery(state: FindState, query: string): FindState {
  if (query.trim().length === 0) {
    return {
      ...state,
      query,
      activeMatch: 0,
      matchCount: 0,
      activeRequestId: null,
    };
  }
  return { ...state, query };
}

/**
 * Applies one `found-in-page` result to the session. Returns `state` unchanged
 * when find is closed, when `state.tabId` is `null`, or when `requestId` is not
 * the outstanding `state.activeRequestId` (any superseded, pre-navigation, or
 * closed-session result — this also rejects every result while `activeRequestId`
 * is `null`, since `null` never equals a numeric id). Otherwise returns `state`
 * with `activeMatch = activeMatchOrdinal` and `matchCount = matches`, leaving
 * `activeRequestId` unchanged. `finalUpdate` is part of Electron's contract —
 * one or more intermediate events (`finalUpdate: false`) and a final one
 * (`finalUpdate: true`) all carry counts for the same request; every one is
 * applied and the last wins — but it does not change the reducer's logic. The
 * input `state` is not mutated.
 */
export function applyFindResult(
  state: FindState,
  requestId: number,
  activeMatchOrdinal: number,
  matches: number,
  finalUpdate: boolean,
): FindState {
  // `finalUpdate` is accepted per Electron's found-in-page contract; every event
  // of the outstanding request is applied and the last one wins, so the flag
  // itself never gates the update.
  void finalUpdate;
  if (!state.open || state.tabId === null || requestId !== state.activeRequestId) {
    return state;
  }
  return { ...state, activeMatch: activeMatchOrdinal, matchCount: matches };
}

/**
 * Records the outstanding request: returns `state` with `activeRequestId` set to
 * `requestId`, so a later {@link applyFindResult} binds to it and supersedes any
 * prior id. Returns `state` unchanged when find is closed or `state.tabId` is
 * `null`. Main calls it immediately after each `findInPage` (a fresh query,
 * `next`, or `previous`) returns its id. The input `state` is not mutated.
 */
export function beginFindRequest(state: FindState, requestId: number): FindState {
  if (!state.open || state.tabId === null) {
    return state;
  }
  return { ...state, activeRequestId: requestId };
}

/**
 * Resets `activeMatch` and `matchCount` to `0` and `activeRequestId` to `null`,
 * keeping `open`, `query`, and `tabId`. Main calls it when it clears highlights
 * on the bound tab without issuing a replacement search (a navigation of the
 * bound tab), so a pre-navigation straggler is rejected and the counter reads
 * `0/0`. The input `state` is not mutated.
 */
export function clearFindResults(state: FindState): FindState {
  return { ...state, activeMatch: 0, matchCount: 0, activeRequestId: null };
}

/**
 * Closes the session: returns a fully reset {@link FindState} (`open: false`,
 * empty `query`, `0/0`, no `tabId`, no outstanding request) regardless of prior
 * state (idempotent). The `state` argument is accepted for a uniform reducer
 * signature but ignored. The input `state` is not mutated.
 */
export function closeFind(state: FindState): FindState {
  void state;
  return {
    open: false,
    query: "",
    activeMatch: 0,
    matchCount: 0,
    tabId: null,
    activeRequestId: null,
  };
}
