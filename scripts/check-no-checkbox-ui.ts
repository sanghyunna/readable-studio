import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceRoots = ["apps/web/app", "apps/web/src", "packages/components/src"];
const sourceExtensions = new Set([".ts", ".tsx", ".css"]);
const sharedHubMenuPath = "apps/web/src/components/hub/HubMenu.tsx";
const skippedDirectoryNames = new Set([
  ".next",
  "__generated__",
  "__snapshots__",
  "__tests__",
  "coverage",
  "dist",
  "evidence",
  "generated",
  "node_modules",
  "out",
  "test-results",
  "tests",
]);

export type CheckboxUiViolationKind =
  | "checkbox-class"
  | "checkbox-glyph"
  | "checkbox-icon"
  | "checkbox-input"
  | "checkbox-role"
  | "menuitemcheckbox-role"
  | "nonliteral-input-type";

export type CheckboxUiViolation = {
  filePath: string;
  kind: CheckboxUiViolationKind;
  lineNumber: number;
  match: string;
  reason: string;
};

function lineNumberForIndex(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function addViolation(
  violations: CheckboxUiViolation[],
  filePath: string,
  source: string,
  node: ts.Node,
  kind: CheckboxUiViolationKind,
  match: string,
  reason: string,
): void {
  violations.push({
    filePath,
    kind,
    lineNumber: lineNumberForIndex(source, node.getStart()),
    match,
    reason,
  });
}

function jsxAttributeName(attribute: ts.JsxAttribute): string {
  return attribute.name.getText();
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticStrings(expression: ts.Expression): string[] | undefined {
  const value = unwrapExpression(expression);
  if (ts.isStringLiteralLike(value)) return [value.text];
  if (ts.isNoSubstitutionTemplateLiteral(value)) return [value.text];
  if (ts.isConditionalExpression(value)) {
    const whenTrue = staticStrings(value.whenTrue);
    const whenFalse = staticStrings(value.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : undefined;
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.BarBarToken || value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    const left = staticStrings(value.left);
    const right = staticStrings(value.right);
    return left && right ? [...left, ...right] : undefined;
  }
  return undefined;
}

function literalStringsFromType(type: ts.TypeNode | undefined): string[] | undefined {
  if (type === undefined) return undefined;
  if (ts.isParenthesizedTypeNode(type)) return literalStringsFromType(type.type);
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) return [type.literal.text];
  if (ts.isUnionTypeNode(type)) {
    const values = type.types.map(literalStringsFromType);
    return values.every((value): value is string[] => value !== undefined) ? values.flat() : undefined;
  }
  return undefined;
}

function collectApprovedIdentifierTypes(sourceFile: ts.SourceFile): Map<string, string[]> {
  const identifiers = new Map<string, string[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const fromType = literalStringsFromType(node.type);
      const fromInitializer = node.initializer ? staticStrings(node.initializer) : undefined;
      const values = fromType ?? fromInitializer;
      if (values !== undefined) identifiers.set(node.name.text, values);
    }
    if (ts.isParameter(node)) {
      if (ts.isIdentifier(node.name)) {
        const values = literalStringsFromType(node.type);
        if (values !== undefined) identifiers.set(node.name.text, values);
      } else if (ts.isObjectBindingPattern(node.name) && node.type && ts.isTypeLiteralNode(node.type)) {
        const propertyTypes = new Map(
          node.type.members
            .filter((member): member is ts.PropertySignature => ts.isPropertySignature(member) && member.type !== undefined)
            .map((member) => [member.name.getText(), literalStringsFromType(member.type)]),
        );
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const values = propertyTypes.get((element.propertyName ?? element.name).getText());
          if (values !== undefined) identifiers.set(element.name.text, values);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return identifiers;
}

function jsxAttributeStaticStrings(attribute: ts.JsxAttribute): string[] | undefined {
  if (attribute.initializer === undefined) return [""];
  if (ts.isStringLiteral(attribute.initializer)) return [attribute.initializer.text];
  if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) {
    return staticStrings(attribute.initializer.expression);
  }
  return undefined;
}

function containsCheckboxToken(value: string): boolean {
  return value.split(/\s+/u).some((token) => token.toLowerCase().includes("checkbox"));
}

function descendantTextMatches(node: ts.Node | undefined, pattern: RegExp): boolean {
  if (node === undefined) return false;
  if ((ts.isStringLiteralLike(node) || ts.isIdentifier(node)) && pattern.test(node.text)) return true;
  let matched = false;
  ts.forEachChild(node, (child) => {
    if (!matched && descendantTextMatches(child, pattern)) matched = true;
  });
  return matched;
}

function isRolePropertyValue(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAssignment(parent) && parent.initializer === node && parent.name.getText().toLowerCase() === "role") ||
    (ts.isPropertyDeclaration(parent) && parent.initializer === node && parent.name.getText().toLowerCase() === "role")
  );
}

function isInsideJsxRoleAttribute(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isJsxAttribute(current)) return jsxAttributeName(current).toLowerCase() === "role";
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) return false;
    current = current.parent;
  }
  return false;
}

