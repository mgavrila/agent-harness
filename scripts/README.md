# @harness/scripts

Repository tooling. One command today: the client scaffolder.

```
src/domain/scaffold.ts   newClient: copy a client template, substituting the slug and display name
src/app/cli.ts           the `pnpm new-client` entrypoint
```

## Usage

```bash
pnpm new-client --pack healthcare --name acme-clinic
```

It copies `clients/demo-practice/` (or `--template <slug>`) into `clients/acme-clinic/`,
rewrites every mention of the template's slug and display name, preserves the executable bit
on the playbook scripts, and prints what to do next. It never overwrites an existing client
directory.

This package has no `exports` map on purpose: nothing may import it.

## Testing

```bash
pnpm --filter @harness/scripts test
```

Filesystem only — no database, no network.
