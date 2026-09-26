import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { renderCask, validate, RenderError } from "./render.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const renderScript = resolve(scriptDir, "render.mjs");
const realTemplatePath = resolve(scriptDir, "zeo.rb.tmpl");
const rootPackageJsonPath = resolve(scriptDir, "..", "..", "package.json");

const FIXTURE_TEMPLATE = [
  'cask "zeo" do',
  '  version "{{VERSION}}"',
  '  sha256 "{{SHA256}}"',
  "",
  '  url "{{URL}}"',
  '  name "zeo"',
  "end",
  "",
].join("\n");

const VALID_INPUT = {
  version: "0.0.20",
  url: "https://github.com/vtmocanu/zeo/releases/download/v0.0.20/zeo-0.0.20-arm64.dmg",
  sha256: "a".repeat(64),
};
const EXPECTED_VERSION = "0.0.20";

function renderAndValidate(template, input, expectedVersion) {
  const rendered = renderCask(template, input);
  validate({ ...input, expectedVersion, template, rendered });
  return rendered;
}

function assertRejectedWithCode(input, expectedVersion, template, code) {
  const rendered = renderCask(template, input);
  assert.throws(
    () => validate({ ...input, expectedVersion, template, rendered }),
    (err) => err instanceof RenderError && err.code === code,
  );
}

test("valid input renders text containing each value and no leftover {{", () => {
  const rendered = renderAndValidate(FIXTURE_TEMPLATE, VALID_INPUT, EXPECTED_VERSION);
  assert.ok(rendered.includes(VALID_INPUT.version));
  assert.ok(rendered.includes(VALID_INPUT.url));
  assert.ok(rendered.includes(VALID_INPUT.sha256));
  assert.ok(!rendered.includes("{{"));
});

test("literal substitution: a value containing $& is inserted verbatim", () => {
  const input = { ...VALID_INPUT, sha256: "a".repeat(64) };
  const weirdUrl = `${VALID_INPUT.url}?ref=$&`;
  const inputWithDollarAmp = { ...input, url: weirdUrl };
  const rendered = renderCask(FIXTURE_TEMPLATE, inputWithDollarAmp);
  assert.ok(rendered.includes("$&"));
  assert.ok(rendered.includes(weirdUrl));
});

for (const [label, badSha] of [
  ["too short", "a".repeat(63)],
  ["too long", "a".repeat(65)],
  ["uppercase", "A".repeat(64)],
  ["non-hex", "g".repeat(64)],
]) {
  test(`sha256 ${label} is rejected with code 2`, () => {
    const input = { ...VALID_INPUT, sha256: badSha };
    assertRejectedWithCode(input, EXPECTED_VERSION, FIXTURE_TEMPLATE, 2);
  });
}

test("version mismatch is rejected with code 3", () => {
  const input = { ...VALID_INPUT, version: "0.0.21" };
  assertRejectedWithCode(input, EXPECTED_VERSION, FIXTURE_TEMPLATE, 3);
});

test("url missing the version is rejected with code 4", () => {
  const input = {
    ...VALID_INPUT,
    url: "https://github.com/vtmocanu/zeo/releases/download/vX/zeo-arm64.dmg",
  };
  assertRejectedWithCode(input, EXPECTED_VERSION, FIXTURE_TEMPLATE, 4);
});

test("url with the version only as a prefix of a longer version is rejected with code 4", () => {
  const input = {
    version: "0.0.2",
    url: "https://github.com/vtmocanu/zeo/releases/download/v0.0.20/zeo-0.0.20-arm64.dmg",
    sha256: "a".repeat(64),
  };
  assertRejectedWithCode(input, "0.0.2", FIXTURE_TEMPLATE, 4);
});

test('version 0.0.28"x (malformed) is rejected with code 3', () => {
  const input = { ...VALID_INPUT, version: '0.0.28"x' };
  assertRejectedWithCode(input, '0.0.28"x', FIXTURE_TEMPLATE, 3);
});

test("version prefix mismatch (0.0.2 vs expected 0.0.28) is rejected with code 3", () => {
  const input = {
    version: "0.0.2",
    url: "https://github.com/vtmocanu/zeo/releases/download/v0.0.2/zeo-0.0.2-arm64.dmg",
    sha256: "a".repeat(64),
  };
  assertRejectedWithCode(input, "0.0.28", FIXTURE_TEMPLATE, 3);
});

for (const [label, badUrl] of [
  [
    'containing a double quote (")',
    'https://github.com/vtmocanu/zeo/releases/download/v0.0.20/zeo-0.0.20-arm64.dmg"',
  ],
  ["containing a #{ ruby interpolation", "https://example.com/0.0.20/#{1+1}"],
  ["containing a space", "https://example.com/0.0.20/zeo 0.0.20.dmg"],
  ["not starting with https://", "http://example.com/0.0.20/zeo-0.0.20-arm64.dmg"],
  ["containing a $", "https://example.com/0.0.20/$HOME.dmg"],
  ["containing a backtick", "https://example.com/0.0.20/`id`.dmg"],
  ["containing a backslash", "https://example.com/0.0.20/a\\b.dmg"],
  ["containing a control character", "https://example.com/0.0.20/a\x01b.dmg"],
]) {
  test(`url ${label} is rejected with code 4`, () => {
    const input = { ...VALID_INPUT, url: badUrl };
    assertRejectedWithCode(input, EXPECTED_VERSION, FIXTURE_TEMPLATE, 4);
  });
}

