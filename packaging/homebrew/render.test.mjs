import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
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

test("the real packaging/homebrew/zeo.rb.tmpl passes the code-6 shape check", () => {
  const realTemplate = readFileSync(realTemplatePath, "utf8");
  assert.doesNotThrow(() => {
    for (const token of ["{{VERSION}}", "{{SHA256}}", "{{URL}}"]) {
      const count = realTemplate.split(token).length - 1;
      assert.equal(count, 1, `${token} must appear exactly once`);
    }
  });
});

test("CLI: successful render writes --out using the root package.json version", () => {
  const rootVersion = JSON.parse(readFileSync(rootPackageJsonPath, "utf8")).version;
  const dir = mkdtempSync(join(tmpdir(), "zeo-render-test-"));
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

test("CLI: a bad sha256 exits 2 and does not create the --out file", () => {
  const rootVersion = JSON.parse(readFileSync(rootPackageJsonPath, "utf8")).version;
  const dir = mkdtempSync(join(tmpdir(), "zeo-render-test-"));
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
