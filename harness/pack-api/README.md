# @harness/pack-api

The contract a pack implements and core loads. Two dependencies: `@harness/shared` and zod.

```ts
import { definePack } from '@harness/pack-api';
export const pack = definePack({ … });
```

`definePack` is in `src/pack.ts`. A `Pack` says five things, each with its own module:

- **what a pack stores** — `RecordKindSpec` and `AttachmentKindSpec` in `records.ts`, over the
  field manifest in `manifest.ts`. `defineRecordKind` and `defineAttachmentKind` turn a typo
  into a startup failure; `parseRecordKind` reads the same shape out of the JSON a human edits;
- **what a document turns into** — `ExtractionManifest` in `extraction.ts`, one
  `ExtractionTarget` per family of document kinds, carrying the prose the model reads and the
  key the attachment list travels under;
- **what a pack's tools are handed** — `PackToolDeps`, `PackKernel` and `CoreToolView` in
  `kernel.ts`, the structural view of core's `ToolDeps` a pack can name without importing
  core-tools;
- **how a pack is evaluated** — `PackEvals` in `evals.ts`: the corpus, the cases, the intake
  skill, the judged fields, the env values a test must see pinned, and the `EvalReadback` block
  naming which tools one case drives and which keys their results carry;
- **what its actions default to** — `Policy` in `policy.ts`.

`tool.ts` carries `definePackTool`, and `types.ts` is the leaf holding every declaration on the
contract's own reference cycle: a `Pack` declares tools handed a `PackToolDeps`, and a
`PackToolDeps` reaches a `Pack` back through `PackRegistryView`, so no arrangement of one module
per concept breaks that cycle. `pack.ts`, `kernel.ts` and `tool.ts` re-export from it.
`@harness/core-tools` re-exports what its own modules need, so a module inside core-tools
imports it from where it always did.

## Why a pack never depends on core-tools

The product is a foundation onto which project-specific areas are plugged: healthcare
credentialing today, document scanning that produces stories and epics tomorrow. If core
imported a pack by name it could serve exactly one. So the direction is reversed: core reads
`HARNESS_PACKS`, imports each name dynamically, and reaches everything through `PackRegistry`.
`pnpm arch` fails the build on a static `@harness/pack-*` import from core-tools source, and on
an import of core-tools or `@harness/db` from a pack.

`PackToolDeps` is a structural view of core-tools' `ToolDeps`: every member of the view is a
member of the whole, so core hands a pack its real dependency bag with no cast at the call site,
and `harness/core-tools/src/domain/packs/assignability.test.ts` fails the build if that stops
being true. `PackKernel` carries the kernel operations that are not tools — writing a generated
file into the out tree, staging a release, and the two redaction primitives a `redact` needs —
because a pack cannot import those either.

## Adding a pack

See CONTRIBUTING.md, "Adding a pack", which works through `packs/stories` line by line. The
short version: create `packs/<name>/` exporting `pack` from `src/index.ts`, add it to
`@harness/core-tools`'s `dependencies` so pnpm can resolve the dynamic import, and name it in
`HARNESS_PACKS`.
