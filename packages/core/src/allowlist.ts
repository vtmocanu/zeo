/**
 * The pure per-site allowlist helpers: deriving the allowlist key for a url,
 * canonicalizing user-typed hosts into allowlist entries, and matching a live
 * host against a set of entries. This module is Electron-free and knows nothing
 * about persistence or the blocker; main composes these with its live allowlist
 * set to decide whether a document bypasses content blocking.
 */

/** Matches an IPv4 dotted-quad literal such as `127.0.0.1`. */
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Matches a bracketed IPv6 literal such as `[::1]`. */
const IPV6_LITERAL = /^\[.*\]$/;

/** A leading url scheme such as `https://`, stripped before host validation. */
const LEADING_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;

/** True when `value` is an IPv4 dotted-quad or a bracketed IPv6 literal. */
function isIpLiteral(value: string): boolean {
  return IPV4_LITERAL.test(value) || IPV6_LITERAL.test(value);
}

/**
 * The allowlist key for a url: the lowercased `hostname` for `http:` and
 * `https:` urls, and `null` for every other scheme (`about:`, `file:`,
 * `data:`, `chrome:`) or an unparsable string. Used to map a tab's live url to
 * the host the allowlist is keyed on.
 */
export function siteKeyForUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.hostname.toLowerCase();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The canonical allowlist entry for user input, or `null` when the input cannot
 * be used as a host. Trims, lowercases, strips one leading `*.`, strips a
 * leading scheme and everything from the first `/`, `?`, or `#`, and strips a
 * single trailing `.`, then validates by parsing `"http://" + value` and
 * requiring the parsed `hostname` to equal the value with no userinfo and no
 * port. IPv4 dotted-quad and bracketed IPv6 literals pass; an empty result, an
 * embedded space, or any value the parser rewrites (including IDN → punycode
 * and `127.1` → `127.0.0.1`) returns `null`.
 */
export function normalizeAllowlistHost(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (value.startsWith("*.")) {
    value = value.slice(2);
  }
  value = value.replace(LEADING_SCHEME, "");
  const cut = value.search(/[/?#]/);
  if (cut !== -1) {
    value = value.slice(0, cut);
  }
  if (value.endsWith(".")) {
    value = value.slice(0, -1);
  }
  if (value === "") {
    return null;
  }
  try {
    const parsed = new URL("http://" + value);
    if (
      parsed.hostname === value &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === ""
    ) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * True when `host` is covered by `entries`. When either the entry or `host` is
 * an IP literal (IPv4 dotted-quad or bracketed IPv6) the only match is exact
 * equality, so an attacker-controlled host such as `foo.127.0.0.1` never
 * matches the entry `127.0.0.1`. For every other entry `host` matches when it
 * equals the entry or is a subdomain of it (`host.endsWith("." + entry)`).
 * Returns true on the first matching entry.
 */
export function hostMatchesAllowlist(
  host: string,
  entries: Iterable<string>,
): boolean {
  const hostIsIp = isIpLiteral(host);
  for (const entry of entries) {
    // An empty entry would make `host.endsWith("." + "")` — i.e.
    // `host.endsWith(".")` — match any trailing-dot FQDN host such as
    // `example.com.` (which `siteKeyForUrl` can produce), disabling blocking for
    // it. `normalizeAllowlistHost` never produces an empty entry, but guard here
    // so this matcher is safe against any caller.
    if (entry === "") {
      continue;
    }
    if (hostIsIp || isIpLiteral(entry)) {
      if (host === entry) {
        return true;
      }
      continue;
    }
    if (host === entry || host.endsWith("." + entry)) {
      return true;
    }
  }
  return false;
}
