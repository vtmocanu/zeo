/**
 * The outcome of resolving a command-bar input string: either a concrete URL to
 * navigate to (`kind: "url"`, with `url` the canonical serialized href) or a
 * search query (`kind: "search"`, with `url` the search-engine URL carrying the
 * encoded term). This is the single contract the command bar hands to the tab
 * layer, so navigation vs search is decided once, purely, here.
 */
export interface NavigationTarget {
  kind: "url" | "search";
  url: string;
}

/**
 * The search-engine prefix a non-URL input is appended to. The resolved search
 * URL is this constant followed by the `encodeURIComponent`-encoded query term.
 */
export const DEFAULT_SEARCH_ENGINE = "https://duckduckgo.com/?q=";

/** Leading scheme detector: an ASCII letter followed by scheme chars, then `:`. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** A single dotted-hostname label: alphanumerics and internal hyphens only. */
const LABEL_RE = /^[a-z0-9-]+$/i;

/** The final label of a dotted hostname: alphabetic, two or more characters. */
const TLD_RE = /^[a-z]+$/i;

/**
 * Canonicalizes an http(s) candidate through the WHATWG URL parser. Returns a
 * `url` {@link NavigationTarget} carrying the serialized `href` on success, or
 * `null` when the candidate is not a parseable URL, letting the caller fall
 * through to the search rule.
 */
function canonicalize(candidate: string): NavigationTarget | null {
  try {
    return { kind: "url", url: new URL(candidate).href };
  } catch {
    return null;
  }
}

/**
 * Tests whether `authority` (the part of the input up to the first `/`, `?`, or
 * `#`) is a navigable `host` or `host:port`. `localhost` and IPv4 literals count
 * as hosts; otherwise the host must be a dotted name of two or more labels whose
 * final label is alphabetic and at least two characters. Returns the chosen
 * scheme (`http://` for localhost/IPv4, else `https://`) or `null` when the
 * authority is not a recognizable host.
 */
function schemeForAuthority(authority: string): string | null {
  const colon = authority.indexOf(":");
  let host = authority;
  if (colon !== -1) {
    host = authority.slice(0, colon);
    const port = authority.slice(colon + 1);
    if (port.length === 0 || !/^[0-9]+$/.test(port)) {
      return null;
    }
  }
  if (host.length === 0) {
    return null;
  }
  if (host === "localhost") {
    return "http://";
  }
  if (isIPv4(host)) {
    return "http://";
  }
  const labels = host.split(".");
  if (labels.length < 2) {
    return null;
  }
  for (const label of labels) {
    if (!LABEL_RE.test(label) || label.startsWith("-") || label.endsWith("-")) {
      return null;
    }
  }
  const last = labels[labels.length - 1]!;
  if (last.length < 2 || !TLD_RE.test(last)) {
    return null;
  }
  return "https://";
}

/**
 * Tests whether `host` is an IPv4 literal: exactly four dot-separated decimal
 * octets, each all-digits and in the range 0–255. Leading zeros are permitted.
 */
function isIPv4(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== 4) {
    return false;
  }
  for (const octet of octets) {
    if (octet.length === 0 || !/^[0-9]+$/.test(octet)) {
      return false;
    }
    if (Number(octet) > 255) {
      return false;
    }
  }
  return true;
}

/**
 * Resolves a raw command-bar input into a {@link NavigationTarget}. The input is
 * trimmed first; empty or whitespace-only input returns `null`. The rules run in
 * order on the trimmed text, first match wins:
 *
 * 1. SCHEME: if the text begins with an `http`/`https` scheme it is a URL
 *    candidate (canonicalized). Any other scheme is never navigated to as-is;
 *    it falls through to the HOST/SEARCH rules, so `about:`, `file:`,
 *    `javascript:`, etc. resolve to a search while a bare `host:port` such as
 *    `localhost:3000` (which the scheme pattern also matches) is still picked
 *    up by the HOST rule as an http(s) authority.
 * 2. HOST: only when the text has no whitespace, a leading `host`/`host:port`
 *    authority (localhost, an IPv4 literal, or a dotted hostname) becomes an
 *    http(s) candidate built from the whole trimmed text, then canonicalized.
 * 3. SEARCH: everything else becomes a search of the trimmed text.
 *
 * A candidate that fails URL canonicalization falls through to the search rule.
 */
export function resolveInput(text: string): NavigationTarget | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const search = (): NavigationTarget => ({
    kind: "search",
    url: DEFAULT_SEARCH_ENGINE + encodeURIComponent(trimmed),
  });

  if (SCHEME_RE.test(trimmed)) {
    const scheme = trimmed.slice(0, trimmed.indexOf(":")).toLowerCase();
    if (scheme === "http" || scheme === "https") {
      return canonicalize(trimmed) ?? search();
    }
    // Non-http(s) scheme: do not navigate to it. Fall through — the HOST rule
    // reclaims a genuine `host:port` (e.g. localhost:3000); everything else
    // ends at SEARCH.
  }

  if (!/\s/.test(trimmed)) {
    const authorityEnd = trimmed.search(/[/?#]/);
    const authority = authorityEnd === -1 ? trimmed : trimmed.slice(0, authorityEnd);
    const scheme = schemeForAuthority(authority);
    if (scheme !== null) {
      return canonicalize(scheme + trimmed) ?? search();
    }
  }

  return search();
}
