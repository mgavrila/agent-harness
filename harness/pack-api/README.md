# @harness/pack-api

The contract a pack implements and core loads. Two dependencies: `@harness/shared` and zod.

```ts
import { definePack } from '@harness/pack-api';
export const pack = definePack({ … });
```

`Pack` is in `src/pack.ts`; the types it uses are in `credentials.ts`, `policy.ts`, `tool.ts`
and `manifest.ts`. `@harness/core-tools` re-exports every one of them, so a module inside
core-tools imports them from where it always did.

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
