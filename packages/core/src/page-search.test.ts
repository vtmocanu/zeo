import { describe, expect, test } from "vitest";
import {
  openFind,
  setFindQuery,
  applyFindResult,
  beginFindRequest,
  clearFindResults,
  closeFind,
} from "./page-search.js";
import type { FindState } from "./page-search.js";

/** The fully-closed session, the shape `closeFind` and a fresh store produce. */
function closedState(): FindState {
  return {
    open: false,
    query: "",
    activeMatch: 0,
    matchCount: 0,
    tabId: null,
    activeRequestId: null,
  };
}

/** An open session on `tab-1` with a query, counts, and an outstanding request. */
function openState(over: Partial<FindState> = {}): FindState {
  return {
    open: true,
    query: "needle",
    activeMatch: 2,
    matchCount: 3,
    tabId: "tab-1",
    activeRequestId: 4,
    ...over,
  };
}

describe("openFind", () => {
  test("opens an empty session bound to the tab", () => {
    expect(openFind(closedState(), "tab-1")).toEqual({
      open: true,
      query: "",
      activeMatch: 0,
      matchCount: 0,
      tabId: "tab-1",
      activeRequestId: null,
    });
  });

  test("is a no-op returning the same value when already open", () => {
    const state = openState();
    expect(openFind(state, "tab-2")).toBe(state);
  });

  test("does not mutate its input", () => {
    const state = closedState();
    const snapshot = structuredClone(state);
    openFind(state, "tab-1");
    expect(state).toEqual(snapshot);
  });
});

describe("setFindQuery", () => {
  test("stores a non-empty query and leaves counts and request id untouched", () => {
    const state = openState({ query: "old", activeMatch: 2, matchCount: 3, activeRequestId: 4 });
    expect(setFindQuery(state, "needle")).toEqual({
      ...state,
      query: "needle",
    });
  });

  test("resets counts and request id on an empty query", () => {
    const state = openState({ activeMatch: 2, matchCount: 3, activeRequestId: 4 });
    expect(setFindQuery(state, "")).toEqual({
      ...state,
      query: "",
      activeMatch: 0,
      matchCount: 0,
      activeRequestId: null,
    });
  });

  test("resets counts and request id on a whitespace-only query", () => {
    const state = openState({ activeMatch: 2, matchCount: 3, activeRequestId: 4 });
    expect(setFindQuery(state, "   ")).toEqual({
      ...state,
      query: "   ",
      activeMatch: 0,
      matchCount: 0,
      activeRequestId: null,
    });
  });

  test("does not mutate its input", () => {
    const state = openState();
    const snapshot = structuredClone(state);
    setFindQuery(state, "");
    setFindQuery(state, "other");
    expect(state).toEqual(snapshot);
  });
});

describe("beginFindRequest", () => {
  test("records the outstanding request id", () => {
    const state = openState({ activeRequestId: null });
    expect(beginFindRequest(state, 7).activeRequestId).toBe(7);
  });

  test("supersedes a prior request id", () => {
    const state = openState({ activeRequestId: 4 });
    expect(beginFindRequest(state, 9).activeRequestId).toBe(9);
  });

  test("is a no-op when closed", () => {
    const state = closedState();
    expect(beginFindRequest(state, 7)).toBe(state);
  });

  test("is a no-op when tabId is null", () => {
    const state = openState({ tabId: null });
    expect(beginFindRequest(state, 7)).toBe(state);
  });

  test("does not mutate its input", () => {
    const state = openState({ activeRequestId: 4 });
    const snapshot = structuredClone(state);
    beginFindRequest(state, 9);
    expect(state).toEqual(snapshot);
  });
});

describe("applyFindResult", () => {
  test("writes counts for a result matching the outstanding request id", () => {
    const state = openState({ activeMatch: 0, matchCount: 0, activeRequestId: 4 });
    expect(applyFindResult(state, 4, 1, 3, true)).toMatchObject({
      activeMatch: 1,
      matchCount: 3,
      activeRequestId: 4,
    });
  });

  test("drops a result carrying any other request id", () => {
    const state = openState({ activeRequestId: 4 });
    expect(applyFindResult(state, 5, 9, 9, true)).toBe(state);
  });

  test("is a no-op when closed", () => {
    const state = { ...closedState(), activeRequestId: 4 };
    expect(applyFindResult(state, 4, 1, 3, true)).toBe(state);
  });

  test("is a no-op when tabId is null", () => {
    const state = openState({ tabId: null, activeRequestId: 4 });
    expect(applyFindResult(state, 4, 1, 3, true)).toBe(state);
  });

  test("is a no-op when activeRequestId is null", () => {
    const state = openState({ activeRequestId: null });
    expect(applyFindResult(state, 4, 1, 3, true)).toBe(state);
  });

  test("applies every event of the outstanding request, last wins", () => {
    let state = openState({ activeMatch: 0, matchCount: 0, activeRequestId: 4 });
    state = applyFindResult(state, 4, 1, 3, false);
    expect(state).toMatchObject({ activeMatch: 1, matchCount: 3 });
    state = applyFindResult(state, 4, 2, 5, true);
    expect(state).toMatchObject({ activeMatch: 2, matchCount: 5 });
  });

  test("does not mutate its input", () => {
    const state = openState({ activeMatch: 0, matchCount: 0, activeRequestId: 4 });
    const snapshot = structuredClone(state);
    applyFindResult(state, 4, 1, 3, true);
    expect(state).toEqual(snapshot);
  });
});

describe("delayed results are rejected", () => {
  test("a result carrying the prior id is dropped after a query clear", () => {
    const cleared = setFindQuery(openState({ activeRequestId: 4 }), "");
    expect(applyFindResult(cleared, 4, 9, 9, true)).toBe(cleared);
  });

  test("a result carrying the pre-navigation id is dropped after clearFindResults", () => {
    const cleared = clearFindResults(openState({ activeRequestId: 4 }));
    expect(applyFindResult(cleared, 4, 9, 9, true)).toBe(cleared);
  });

  test("a result carrying the old session's id is dropped after close then reopen", () => {
    const reopened = openFind(closeFind(openState({ activeRequestId: 4 })), "tab-1");
    expect(applyFindResult(reopened, 4, 9, 9, true)).toBe(reopened);
  });
});

describe("clearFindResults", () => {
  test("resets counts and request id but keeps open, query, and tabId", () => {
    const state = openState({ activeMatch: 2, matchCount: 3, activeRequestId: 4 });
    expect(clearFindResults(state)).toEqual({
      ...state,
      activeMatch: 0,
      matchCount: 0,
      activeRequestId: null,
    });
  });

  test("does not mutate its input", () => {
    const state = openState({ activeRequestId: 4 });
    const snapshot = structuredClone(state);
    clearFindResults(state);
    expect(state).toEqual(snapshot);
  });
});

describe("closeFind", () => {
  test("resets every field regardless of prior state", () => {
    expect(closeFind(openState())).toEqual({
      open: false,
      query: "",
      activeMatch: 0,
      matchCount: 0,
      tabId: null,
      activeRequestId: null,
    });
  });

  test("does not mutate its input", () => {
    const state = openState();
    const snapshot = structuredClone(state);
    closeFind(state);
    expect(state).toEqual(snapshot);
  });
});
