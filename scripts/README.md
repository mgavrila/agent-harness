# @harness/scripts

Repository tooling. One command today: the client scaffolder.

```
src/domain/scaffold.ts   newClient: write a client document from the fixture, into a directory
                          outside this repository
src/app/cli.ts           the `pnpm new-client` entrypoint
```

## Usage

```bash
pnpm new-client --name river-clinic --display-name "River Clinic" --pack healthcare
pnpm new-client --name internal-team --target /srv/tenants
```

It reads `clients/fixture/`'s document, substitutes the new client's id, display name and pack,
and writes `client.yaml` and `persona.md` into `<target>/<name>/` — `--target`, or
`HARNESS_CLIENTS_DIR` when `--target` is not given; it refuses to run with neither, because a
client does not live in this repository. It touches no `.env`: secrets are the operator's job. It
never overwrites an existing client directory.

This package has no `exports` map on purpose: nothing may import it.

## Testing

```bash
pnpm --filter @harness/scripts test
```

Filesystem only — no database, no network.
