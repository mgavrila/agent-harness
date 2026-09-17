# @harness/host

The composition root that runs the kernel and a runtime plug-in in one process, per conversation
turn. It holds no transport and no framework: which messaging surfaces it serves comes from
`HARNESS_SURFACES` (loaded by `@harness/approvals`), which identity plug-in resolves a principal
comes from `HARNESS_IDENTITY`, and which agent runtime drives the loop comes from `HARNESS_RUNTIME`
— every one of them a dynamic import, never a static edge from this package into a plug-in's
source.

This task (Plan 8a, Task 6) lands the building blocks the composition root is made of, each
testable on its own against Postgres:

- the kernel configuration, built once per process (`buildKernelConfig`, moved into
  `@harness/core-tools`'s domain layer so this package — and no other — may call it);
- a runtime loaded by its package name (`loadRuntime`);
- a conversation's thread, found or created, with its history appended and trimmed
  (`findOrCreateThread`, `appendMessage`, `recentHistory`, `trimHistory`);
- the skill catalogue and the persona, read off disk (`readSkillCatalogue`, `readPersona`);
- one `ToolDeps` and one in-process MCP client per run (`openKernel`).

The flows that call these in order — the conversation turn, the process entry point — are a later
task's job, once the runtime and the surfaces are wired together.

## Layout

```text
src/domain/host.ts             the Host type: everything a flow takes, built once per process
src/domain/runtime/registry.ts loadRuntime: HARNESS_RUNTIME, the same three failure modes as loadIdentity
src/domain/threads/repository.ts findOrCreateThread, appendMessage (with the redaction guard), recentHistory
src/domain/threads/trim.ts     trimHistory: the newest turns under a message and a character budget
src/domain/skills.ts           readSkillCatalogue: name, version, description off every SKILL.md
src/domain/persona.ts          readPersona: SOUL.md
src/domain/kernel.ts           openKernel: one run, one ToolDeps, one in-process MCP client
src/index.ts                   the public API
src/testing.ts                 ./testing: testKernelConfig, useTestDb
```

## The host never statically imports a plug-in

Surfaces, the identity plug-in and the runtime are all loaded by name, at startup, through a
dynamic import — the same shape `@harness/core-tools`'s `loadPacks` and `loadIdentity` and
`@harness/approvals`'s `loadSurfaces` already use. `pnpm arch` forbids a static edge from
`harness/host/src` into `surfaces/*`, `identities/*`, `runtimes/*` or `packs/*`; `src/testing.ts`
and `*.test.ts` are exempt, because a host test drives the real memory surface and the real
runtime loader against the packages that ship, and neither is shipped itself.

## Testing

```bash
pnpm --filter @harness/host test
```

Real Postgres (`harness_test`) through `useTestDb()` from `./testing`, the real Deep Agents
runtime plug-in and the shipped healthcare pack's skills.