test("version dots are matched literally in the url (0a0b28 does not match 0.0.28), code 4", () => {
  const input = {
    version: "0.0.28",
    url: "https://x/v0a0b28/zeo-0a0b28-arm64.dmg",
    sha256: "a".repeat(64),
  };
  assertRejectedWithCode(input, "0.0.28", FIXTURE_TEMPLATE, 4);
});

test("url with the version present only with a digit on both sides (leading boundary) is rejected with code 4", () => {
  const input = {
    version: "0.0.28",
    url: "https://x/v10.0.28/zeo-10.0.28-arm64.dmg",
    sha256: "a".repeat(64),
  };
  assertRejectedWithCode(input, "0.0.28", FIXTURE_TEMPLATE, 4);
});

for (const blankValue of ["", "   "]) {
  for (const missingKey of ["version", "url", "sha256"]) {
    test(`blank (${JSON.stringify(blankValue)}) --${missingKey} is rejected with code 1`, () => {
      const input = { ...VALID_INPUT, [missingKey]: blankValue };
      assertRejectedWithCode(input, EXPECTED_VERSION, FIXTURE_TEMPLATE, 1);
    });
  }
}

test("order pinning: a bad template shape and a bad sha256 both present yields code 6", () => {
  const badTemplate = FIXTURE_TEMPLATE.replace("{{VERSION}}", "stale-literal");
  const input = { ...VALID_INPUT, sha256: "not-hex" };
  assert.throws(
    () => validate({ ...input, expectedVersion: EXPECTED_VERSION, template: badTemplate }),
    (err) => err instanceof RenderError && err.code === 6,
  );
});

test("order pinning: a blank version and a bad sha256 both present yields code 1", () => {
  const input = { ...VALID_INPUT, version: "", sha256: "not-hex" };
  assert.throws(
    () => validate({ ...input, expectedVersion: EXPECTED_VERSION, template: FIXTURE_TEMPLATE }),
    (err) => err instanceof RenderError && err.code === 1,
  );
});

test("order pinning: a bad sha256 and a version mismatch both present yields code 2", () => {
  const input = { ...VALID_INPUT, version: "9.9.9", sha256: "not-hex" };
  assertRejectedWithCode(input, EXPECTED_VERSION, FIXTURE_TEMPLATE, 2);
});

test("template with an extra unreplaced placeholder is rejected with code 5", () => {
  const templateWithExtra = FIXTURE_TEMPLATE.replace('name "zeo"', 'name "{{EXTRA}}"');
  // renderCask leaves {{EXTRA}} untouched since it isn't one of the three tokens.
  const rendered = renderCask(templateWithExtra, VALID_INPUT);
  assert.throws(
    () =>
      validate({
        ...VALID_INPUT,
        expectedVersion: EXPECTED_VERSION,
        template: FIXTURE_TEMPLATE,
        rendered,
      }),
    (err) => err instanceof RenderError && err.code === 5,
  );
});

for (const token of ["{{VERSION}}", "{{SHA256}}", "{{URL}}"]) {
  test(`template missing ${token} (stale literal) is rejected with code 6`, () => {
    const badTemplate = FIXTURE_TEMPLATE.replace(token, "stale-literal");
    assert.throws(
      () => validate({ ...VALID_INPUT, expectedVersion: EXPECTED_VERSION, template: badTemplate }),
      (err) => err instanceof RenderError && err.code === 6,
    );
  });

  test(`template with duplicated ${token} is rejected with code 6`, () => {
    const badTemplate = `${FIXTURE_TEMPLATE}\n  # duplicate: ${token}`;
    assert.throws(
      () => validate({ ...VALID_INPUT, expectedVersion: EXPECTED_VERSION, template: badTemplate }),
      (err) => err instanceof RenderError && err.code === 6,
    );
  });
}

for (const missingKey of ["version", "url", "sha256"]) {
  test(`missing --${missingKey} is rejected with code 1`, () => {
    const input = { ...VALID_INPUT, [missingKey]: "" };
    assert.throws(
      () => validate({ ...input, expectedVersion: EXPECTED_VERSION, template: FIXTURE_TEMPLATE }),
      (err) => err instanceof RenderError && err.code === 1,
    );
  });
}

test("the real packaging/homebrew/zeo.rb.tmpl passes validate() with a valid rendered input", () => {
  const realTemplate = readFileSync(realTemplatePath, "utf8");
  assert.doesNotThrow(() => {
    renderAndValidate(realTemplate, VALID_INPUT, VALID_INPUT.version);
  });
});

