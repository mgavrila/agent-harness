# @harness/sandbox-api

The seam for running a command somewhere that is not this process. **Reserved, not implemented**
(spec decision 14): nothing in this repository acquires a sandbox, there is no `execute` action
class yet, and no tool exposes one.

```
SandboxProvider  acquire(session) -> Sandbox
Sandbox          exec(command, opts), putFile(path, bytes), getFile(path), terminate()
SandboxSession   { client, runId, principalId }
ExecResult       { exitCode, stdout, stderr, durationMs }
```

The unit is a session — one run, of one principal, of one client — and the promise is that what
one session writes, another cannot read. A provider may pool, pause or reuse whatever it likes
underneath.

`@harness/sandbox-api/testing` ships `MemorySandboxProvider`, whose files are a map and whose
commands are a script, and `sandboxProviderConformance(makeProvider)`, which every provider runs.
The first real one — agent-sandbox, with a claim from a tenant's warm pool — is its own plan, and
it inherits this suite rather than writing one.
