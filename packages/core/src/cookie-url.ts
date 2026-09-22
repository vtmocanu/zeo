/**
 * Derives the URL used to address a single cookie in a session cookie store
 * (e.g. Electron's `cookies.remove(url, name)`), from the cookie's own
 * `domain`/`path`/`secure` fields.
 *
 * The `cookie` parameter is a STRUCTURAL minimum — only the three fields this
 * needs — deliberately NOT Electron's `Cookie`, so this module (and all of
 * `@zeo/core`) stays free of any `electron` import.
 *
 * A leading dot on the domain (the "all subdomains" marker) is stripped, a
 * `secure` cookie yields an `https://` scheme and any other an `http://` one,
 * and a missing path defaults to `/`. A missing or empty domain has no
 * addressable URL and returns `null`.
 */
export function cookieUrlFor(cookie: {
  domain?: string;
  path?: string;
  secure?: boolean;
}): string | null {
  const domain = cookie.domain;
  if (domain === undefined || domain === "") {
    return null;
  }
  const host = domain.startsWith(".") ? domain.slice(1) : domain;
  const scheme = cookie.secure ? "https://" : "http://";
  return scheme + host + (cookie.path ?? "/");
}
