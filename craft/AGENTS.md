# craft

12 brand-agnostic rulebooks (`color.md`, `typography.md`, `anti-ai-slop.md`,
`laws-of-ux.md`, `accessibility-baseline.md`, …). Flat markdown, no schema, no
frontmatter requirement.

Opt-in only: a skill lists slugs under `readable.craft.requires`; the daemon resolves
them in `apps/daemon/src/craft.ts` and concatenates the bodies with section headers,
injected between `DESIGN.md` and the skill body — so brand tokens win on conflict and
craft rules cover everything below.

**Unknown slugs are ignored silently.** A typo produces no error and no injection. If a
craft rule "isn't working", check the slug spelling in the skill manifest first.

A new file here is immediately referenceable by slug (filename without `.md`); nothing
else needs registering.
