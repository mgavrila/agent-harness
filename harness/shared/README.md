# @harness/shared

Seven modules of pure helpers with no domain knowledge and no workspace dependency of their
own: `errors.ts`, `env.ts`, `paths.ts`, `log.ts`, `subprocess.ts`, `jsonl.ts` and `csv.ts`. This
is the bottom of the graph — `@harness/db` and every pack depend on it, and it depends on
nothing but Node built-ins — see ARCHITECTURE.md, "The four layers".

```ts
import { ConfigError, createLogger, requiredEnv } from '@harness/shared';
```

`@harness/core-tools` re-exports every name below from its own public API, so a module that
already imports one of them from `@harness/core-tools` is not wrong, only indirect. Approvals,
evals and the healthcare pack import `@harness/shared` directly; `scripts` needs none of it.

## What is not here

Redaction — which field names are restricted, which SSA allocations are real — is domain
knowledge, so it stays in `@harness/core-tools`, at `src/shared/redaction/`.

## Testing

```bash
pnpm --filter @harness/shared test
```

No `globalSetup` and no `fileParallelism: false`: nothing here touches Postgres, so the suite
runs in parallel.
