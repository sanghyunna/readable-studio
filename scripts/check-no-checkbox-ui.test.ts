import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { collectNoCheckboxUiViolationsFromSource } from "./check-no-checkbox-ui.ts";

const tsxPath = "apps/web/src/components/Example.tsx";

function kinds(source: string, filePath = tsxPath): string[] {
  return collectNoCheckboxUiViolationsFromSource(filePath, source).map((violation) => violation.kind);
}

describe("no-checkbox product UI guard", () => {
  test("detects every banned JSX checkbox representation", () => {
    assert.deepEqual(kinds('export const A = () => <input type="checkbox" />'), ["checkbox-input"]);
    assert.deepEqual(kinds("export const A = () => <input type={'checkbox'} />"), ["checkbox-input"]);
    assert.deepEqual(kinds("export const A = () => <input type={flag ? 'text' : 'checkbox'} />"), ["checkbox-input"]);
    assert.deepEqual(kinds('export const A = () => <div role="checkbox" />'), ["checkbox-role"]);
    assert.deepEqual(kinds("export const A = () => <div role={'checkbox'} />"), ["checkbox-role"]);
    assert.deepEqual(kinds("export const A = () => <div {...{ role: 'checkbox' }} />"), ["checkbox-role"]);
    assert.deepEqual(kinds('export const A = () => <div role="menuitemcheckbox" />'), ["menuitemcheckbox-role"]);
    assert.deepEqual(kinds('export const A = () => <div className="row-checkbox active" />'), ["checkbox-class"]);
    assert.deepEqual(kinds('export const A = () => <div class={"checkboxMarker"} />'), ["checkbox-class"]);
    assert.deepEqual(kinds('export const A = () => <div className={cx(active && "item-checkbox")} />'), ["checkbox-class"]);
    assert.deepEqual(kinds('export const A = () => <div className={`item-checkbox ${active}`} />'), ["checkbox-class"]);
    assert.deepEqual(kinds('export const A = () => <span>☐ Pick one</span>'), ["checkbox-glyph"]);
    assert.deepEqual(kinds("export const A = () => <span>{'Done ☑'}</span>"), ["checkbox-glyph"]);
    assert.deepEqual(kinds('export const label = "Failed ☒"'), ["checkbox-glyph"]);
    assert.deepEqual(kinds('export const A = () => <CheckboxIcon />'), ["checkbox-icon"]);
    assert.deepEqual(kinds('export const A = () => <Icon name="checkbox-circle" />'), ["checkbox-icon"]);
  });

  test("detects checkbox CSS selectors but ignores CSS comments and strings", () => {
    const source = [
      "/* .ignored-checkbox, input[type=checkbox] { color: red; } */",
      '.label::after { content: ".fake-checkbox input[type=checkbox]"; }',
      ".real-checkbox:hover { color: inherit; }",
      "form input[type='checkbox'] + label { color: inherit; }",
    ].join("\n");

    assert.deepEqual(kinds(source, "apps/web/src/styles/example.css"), ["checkbox-class", "checkbox-input"]);
  });

  test("rejects unconstrained direct input types and accepts narrowed non-checkbox unions", () => {
    assert.deepEqual(kinds("export const A = ({ type }) => <input type={type} />"), ["nonliteral-input-type"]);
    assert.deepEqual(kinds("const type: 'text' | 'email' = 'text'; export const A = () => <input type={type} />"), []);
    assert.deepEqual(kinds("export const A = ({ kind }: { kind: 'search' | 'text' }) => <input type={kind} />"), []);
    assert.deepEqual(kinds("export const A = ({ compact }) => <input type={compact ? 'search' : 'text'} />"), []);
  });

  test("allows protocol, authoring, Markdown, Switch, and shared HubMenu exceptions", () => {
    const allowed = [
      "export type Question = { type: 'checkbox' }; const question = { type: 'checkbox' as const };",
      "export const roles = ['checkbox'];",
      "export const parseTask = (line: string) => line.startsWith('- [ ]') || line.startsWith('- [x]');",
      "export const Switch = () => <button role=\"switch\" aria-checked=\"true\" />;",
    ].join("\n");
    assert.deepEqual(kinds(allowed, "apps/web/src/artifacts/question-form.ts"), []);
    assert.deepEqual(
      kinds("export const editableRoles = ['checkbox', 'menuitemcheckbox'];", "apps/web/src/edit-mode/roles.ts"),
      [],
    );
    assert.deepEqual(
      kinds(
        'export const HubMenu = () => <div role="menuitemcheckbox" aria-checked="true" />;',
        "apps/web/src/components/hub/HubMenu.tsx",
      ),
      [],
    );
  });
});