test("the real template's desc line does not mention the platform", () => {
  const realTemplate = readFileSync(realTemplatePath, "utf8");
  const descLine = realTemplate.split("\n").find((line) => line.trim().startsWith('desc "'));
  assert.ok(descLine, "template must have a desc line");
  assert.doesNotMatch(descLine, /\b(macOS|Mac(?: ?OS(?: ?X)?)?|OS ?X)\b/i);
});

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "zeo-render-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CLI: successful render writes --out using the root package.json version", () => {
  withTempDir((dir) => {
    const rootVersion = JSON.parse(readFileSync(rootPackageJsonPath, "utf8")).version;
    const outPath = join(dir, "zeo.rb");
    const url =
      `https://github.com/vtmocanu/zeo/releases/download/v${rootVersion}/` +
      `zeo-${rootVersion}-arm64.dmg`;
    const result = spawnSync(process.execPath, [
      renderScript,
      "--version",
      rootVersion,
      "--url",
      url,
      "--sha256",
      "b".repeat(64),
      "--out",
      outPath,
    ]);
    assert.equal(result.status, 0, result.stderr?.toString());
    assert.ok(existsSync(outPath));
    const content = readFileSync(outPath, "utf8");
    assert.ok(!content.includes("{{"));
    assert.ok(content.includes(rootVersion));
  });
});

test("CLI: run from an unrelated cwd still resolves the template and package.json from the script location", () => {
  withTempDir((cwdDir) => {
    withTempDir((outDir) => {
      const rootVersion = JSON.parse(readFileSync(rootPackageJsonPath, "utf8")).version;
      const outPath = join(outDir, "zeo.rb");
      const url =
        `https://github.com/vtmocanu/zeo/releases/download/v${rootVersion}/` +
        `zeo-${rootVersion}-arm64.dmg`;
      const result = spawnSync(
        process.execPath,
        [
          renderScript,
          "--version",
          rootVersion,
          "--url",
          url,
          "--sha256",
          "c".repeat(64),
          "--out",
          outPath,
        ],
        { cwd: cwdDir },
      );
      assert.equal(result.status, 0, result.stderr?.toString());
      const content = readFileSync(outPath, "utf8");
      assert.ok(!content.includes("{{"));
      assert.ok(content.includes(rootVersion));
    });
  });
});

test("CLI: successful render with no --out writes to stdout", () => {
  const rootVersion = JSON.parse(readFileSync(rootPackageJsonPath, "utf8")).version;
  const url =
    `https://github.com/vtmocanu/zeo/releases/download/v${rootVersion}/` +
    `zeo-${rootVersion}-arm64.dmg`;
  const result = spawnSync(process.execPath, [
    renderScript,
    "--version",
    rootVersion,
    "--url",
    url,
    "--sha256",
    "d".repeat(64),
  ]);
  assert.equal(result.status, 0, result.stderr?.toString());
  const stdout = result.stdout.toString();
  assert.ok(stdout.includes(rootVersion));
  assert.ok(!stdout.includes("{{"));
});

test("CLI: a bad sha256 exits 2 and does not create the --out file", () => {
  withTempDir((dir) => {
    const rootVersion = JSON.parse(readFileSync(rootPackageJsonPath, "utf8")).version;
    const outPath = join(dir, "zeo.rb");
    const url =
      `https://github.com/vtmocanu/zeo/releases/download/v${rootVersion}/` +
      `zeo-${rootVersion}-arm64.dmg`;
    const result = spawnSync(process.execPath, [
      renderScript,
      "--version",
      rootVersion,
      "--url",
      url,
      "--sha256",
      "not-a-valid-sha",
      "--out",
      outPath,
    ]);
    assert.equal(result.status, 2);
    assert.ok(!existsSync(outPath));
  });
});

test("CLI: an unknown flag exits 1", () => {
  const result = spawnSync(process.execPath, [
    renderScript,
    "--version",
    "0.0.20",
    "--url",
    "https://example.com/0.0.20",
    "--sha256",
    "a".repeat(64),
    "--bogus",
    "value",
  ]);
  assert.equal(result.status, 1);
});

test("CLI: --sha256 with no value exits 1", () => {
  const result = spawnSync(process.execPath, [
    renderScript,
    "--version",
    "0.0.20",
    "--url",
    "https://example.com/0.0.20",
    "--sha256",
  ]);
  assert.equal(result.status, 1);
});

test("CLI: a missing required flag exits 1", () => {
  const result = spawnSync(process.execPath, [
    renderScript,
    "--version",
    "0.0.20",
    "--url",
    "https://example.com/0.0.20",
  ]);
  assert.equal(result.status, 1);
});

test("CLI: a flag value that looks like another flag (--version --url) exits 1", () => {
  const result = spawnSync(process.execPath, [
    renderScript,
    "--version",
    "--url",
    "https://example.com/0.0.20",
    "--sha256",
    "a".repeat(64),
  ]);
  assert.equal(result.status, 1);
});

test("CLI: --out with a blank value exits 1", () => {
  const result = spawnSync(process.execPath, [
    renderScript,
    "--version",
    "0.0.20",
    "--url",
    "https://github.com/vtmocanu/zeo/releases/download/v0.0.20/zeo-0.0.20-arm64.dmg",
    "--sha256",
    "a".repeat(64),
    "--out",
    "",
  ]);
  assert.equal(result.status, 1);
});
