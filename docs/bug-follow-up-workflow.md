# Bug follow-up workflow

**Parent:** [../AGENTS.md](../AGENTS.md) - repository rules. Referenced from the root Validation strategy section.


The following is a working playbook for routine bug follow-ups, distilled from recent practice. Treat it as a default action shape, not a contract — production reality always has edges these bullets can't anticipate, so use judgment when the situation doesn't fit cleanly.

- **Lead with a red spec.** Default to encoding the bug as a falsifiable test that goes red before any source change, so the fix is anchored in observable behavior rather than source-code intuition. If a red spec can't be written cheaply, that's usually a signal to clarify scope rather than push forward on a guess.
- **Try the cheapest layer first.** Reach for the lightest test layer that can still see the symptom (e2e Vitest at the daemon HTTP boundary → app-local Vitest → Playwright UI → platform-native harnesses), and drop down only when the cheaper layer can't.
- **Hold the spec's scope.** Defects discovered outside the bug's described boundary belong in a follow-up — their own red spec, their own PR — not in this fix. List them in the PR body's "Adjacent issues" section with the rationale and move on.
- **Let the fix read as an invariant.** Prefer a named helper whose docblock describes what must hold over a bolt-on `if` guard with apologetic history-comments. The call site should read as intent.
- **Diff against the baseline.** When neighboring suites have pre-existing failures, stash or check out upstream before claiming "no new failures."
- **Link the issue from the PR body.** Use `Fixes #N` / `Closes #N` / `Resolves #N` so the issue auto-closes on merge and the release-time reverse lookup (`gh issue view N --json closedByPullRequestsReferences` → `git tag --contains <merge sha>`) actually has a chain to follow. The repo's PR template prompts for this; deleting the prompt is fine when the PR genuinely closes nothing.
- **Stage human verification for visible bugs.** When the symptom needs an eye to confirm — UI, platform-native behavior, animations, race conditions a unit test can't see — green specs alone aren't acceptance. Stand up a buggy-vs-fix comparison the reviewer can drive themselves (typical shape: two namespaced runtimes, one on `main`, one on the fix branch), and seed any required data only through production HTTP APIs; source-level test backdoors invalidate the verification because they prove a fake flow rather than the real one.

For a worked example of one full loop (red e2e spec → fix → green), see `e2e/tests/dialog/stop-reconciles-message.test.ts` (issue #135).

