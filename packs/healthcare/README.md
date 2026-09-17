# @harness/pack-healthcare

Content plus one declaration: everything the harness needs to do credentialing for a medical
practice, and a `Pack` that tells core where it all is. This package depends on
`@harness/pack-api` and `@harness/shared` and on nothing else in the workspace. core-tools
loads it by name from `HARNESS_PACKS` and never imports it, so an import of
`@harness/core-tools` from here would be a cycle and `pnpm arch` fails the build on one.

It is the **primary** pack of the demo deployment: the first name in `HARNESS_PACKS`, which is
what makes its forms directory and its extraction manifest the ones core answers with.

## Layout

```
src/index.ts              the Pack core loads: record kinds, attachment kinds, manifest, forms, skills, policy, evals
src/config.ts             this pack's four VERIFY_*/NPPES_* variables, read out of deps.env
src/tools/                the eighteen tools: aliases.ts, forms.ts, verify.ts
src/domain/               forms fill and roster, the NPPES registry adapter, the credential kinds
schema/provider.json      the declaration: the provider record kind, four attachment kinds, the extraction manifest
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

The kernel-side tool suites are **not** here. They boot the real kernel against Postgres, which
a pack cannot import without a cycle, so they live in
`harness/core-tools/src/app/pack-healthcare/`.

## What this pack declares

One record kind, `provider`, with the eighteen fields in `schema/provider.json` — three of them
restricted (`ssn`, `ein`, `dea_number`) and filled from the kernel's redaction pass, never from
a model. Four attachment kinds with their lead times: `license` and `dea` at 90 days,
`malpractice` at 60, `board_cert` at 120. Five document kinds, claimed by name, all feeding one
extraction target.

`provider` sets `genericTools: false`, so a healthcare deployment publishes no `records_*`: this
pack ships `providers_*` instead, and the tool surface is exactly what it was before core became
pack-agnostic.

## The eighteen tools

Six it owns — `verify_nppes`, `verify_state_license`, `forms_list_templates`, `forms_fill`,
`forms_roster`, `forms_release` — and twelve wrappers in `src/tools/aliases.ts` over the
kernel's generic tools: `providers_upsert/get/search/confirm_field/list_pending` over
`records_*`, and same-named replacements for `documents_ingest/get/list/classify/extract` and
`deadlines_compute/upcoming`. Each wrapper's zod schema is the pre-Plan-5 definition character
for character, which is why `docs/architecture/tool-surface.json` did not move; each one calls
its kernel handler through `deps.kernelTools`, never `deps.tools`, which after a replacement
holds the wrapper itself.

`replaces` lists **seven** of those twelve, not all of them: the five same-named `documents_*`
and the two `deadlines_*`. The `providers_*` five are renames over `records_*`, and the
`records_*` names are hidden from this deployment by `genericTools: false` on the `provider`
record kind instead — per kind, so a second pack loaded beside this one keeps them.

Because `replaces` is process-wide, this pack's `documents_*` also see another pack's documents.
The three that reshape a result — `documents_get`, `documents_list` and `documents_extract` —
therefore build their **output schema from `deps`**: byte-identical to the snapshot when only
healthcare kinds are loaded, and widened to admit the kernel's `record_id` and `attachments`
when another pack is. A foreign document is passed back exactly as the kernel produced it;
renaming an epic's id to `provider_id` would be this pack answering for records it does not own.

The pack has no database handle. `forms_fill` and `forms_roster` read a provider through
`records_get`, which client-scopes the read and masks every restricted value, and write their
output through `deps.kernel.writeOutFile`.

## Configuration

`src/config.ts` reads this pack's four variables: `VERIFY_NPPES_ENABLED`, `NPPES_BASE_URL`,
`VERIFY_STATE_LICENSE_ENABLED` and `VERIFY_TIMEOUT_MS`, and it reads them out of `deps.env`
rather than `process.env`. They used to be read by core-tools and carried on `ToolDeps.verify`,
which no longer exists; NPPES is this pack's business. `.env.example` documents all four, and
the public-surface test checks that it does. `Pack.evals.testEnv` pins the same four off under
test and eval, so a run on a filled-in `.env` cannot reach the live CMS endpoint.

## Public API

`@harness/pack-healthcare` is `src/index.ts`, which exports `pack`. That is what core loads,
and the only thing a deployment names. Two subpaths reach past it, and neither is on the
loading path: `@harness/pack-healthcare/schema` is `schema/provider.json` for a consumer that
wants the raw manifest rather than `pack.extraction`, and `@harness/pack-healthcare/generate`
is `synthetic/generate.ts` — `generate`, `assertSafeToClear` and the ground-truth types.
Nothing else is reachable.

`pack.formsDir` and `pack.skillsDir` are absolute paths resolved from `import.meta.url`, so a
consumer never builds a path into this package by hand.

Two exports beside `pack` exist for core-tools' own tests, which may not reach a path into this
source tree: `loadManifest`, so a kernel-side test can check that no template here maps a name
the kernel's redaction rules call restricted, and `ROSTER_COLUMNS`, the payer's column contract
asserted against `forms_roster`'s result.

## How core loads this pack

`src/index.ts` exports `pack`, a `Pack` from `@harness/pack-api`. core-tools imports this module
by name at startup, from `HARNESS_PACKS`, and reads everything through `deps.packs`. Name it
first — `HARNESS_PACKS=@harness/pack-healthcare` for the demo deployment, and
`@harness/pack-healthcare,@harness/pack-stories` when the proof pack rides along — because the
first entry is the primary pack and this one owns the forms.

This package depends on `@harness/pack-api` and `@harness/shared` and on nothing else in the
workspace; an import of `@harness/core-tools` or `@harness/db` from here would be a cycle and
`pnpm arch` fails the build on one.

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
