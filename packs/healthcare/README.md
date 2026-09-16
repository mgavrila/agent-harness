# @harness/pack-healthcare

Content plus one declaration: everything the harness needs to do credentialing for a medical
practice, and a `Pack` that tells core where it all is. This package depends on
`@harness/pack-api` and `@harness/shared` and on nothing else in the workspace. core-tools
loads it by name from `HARNESS_PACKS` and never imports it, so an import of
`@harness/core-tools` from here would be a cycle and `pnpm arch` fails the build on one.

## Layout

```
src/index.ts              the Pack core loads: document kinds, manifest, forms, skills, policy
schema/provider.json      the extraction manifest: fields, credentials, document kinds
forms/templates.json      which PDF field each record value fills
forms/*.pdf               two demo AcroForm templates (generated, committed)
forms/generate-templates.ts   rebuilds them deterministically
skills/                   four SKILL.md files the agent loads
evals/injection.jsonl     the prompt-injection assertions
policy.yaml               the pack's default action-class table
synthetic/types.ts        the ground-truth shapes
synthetic/rng.ts          mulberry32 and the check-digit-valid identifier generators
synthetic/fixtures.ts     the name, state, school, carrier and board tables; makeProvider
synthetic/pdf.ts          writeTextPdf and the rasterised scan twin
synthetic/plan.ts         the four document plans and the injection twin
synthetic/generate.ts     assertSafeToClear and generate
synthetic/cli.ts          the `pnpm synth` entrypoint
```

## Public API

`@harness/pack-healthcare` is `src/index.ts`, which exports `pack`. That is what core loads,
and the only thing a deployment names. Two subpaths reach past it, and neither is on the
loading path: `@harness/pack-healthcare/schema` is `schema/provider.json` for a consumer that
wants the raw manifest rather than `pack.extraction`, and `@harness/pack-healthcare/generate`
is `synthetic/generate.ts` — `generate`, `assertSafeToClear` and the ground-truth types.
Nothing else is reachable.

`pack.formsDir` and `pack.skillsDir` are absolute paths resolved from `import.meta.url`, so a
consumer never builds a path into this package by hand.

## Regenerating

```bash
pnpm synth              # the full corpus, text layer and scan twins
pnpm synth:fast         # text layer only, about six times faster
pnpm forms:generate     # rebuild the two AcroForm templates
```

The corpus is **deterministic in its content**: one seed produces the same providers, the same
page text and the same `ground-truth.json` and `cases.jsonl`, which is what lets the eval
baseline mean anything. The PDF _bytes_ are not stable run to run, because pdf-lib stamps a
creation and a modification date into every file it saves, so compare content rather than
checksums. If a change to `synthetic/` makes the same seed produce different providers or
different page text, that is a finding, not a detail. `generate` refuses to clear an output
directory that is neither empty nor a corpus it wrote — `ground-truth.json` is the marker.

**Everything here is fabricated.** The NPIs are check-digit valid and unregistered; the SSNs
are in issued ranges so the redaction pass sees them. None of it belongs to anyone.
