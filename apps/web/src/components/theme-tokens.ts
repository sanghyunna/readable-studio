// Reading the light palette's own declarations off the loaded stylesheets.
//
// Every non-light theme is a `[data-theme='…']` block, so any element carrying
// that attribute resolves the theme's real tokens through the cascade no matter
// what the document is showing. Light is the `:root` baseline instead: it has
// no block of its own, and inside a dark or named-theme document a nested
// `data-theme="light"` element would simply inherit the document's palette.
// Miniatures that must stay true to light (the Theme modal's cards, the
// settings surfaces' theme chips) therefore read the baseline off the sheets
// and paint it inline. `styles/tokens.css` stays the single source of truth:
// nothing here carries a palette, and a later change to the file flows through
// untouched.

import type { CSSProperties } from 'react';

function isStyleRule(rule: CSSRule): rule is CSSStyleRule {
  return rule.type === CSSRule.STYLE_RULE;
}

function hasRootSelector(rule: CSSStyleRule): boolean {
  return rule.selectorText.split(',').some((selector) => selector.trim() === ':root');
}

/**
 * The values the loaded stylesheets' `:root` rules declare for `names`, as an
 * inline-style object. Rules under `@media` are not consulted on purpose: the
 * system-dark override lives there, and the baseline must stay light.
 */
export function rootTokenValues(names: readonly string[]): CSSProperties {
  const values: Record<string, string> = {};
  const visitSheet = (sheet: CSSStyleSheet) => {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      return; // cross-origin sheet: nothing of ours lives there
    }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSImportRule) {
        if (rule.styleSheet) visitSheet(rule.styleSheet);
      } else if (isStyleRule(rule) && hasRootSelector(rule)) {
        for (const name of names) {
          const value = rule.style.getPropertyValue(name).trim();
          if (value) values[name] = value;
        }
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) visitSheet(sheet);
  return values as CSSProperties;
}
