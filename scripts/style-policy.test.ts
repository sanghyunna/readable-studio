import assert from "node:assert/strict";
import test from "node:test";

import {
  collectStylePolicyViolationsFromSource,
  collectWebThemeTokenParityViolationsFromSource,
} from "./guard.ts";
import {
  collectCssEncodedHexColorMatches,
  collectCssEmptyVarFunctionMatches,
  collectCssHardcodedColorMatches,
  collectCssNamedColorMatches,
} from "./style-policy.ts";

test("collectCssNamedColorMatches finds named colors inside CSS shorthands and functions", () => {
  const source = [
    ".example { border: 1px solid red; }",
    ".gradient { background: linear-gradient(red, blue); }",
  ].join("\n");

  assert.deepEqual(
    collectCssNamedColorMatches(source).map((match) => match.value.toLowerCase()),
    ["red", "red", "blue"],
  );
});

test("collectCssNamedColorMatches covers mixed-case and full CSS named colors", () => {
  const source = ".example { border-color: RebeccaPurple; outline-color: tomato; }";

  assert.deepEqual(
    collectCssNamedColorMatches(source).map((match) => match.value),
    ["RebeccaPurple", "tomato"],
  );
});

test("collectCssNamedColorMatches keeps CSS-wide special keywords exempt", () => {
  const source = ".example { color: transparent; fill: currentColor; border-color: inherit; }";
  assert.deepEqual(collectCssNamedColorMatches(source), []);
});

test("collectCssNamedColorMatches skips strings, comments, urls, and var references", () => {
  const source = [
    "/* .ignored { color: red; } */",
    '.content { content: "green"; }',
    '.content-declaration { content: "{ color: red; }"; }',
    ".comment { color: /* red */ var(--blue); }",
    ".asset { background: url('/icons/blue.svg'); }",
  ].join("\n");

  assert.deepEqual(collectCssNamedColorMatches(source), []);
});

test("collectCssHardcodedColorMatches scans CSS var fallbacks", () => {
  const source = ".example { color: var(--missing-red, red); background: var(--x, rgb(1 2 3)); }";

  assert.deepEqual(
    collectCssHardcodedColorMatches(source).map((match) => match.value),
    ["red", "rgb(1 2 3)"],
  );
});

test("collectCssHardcodedColorMatches finds CSS colors in declaration values", () => {
  const source = ".example { color: #ff0000; background: rgb(255 0 0); border-color: hsl(0 100% 50%); }";

  assert.deepEqual(
    collectCssHardcodedColorMatches(source).map((match) => match.value),
    ["#ff0000", "rgb(255 0 0)", "hsl(0 100% 50%)"],
  );
});

test("collectCssEmptyVarFunctionMatches finds invalid empty CSS var functions", () => {
  const source = ".example { color: var(); background: color-mix(in srgb, var( ), red); border: var(, red); }";

  assert.deepEqual(
    collectCssEmptyVarFunctionMatches(source).map((match) => match.value),
    ["var()", "var( )", "var(, red)"],
  );
});

test("collectCssEmptyVarFunctionMatches ignores comments, strings, and valid var references", () => {
  const source = [
    "/* .ignored { color: var(); } */",
    '.content { content: "var()"; }',
    ".valid { color: var(--fg); background: var(--missing, rgb(1 2 3)); }",
  ].join("\n");

  assert.deepEqual(collectCssEmptyVarFunctionMatches(source), []);
});

test("collectCssEncodedHexColorMatches ignores comments and strings", () => {
  const source = [
    "/* .ignored { color: %23fff; } */",
    '.content { content: "%23aaa"; }',
    ".bad { color: %23bada55; }",
  ].join("\n");

  assert.deepEqual(
    collectCssEncodedHexColorMatches(source).map((match) => match.value),
    ["%23bada55"],
  );
});

test("style policy flags encoded hex only outside CSS comments and strings", () => {
  const source = [
    "/* .ignored { color: %23fff; } */",
    '.content { content: "%23aaa"; }',
    ".bad { color: %23bada55; }",
  ].join("\n");

  assert.deepEqual(
    collectStylePolicyViolationsFromSource("scripts/guard-style-policy-fixtures/encoded.css", source).map(
      (violation) => violation.match,
    ),
    ["%23bada55"],
  );
});

test("style policy keeps SettingsDialog legacy fallbacks narrow", () => {
  assert.deepEqual(
    collectStylePolicyViolationsFromSource(
      "apps/web/src/components/SettingsDialog.tsx",
      "const style = { color: 'var(--fg-2, #9aa0a6)', borderLeft: '3px solid var(--warning-fg, #fbbf24)' };",
    ),
    [],
  );

  assert.deepEqual(
    collectStylePolicyViolationsFromSource(
      "apps/web/src/components/SettingsDialog.tsx",
      "const style = { color: '#123456' };",
    ).map((violation) => violation.match),
    ["#123456"],
  );
});

test("style policy catches quoted named colors in enforced TSX paths", () => {
  assert.deepEqual(
    collectStylePolicyViolationsFromSource(
      "scripts/guard-style-policy-fixtures/component.tsx",
      "export const Component = () => <div style={{ color: 'red' }} />;",
    ).map((violation) => violation.match),
    ["'red'"],
  );
});

test("style policy ignores TS comments and non-style named color strings", () => {
  assert.deepEqual(
    collectStylePolicyViolationsFromSource(
      "apps/web/src/components/SettingsDialog.tsx",
      ["const protocol = 'azure';", "// Issue #739", "const next = protocol === 'azure' ? 'api' : 'local';"].join("\n"),
    ),
    [],
  );
});

test("rejects stale design-system identity", () => {
  const source = [
    '{',
    '  "name": "OpenAI",',
    `  "description": "Bundled ${["Open", "Design"].join(" ")} package for OpenAI"`,
    '}',
  ].join("\n");

  assert.deepEqual(
    collectStylePolicyViolationsFromSource("design-systems/openai/manifest.json", source),
    [
      {
        filePath: "design-systems/openai/manifest.json",
        lineNumber: 3,
        match: ["Open", "Design"].join(" "),
        reason: "design-system product attribution must use Readable Studio metadata",
      },
    ],
  );
});

test("theme parity requires the theme selector to match the file theme id", () => {
  const expected = new Set(["--accent", "--accent-contrast"]);

  assert.deepEqual(
    collectWebThemeTokenParityViolationsFromSource(
      "apps/web/src/styles/themes/dracula.css",
      "dracula",
      expected,
      [
        "[data-theme='dracula-broken'] {",
        "  --accent: #ffffff;",
        "  --accent-contrast: #000000;",
        "}",
      ].join("\n"),
    ),
    ['apps/web/src/styles/themes/dracula.css must define [data-theme="dracula"]'],
  );

  assert.deepEqual(
    collectWebThemeTokenParityViolationsFromSource(
      "apps/web/src/styles/themes/dracula.css",
      "dracula",
      expected,
      ["[data-theme='dracula'] {", "  --accent: #ffffff;", "  --accent-contrast: #000000;", "}"].join("\n"),
    ),
    [],
  );
});
