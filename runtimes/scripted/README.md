# @harness/runtime-scripted

A runtime plug-in that replays a script instead of asking a model.

```yaml
# in a client document
runtime: scripted
```

The host reaches a runtime by name: the client document says `scripted`, the host derives
`@harness/runtime-scripted` from it and imports that package. This is the package a host test
names, so the suite drives the real loader against a real plug-in rather than being handed a
session it constructed — which is what `the-host-never-statically-imports-a-plugin` forbids.

The session itself is `ScriptedRuntime`, from `@harness/runtime-api/testing`: `say` steps become
text deltas and the joined `done` text, a `tool` step goes through `request.tools` exactly as a
model-backed runtime's calls do, and a `sleep` step holds the run open so a cancel can be tested.

## What a test hands it

`RuntimeDeps` has no channel for a trajectory, so this module's own state is the channel:

```ts
import { scriptedTrajectories } from '@harness/runtime-scripted';

scriptedTrajectories.set('alpha', [{ say: 'Alpha speaking.' }]);
```

The map is keyed by client id, and `connect` reads which client it is opening for from
`deps.env.HARNESS_CLIENT` — the host overlays that on the environment it hands a tenant's runtime,
because a pooled host's own process environment names no client. A client with no entry gets an
empty trajectory, which is a runtime that says nothing.

The dynamic `import('@harness/runtime-scripted')` inside the host's loader resolves the same module
record the test imported — one workspace package, one specifier — so the entry the test wrote is
the entry `connect` reads.

Nothing here is for production. `@harness/runtime-deepagents` is the model-backed runtime.
