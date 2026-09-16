# @harness/pack-api

The contract a pack implements and core loads. Two dependencies: `@harness/shared` and zod.

```ts
import { definePack } from '@harness/pack-api';
export const pack = definePack({ … });
```

`Pack` is in `src/pack.ts`. It says four things, each with its own module:

- **what a pack stores** — `RecordKindSpec` and `AttachmentKindSpec` in `records.ts`, over the
  field manifest in `manifest.ts`;
- **what a document turns into** — `ExtractionManifest` in `extraction.ts`, one
  `ExtractionTarget` per family of document kinds;
- **what a pack's tools are handed** — `PackToolDeps`, `PackKernel` and `CoreToolView` in
  `kernel.ts`, the structural view of core's `ToolDeps` a pack can name without importing
  core-tools;
- **how a pack is evaluated** — `PackEvals` in `evals.ts`.

`policy.ts`, `tool.ts` and `credentials.ts` carry the rest. `@harness/core-tools` re-exports
what its own modules need, so a module inside core-tools imports it from where it always did.

## Why a pack never depends on core-tools

The product is a foundation onto which project-specific areas are plugged: healthcare
credentialing today, document scanning that produces stories and epics tomorrow. If core
imported a pack by name it could serve exactly one. So the direction is reversed: core reads
`HARNESS_PACKS`, imports each name dynamically, and reaches everything through `PackRegistry`.
`pnpm arch` fails the build on a static `@harness/pack-*` import from core-tools source.

## Adding a pack

See CONTRIBUTING.md, "Adding a pack". The short version: create `packs/<name>/` exporting
`pack` from `src/index.ts`, add it to `@harness/core-tools`'s `dependencies` so pnpm can
resolve it, and name it in `HARNESS_PACKS`.
