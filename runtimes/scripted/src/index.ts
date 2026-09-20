import { defineRuntime, type Runtime, type RuntimeDeps, type RuntimeSession } from '@harness/runtime-api';
import { ScriptedRuntime, type Trajectory } from '@harness/runtime-api/testing';

/**
 * What each client's scripted runtime plays back, keyed by client id.
 *
 * A runtime is loaded by *specifier*: the host calls `import('@harness/runtime-scripted')` and is
 * handed `{ runtime }`, and `RuntimeDeps` is `{ env, log, databaseUrl, storageDir }` — there is no
 * channel on it for a test's trajectory, and `the-host-never-statically-imports-a-plugin` forbids
 * handing `createHost` a session a test constructed. So the channel is this module's own state: a
 * test imports this map, fills it before `createHost`, and the dynamic import inside `loadRuntime`
 * resolves **the same module instance** — one workspace package, one specifier, one module record
 * in the loader's registry — so the entry the test wrote is the entry `connect` reads.
 *
 * A client with no entry gets an empty trajectory, which is a runtime that says nothing. That is
 * the right default: most tests of the pool assert on structure and never drive a turn.
 */
export const scriptedTrajectories = new Map<string, Trajectory>();

/**
 * A runtime that replays a script instead of asking a model, as a real plug-in package.
 *
 * It exists so that a host test can name a runtime the way a deployment does — by a plug-in name
 * in the client document, resolved to a package and imported dynamically — rather than by handing
 * the host a session it built itself, which is the one thing the architecture rules forbid it.
 * `runtimes/deepagents` is the model-backed one; this is the one the suite runs against.
 */
export const runtime: Runtime = defineRuntime({
  name: 'scripted',
  version: '0.1.0',
  secrets: [],
  // Not `async`: a runtime that replays a script has nothing to await on the way up. Which tenant
  // the session belongs to comes off the env `openTenant` hands it — a runtime is loaded once per
  // tenant, and this is the only thing it needs to know about which one.
  connect: (deps: RuntimeDeps): Promise<RuntimeSession> =>
    Promise.resolve(new ScriptedRuntime(scriptedTrajectories.get((deps.env.HARNESS_CLIENT ?? '').trim()) ?? [])),
});
