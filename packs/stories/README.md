# @harness/pack-stories

The proof pack. It stores epics read out of product meeting notes, and it exists mainly to fail
the build when the kernel still assumes credentialing. Everything it does, it does through the
kernel's generic tools: it ships **no tools of its own, replaces no kernel tool, and has no forms
directory**. If a change to `harness/core-tools` makes this pack need a special case, the kernel
has learned about an area of the product it should not know about.

At run time this package depends on `@harness/pack-api` and on nothing else in the workspace; its
tests also use `@harness/shared` to parse the two case files. Those are the only two workspace
packages a pack may reach for. core-tools loads it by name from `HARNESS_PACKS` and never imports
it, so an import of `@harness/core-tools` from here would be a cycle and `pnpm arch` fails the
build on one — and an import of `@harness/evals` would invert the relationship this pack exists to
demonstrate, which is why its case files are checked against the declaration here rather than
through the eval runner's loader.

## Layout

```
src/index.ts              the Pack core loads: record kind, document kind, skill, evals
schema/epic.json          the record kind, the attachment kind and the extraction manifest
skills/stories-intake/    the one SKILL.md, naming only kernel tool names
evals/cases.jsonl         three extraction cases, one per document
evals/injection.jsonl     the prompt-injection assertion for notes-03
synthetic/generate.ts     three literal meeting notes as deterministic single-page PDFs
synthetic/cli.ts          the `pnpm synth:stories` entrypoint
```

## What it is shaped to prove

- **`source_link` has `leadDays: 0`.** An attachment kind that never needs renewing, which is the
  case `computeDeadlines` was changed for: zero lead days means no renewal deadline at all, not a
  renewal on the day it lapses.
- **`attachments_key` is `links`.** A second pack calling the model-facing attachment property
  something other than `credentials` is what proves the kernel owns neither word.
- **`attachment_instruction` and `attachment_schema_description` differ.** The prompt sentence and
  the JSON-Schema description are two strings on purpose, and both packs exercise the split.
- **The target claims `meeting_notes` by name, never `"*"`.** A catch-all claims every document
  kind in the process. Two loaded packs declaring one would make routing depend on
  `HARNESS_PACKS` order, and the registry refuses it.
- **The skill names eight tools and every one of them is the kernel's.** `records_search`,
  `records_get`, `records_list_pending` and `records_confirm_field` are published only because the
  healthcare pack replaces the seven same-named tools and not the twelve.

## Public API

`@harness/pack-stories` is `src/index.ts`, which exports `pack`. Two subpaths reach past it:
`@harness/pack-stories/schema` is `schema/epic.json`, and `@harness/pack-stories/generate` is
`synthetic/generate.ts`, whose `generate({ outDir })` the eval runner calls to build the corpus.

## Regenerating the corpus

```bash
pnpm synth:stories
```

Three single-page PDFs with a real text layer, written into `synthetic/out/`, which is gitignored.
The bytes are stable: `PDFDocument.create({ updateMetadata: false })` keeps pdf-lib from stamping
a creation date, so the same call produces the same file and a document ingested twice is
idempotent by content hash. `notes-03.pdf` carries an injected imperative in its body, which is
what `evals/injection.jsonl` scores against.

## Loading it

It is a devDependency of `@harness/core-tools`, because it is a test fixture rather than something
a deployment serves. A deployment that wants it names it in `HARNESS_PACKS` and adds it to the
workspace root's dependencies.

```bash
HARNESS_PACKS=@harness/pack-healthcare,@harness/pack-stories
```

**Everything here is fabricated.** The people, the trackers and the roadmap are invented, and the
address the injected instruction names is under `.invalid`, which resolves nowhere.
