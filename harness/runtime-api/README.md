# @harness/runtime-api

The contract between the host and a runtime plug-in. A runtime turns one message into a stream
of events — text deltas, tool calls, skill activations, usage, and a final answer or error — by
driving an MCP client already connected to a core-tools server built on that run's `ToolDeps`.
The host loads a runtime by name and never sees how it gets there.

It depends on `@harness/shared`, zod and the MCP client type, and on nothing else in the
workspace, which is what lets the host load a plug-in by name at runtime instead of importing it
at build time.

| Module           | Holds                                                                         |
| ---------------- | ----------------------------------------------------------------------------- |
| `src/types.ts`   | every declaration: `RunRequest`, `RunEvent`, `RuntimeSession`, `Runtime`, ... |
| `src/runtime.ts` | `defineRuntime`                                                               |
| `src/gateway.ts` | the fake OpenAI-wire gateway, reached as `@harness/runtime-api/testing`       |
| `src/testing.ts` | re-exports the fake, reached as `@harness/runtime-api/testing`                |

`RunPrincipal` is written out here, structurally a subset of the identity contract's `Principal`,
because this leaf may not import `@harness/identity-api`: a contract that tied the loop to one
way of knowing who is asking would defeat the point of having a contract.

`hashArgs`, the stable fingerprint every `tool_call` event and every audit row stamps on a tool's
arguments, lives in `@harness/shared` for the same reason: both runtimes and the kernel need it,
and neither runtime may import the kernel.

The fake gateway is both the double every runtime test drives and the double core-tools' own
model-gateway tests drive, so the thing the suite proves a runtime against is the thing that runs
against the kernel too.
