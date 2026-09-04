// The entry topbar avatar must never carry a hardcoded identity.
//
// entry-layout.css used to paint the home topbar's account control by hiding
// the control's real content (`font-size: 0` + `svg { display: none }`) and
// injecting `content: 'SH'` — one specific person's initials, compiled into
// the product. The same bug existed on the hub rail footer avatar, where the
// literal masked the genuine `workspaceInitials(username)` output; with it
// removed the runtime correctly renders `US` for the Windows user `User`.
//
// Identity must always derive from the real runtime user boundary
// (`/api/runtime/user` -> `os.userInfo().username` -> `workspaceInitials`),
// never from a string in a stylesheet. This test is the standing guard: it
// fails if any initials-shaped literal is reintroduced, and it fails if the
// masking declarations that only exist to hide real text come back.

// STATUS: landed. `EntrySettingsMenu` now takes a `username` prop and renders
// `workspaceInitials(username)` as real text in its trigger; `EntryShell`
// threads the runtime user in, and the masking declarations plus the literal
// are gone from the stylesheet.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const entryLayoutCss = readFileSync(
  new URL('../../src/styles/home/entry-layout.css', import.meta.url),
  'utf8',
);
const entrySettingsMenuTsx = readFileSync(
  new URL('../../src/components/EntrySettingsMenu.tsx', import.meta.url),
  'utf8',
);
const entryShellTsx = readFileSync(
  new URL('../../src/components/EntryShell.tsx', import.meta.url),
  'utf8',
);

/** The home topbar block that styles the account control. */
const HOME_TOPBAR_AVATAR = /\.entry-main__topbar:has\(~ \.entry-main__inner--home\) \.settings-icon-btn/;

describe('entry topbar avatar identity', () => {
  it('never hardcodes initials as generated content', () => {
    // Any `content: 'XX'` on the avatar is by definition a baked-in identity:
    // real initials can only come from the runtime user.
    const initialsLiteral = /content:\s*['"][A-Za-z]{1,3}['"]/g;
    const offenders = entryLayoutCss.match(initialsLiteral) ?? [];

    expect(offenders).toEqual([]);
  });

  it('does not mask the account control\'s real content', () => {
    // `font-size: 0` and `svg { display: none }` on this control existed only
    // to hide what the component actually renders so the literal could show
    // through. Neither has a legitimate reason to return here.
    const avatarRules = entryLayoutCss
      .split(/(?=\.entry-main__topbar)/)
      .filter((block) => HOME_TOPBAR_AVATAR.test(block));

    expect(avatarRules.length).toBeGreaterThan(0);
    for (const rule of avatarRules) {
      expect(rule).not.toMatch(/font-size:\s*0\s*;/);
      expect(rule).not.toMatch(/\bsvg\s*\{[^}]*display:\s*none/);
    }
  });

  it('contains no personal-identity literal anywhere in the stylesheet', () => {
    // Guards the whole file, not just the avatar: no two/three-letter initials
    // literal may be introduced by any future rule.
    expect(entryLayoutCss).not.toMatch(/content:\s*['"]SH['"]/i);
  });
});

describe('entry topbar avatar identity — runtime source', () => {
  it('derives the trigger initials from the runtime username prop', () => {
    expect(entrySettingsMenuTsx).toMatch(/username\?:\s*string \| null/);
    expect(entrySettingsMenuTsx).toMatch(/workspaceInitials\(username \?\? ''\)/);
  });

  it('threads the real runtime user from EntryShell into the menu', () => {
    expect(entryShellTsx).toMatch(/const username = useRuntimeUsername\(\);/);
    expect(entryShellTsx).toMatch(/username=\{username\}/);
  });
});
