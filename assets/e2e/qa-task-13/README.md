# QA task 13 visual references

These checked-in images are the canonical light-theme baselines used by
`e2e/ui/qa-task-13.test.ts`. They live under durable shared assets because
`.tmp/` is disposable runtime data and cannot safely hold required test inputs,
while `e2e/resources/` is reserved for flat TypeScript source files.

The original approved-design captures were lost when `.tmp/` was cleaned. These
baselines were recovered from the latest complete QA13 rendered captures on
2026-09-04, so they intentionally record the UI as rendered at that point rather
than reconstructing the lost design oracle. The test's independent geometry,
paint, accessibility, motion, and behavioral assertions remain authoritative.
