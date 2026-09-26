// Renders the Homebrew cask template (zeo.rb.tmpl) by literal substitution of
// its three placeholder tokens ({{VERSION}}, {{SHA256}}, {{URL}}), validates
// the inputs and the result, and writes the rendered cask to --out (or
// stdout). Runs standalone in the release workflow with only Node on PATH: no
// pnpm install, no monorepo build, no import from @zeo/core or any workspace
// package.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

const TOKENS = ["{{VERSION}}", "{{SHA256}}", "{{URL}}"];

export class RenderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RenderError";
    this.code = code;
  }
}

// Pure: substitute every occurrence of each placeholder token with the
// corresponding input value, by literal split/join (never as a regular
// expression or a String#replace replacement pattern), so a value containing
// e.g. "$&" is inserted verbatim.
export function renderCask(template, { version, url, sha256 }) {
  let rendered = template;
  rendered = rendered.split("{{VERSION}}").join(version);
  rendered = rendered.split("{{SHA256}}").join(sha256);
  rendered = rendered.split("{{URL}}").join(url);
  return rendered;
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pure: throws a RenderError with a numeric `code` when an input, the
// template shape, or the rendered text is invalid; returns normally when
// everything is valid. `rendered` is only required when the caller has
// already produced it (i.e. after the earlier checks passed); callers that
// only want the template-shape check (code 6) may omit `rendered` and
// `url`/`sha256`/`version` as long as `template` is present, but the standard
// CLI flow always supplies every field.
export function validate({ version, url, sha256, expectedVersion, template, rendered }) {
  // Code 6: each of the three tokens must occur exactly once in the template,
  // checked before substitution so a stale literal that has silently replaced
  // a placeholder cannot pass validation.
  for (const token of TOKENS) {
    if (countOccurrences(template, token) !== 1) {
      throw new RenderError(6, `template must contain ${token} exactly once`);
    }
  }

  // Code 1: required inputs must be present and non-blank.
  if (!version || !version.trim()) {
    throw new RenderError(1, "--version is required");
  }
  if (!url || !url.trim()) {
    throw new RenderError(1, "--url is required");
  }
  if (!sha256 || !sha256.trim()) {
    throw new RenderError(1, "--sha256 is required");
  }

  // Code 2: sha256 must be exactly 64 lowercase hex characters.
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new RenderError(2, "--sha256 must be exactly 64 lowercase hexadecimal characters");
  }

  // Code 3: version must equal the root package.json version.
  if (version !== expectedVersion) {
    throw new RenderError(
      3,
      `--version ${version} does not match package.json version ${expectedVersion}`,
    );
  }

  // Code 4: url must contain version as a delimited token (not merely as a
  // prefix of a longer version).
  const escaped = escapeRegExp(version);
  const urlPattern = new RegExp(`(?:^|[^0-9.])${escaped}(?:[^0-9.]|$)`);
  if (!urlPattern.test(url)) {
    throw new RenderError(4, `--url does not contain --version ${version} as a delimited token`);
  }

  // Code 5: after substitution, no "{{" may remain.
  if (rendered !== undefined && rendered.includes("{{")) {
    throw new RenderError(5, "rendered cask still contains an unreplaced {{ placeholder");
  }
}

function parseArgs(argv) {
  const knownFlags = new Set(["--version", "--url", "--sha256", "--out"]);
  const result = { version: undefined, url: undefined, sha256: undefined, out: undefined };
  const flagToKey = {
    "--version": "version",
    "--url": "url",
    "--sha256": "sha256",
    "--out": "out",
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!knownFlags.has(arg)) {
      throw new Error(`unknown or misplaced argument: ${arg}`);
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`${arg} requires a value`);
    }
    result[flagToKey[arg]] = value;
    i += 2;
  }
  return result;
}

function usage() {
  return (
    "Usage: node render.mjs --version <version> --url <url> --sha256 <sha256> [--out <path>]"
  );
}

export function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const templatePath = resolve(scriptDir, "zeo.rb.tmpl");
  const packageJsonPath = resolve(scriptDir, "..", "..", "package.json");

  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(usage());
    process.exit(1);
    return;
  }

  if (!args.version || !args.url || !args.sha256) {
    console.error("--version, --url, and --sha256 are all required");
    console.error(usage());
    process.exit(1);
    return;
  }

  const template = readFileSync(templatePath, "utf8");
  const expectedVersion = JSON.parse(readFileSync(packageJsonPath, "utf8")).version;

  const rendered = renderCask(template, {
    version: args.version,
    url: args.url,
    sha256: args.sha256,
  });

  try {
    validate({
      version: args.version,
      url: args.url,
      sha256: args.sha256,
      expectedVersion,
      template,
      rendered,
    });
  } catch (err) {
    if (err instanceof RenderError) {
      console.error(`render failed (code ${err.code}): ${err.message}`);
      process.exit(err.code);
      return;
    }
    throw err;
  }

  if (args.out) {
    writeFileSync(args.out, rendered, "utf8");
  } else {
    process.stdout.write(rendered);
  }
  process.exit(0);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}