function isCheckboxNamedIcon(node: ts.JsxOpeningLikeElement): boolean {
  const tagName = node.tagName.getText();
  if (/checkbox.*icon|icon.*checkbox/i.test(tagName)) return true;

  return node.attributes.properties.some((property) => {
    if (!ts.isJsxAttribute(property)) return false;
    const name = jsxAttributeName(property);
    if (!/^(?:icon|iconName|name)$/i.test(name)) return false;
    return descendantTextMatches(property.initializer, /checkbox/i);
  });
}

function collectTsxViolations(filePath: string, source: string): CheckboxUiViolation[] {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const approvedIdentifierTypes = collectApprovedIdentifierTypes(sourceFile);
  const violations: CheckboxUiViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && /[☐☑☒]/u.test(node.text)) {
      addViolation(violations, filePath, source, node, "checkbox-glyph", node.text.trim(), "checkbox glyphs are banned from JSX text");
    }

    if (ts.isStringLiteralLike(node) && /[☐☑☒]/u.test(node.text)) {
      addViolation(violations, filePath, source, node, "checkbox-glyph", node.text, "checkbox glyphs are banned from static UI strings");
    }

    if (
      ts.isStringLiteralLike(node) &&
      node.text.toLowerCase() === "checkbox" &&
      isRolePropertyValue(node) &&
      !filePath.startsWith("apps/web/src/edit-mode/")
    ) {
      addViolation(violations, filePath, source, node, "checkbox-role", node.getText(), 'role="checkbox" is banned from product UI');
    }

    if (
      ts.isStringLiteralLike(node) &&
      node.text.toLowerCase() === "menuitemcheckbox" &&
      filePath !== sharedHubMenuPath &&
      !filePath.startsWith("apps/web/src/edit-mode/") &&
      !isInsideJsxRoleAttribute(node)
    ) {
      addViolation(violations, filePath, source, node, "menuitemcheckbox-role", node.getText(), "menuitemcheckbox is reserved for the shared HubMenu implementation");
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName.getText();
      const isInput = tagName.toLowerCase() === "input";
      if (isCheckboxNamedIcon(node)) {
        addViolation(violations, filePath, source, node, "checkbox-icon", tagName, "checkbox-named icons are banned from product UI");
      }

      for (const property of node.attributes.properties) {
        if (!ts.isJsxAttribute(property)) continue;
        const name = jsxAttributeName(property);
        const values = jsxAttributeStaticStrings(property);

        if (
          /^(?:class|className)$/i.test(name) &&
          (values?.some(containsCheckboxToken) === true || /checkbox/i.test(property.initializer?.getText() ?? ""))
        ) {
          addViolation(violations, filePath, source, property, "checkbox-class", property.getText(), "checkbox-named class tokens are banned from product UI");
        }

        if (/^role$/i.test(name)) {
          if (values?.some((value) => value.toLowerCase() === "checkbox")) {
            addViolation(violations, filePath, source, property, "checkbox-role", property.getText(), 'role="checkbox" is banned from product UI');
          }
          if (
            filePath !== sharedHubMenuPath &&
            values?.some((value) => value.toLowerCase() === "menuitemcheckbox")
          ) {
            addViolation(violations, filePath, source, property, "menuitemcheckbox-role", property.getText(), "menuitemcheckbox is reserved for the shared HubMenu implementation");
          }
        }

        if (isInput && /^type$/i.test(name)) {
          if (values?.some((value) => value.toLowerCase() === "checkbox")) {
            addViolation(violations, filePath, source, property, "checkbox-input", property.getText(), 'input type="checkbox" is banned from product UI');
            continue;
          }

          if (values === undefined && property.initializer && ts.isJsxExpression(property.initializer) && property.initializer.expression) {
            const expression = unwrapExpression(property.initializer.expression);
            const identifierValues = ts.isIdentifier(expression) ? approvedIdentifierTypes.get(expression.text) : undefined;
            if (identifierValues === undefined || identifierValues.some((value) => value.toLowerCase() === "checkbox")) {
              addViolation(violations, filePath, source, property, "nonliteral-input-type", property.getText(), "direct input type must be a literal or an explicitly narrowed non-checkbox string union");
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

function maskCssComments(source: string): string {
  let result = "";
  let index = 0;
  let inComment = false;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (inComment) {
      if (char === "*" && next === "/") {
        result += "  ";
        index += 2;
        inComment = false;
      } else {
        result += char === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      result += "  ";
      index += 2;
      inComment = true;
    } else {
      result += char;
      index += 1;
    }
  }
  return result;
}

function collectCssViolations(filePath: string, source: string): CheckboxUiViolation[] {
  const masked = maskCssComments(source);
  const violations: CheckboxUiViolation[] = [];
  for (const rule of masked.matchAll(/([^{}]+)\{/gu)) {
    const selector = rule[1] ?? "";
    const selectorStart = (rule.index ?? 0) + (rule[0].indexOf(selector));
    const matches = [
      ...selector.matchAll(/\.[-_a-zA-Z0-9]*checkbox[-_a-zA-Z0-9]*/giu),
      ...selector.matchAll(/input\s*\[\s*type\s*=\s*(?:checkbox|["']checkbox["'])\s*\]/giu),
    ];
    for (const match of matches) {
      violations.push({
        filePath,
        kind: match[0].startsWith(".") ? "checkbox-class" : "checkbox-input",
        lineNumber: lineNumberForIndex(source, selectorStart + (match.index ?? 0)),
        match: match[0],
        reason: "checkbox selectors are banned from product CSS",
      });
    }
  }
  return violations;
}

export function collectNoCheckboxUiViolationsFromSource(filePath: string, source: string): CheckboxUiViolation[] {
  const normalizedPath = filePath.replaceAll("\\", "/");
  if (normalizedPath.endsWith(".css")) return collectCssViolations(normalizedPath, source);
  if (normalizedPath.endsWith(".ts") || normalizedPath.endsWith(".tsx")) {
    return collectTsxViolations(normalizedPath, source);
  }
  return [];
}

function isExcludedPath(repositoryPath: string): boolean {
  if (repositoryPath.startsWith("apps/web/src/styles/remixicon/")) return true;
  const parts = repositoryPath.split("/");
  if (parts.some((part) => skippedDirectoryNames.has(part))) return true;
  return /(?:^|\/)[^/]*\.(?:test|spec|generated)\.(?:ts|tsx|css)$/u.test(repositoryPath);
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    const repositoryPath = path.relative(repoRoot, fullPath).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (!isExcludedPath(`${repositoryPath}/`)) files.push(...(await collectSourceFiles(fullPath)));
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name)) && !isExcludedPath(repositoryPath)) {
      files.push(repositoryPath);
    }
  }
  return files;
}

export async function checkNoCheckboxUi(): Promise<boolean> {
  const files = (await Promise.all(sourceRoots.map((root) => collectSourceFiles(path.join(repoRoot, root))))).flat();
  const violations: CheckboxUiViolation[] = [];
  for (const filePath of files) {
    violations.push(...collectNoCheckboxUiViolationsFromSource(filePath, await readFile(path.join(repoRoot, filePath), "utf8")));
  }

  if (violations.length > 0) {
    console.error("Product checkbox UI violations found:");
    for (const violation of violations) {
      console.error(`- ${violation.filePath}:${violation.lineNumber} \`${violation.match}\` -> ${violation.reason}`);
    }
    return false;
  }
  console.log(`No-checkbox UI check passed: ${files.length} production TypeScript, TSX, and CSS files checked.`);
  return true;
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain && !(await checkNoCheckboxUi())) process.exitCode = 1;
