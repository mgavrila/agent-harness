# @harness/runtime-deepagents

The Deep Agents JS runtime, behind the runtime contract.

This package is the only place in the workspace where `deepagents`, `langchain` and `langgraph`
may be spelled. The host loads it by name, hands it a `RunRequest`, and reads `RunEvent`s back;
everything the framework knows stays under this directory. `harness/core-tools/src/kernel-vocabulary.test.ts`
is what says so, and it scans this package for every _other_ vocabulary — a runtime plug-in that
knew what a message surface was, or which client it was serving, would be the coupling the
contract exists to remove.

## Pinned versions

Every framework dependency is pinned to an exact version, not a caret:

| package                                    | version |
| ------------------------------------------ | ------- |
| `deepagents`                               | 1.13.4  |
| `langchain`                                | 1.5.11  |
| `@langchain/core`                          | 1.2.11  |
| `@langchain/openai`                        | 1.5.13  |
| `@langchain/langgraph`                     | 1.4.15  |
| `@langchain/langgraph-checkpoint-postgres` | 1.0.5   |

Deep Agents releases weekly and the option names this package depends on — `skills`, `memory`,
`permissions`, the filesystem middleware's `tools` allowlist, the shape of the `updates` stream —
were read off these versions' declarations. A caret would let a minor release move them under a
green lockfile. Raise the pin deliberately, and run the suite.

## One agent per run

`runDeepAgent` builds a `createDeepAgent` for every run, because everything about it is per run:
the model carries the principal as `user`, the tools are this run's kernel client, the system
prompt is this client's persona. Only the checkpointer is shared, keyed by the thread id, and it
is what carries continuity — the history on the request is seeded once, for a thread that has no
checkpoint yet.

The model is a `ChatOpenAI` on `request.model.baseUrl + /v1` with the gateway's key, so no vendor
key is ever in this process, and with `maxRetries: 0`: a retry inside the SDK is a model call the
budget does not count and a wait the run timeout does not know about. A failing route is the
gateway's problem first and `request.model.fallbackRoute`'s second, which is wired through
`modelFallbackMiddleware`.

## The tool bridge

`domain/bridge.ts` is the only place a kernel tool is invoked. It lists the tools off the MCP
client the host connected, wraps each as a LangChain `tool`, and on every call:

- emits `tool_call` with a hash of the arguments, never the arguments;
- calls through that one client, so policy, audit and the outbox stay the kernel's business;
- emits `tool_result` with `ok`, `pending` or `error`;
- counts the call against `budget.maxToolCalls` and aborts the run on the first call past it.

What the model reads back is the kernel's own text — a `pending` envelope, a "Tool x failed" line
— never reshaped, so what the model reads is what the audit row says.

## Files, skills and memory

The model reaches no filesystem. Each skill's `SKILL.md` is read once per turn and seeded into
agent state at `/skills/<name>/SKILL.md`, and the memory snapshot at `/memories/MEMORY.md`. The
built-in filesystem middleware is cut to four tools — `read_file`, `ls`, `glob`, `grep` — and
every write is denied by a permission rule over `/**`. The `task` tool is stripped from every
model request by `KernelToolFilter`, because this run has no subagents.

The framework's own `memory` option is deliberately not used: it inlines the file into the system
prompt and tells the model to save what it learns with `edit_file`, a tool this run neither offers
nor permits. `KERNEL_RULES` tells the model to open `/memories/MEMORY.md` with `read_file` instead.

A `read_file` of a path under `/skills/<name>/` is what `skill_activated` means here.

## What reaches the surface as text

Only the agent's own model node. Every model call inside the graph streams through the `messages`
mode, the summarization middleware's included, so `modelTurnChunk` checks each payload's
`langgraph_node` before a delta becomes a `text` event or a `usage` event. Without it a long thread
would show the human a summary of their own conversation in place of an answer.

## The checkpointer

`PostgresSaver` in schema `langgraph`, created by `setup()` on connect. Kernel code never
references those tables. A session with no database URL can be built on a `MemorySaver` instead,
which is what the tests do.

## Errors

Three fixed messages reach a surface, and nothing else:

- `the run exceeded its budget`
- `the run timed out`
- `the run failed; see the host log`

plus `cancelled` when the caller's signal aborts. The framework's and the gateway's own text goes
to the log.

## Running the tests

```bash
pnpm --filter @harness/runtime-deepagents test
```

Everything runs against the fake gateway and the in-process tool fixture from
`@harness/runtime-api/testing`; nothing reaches a vendor or the network. `src/index.test.ts` needs
Postgres at `TEST_DATABASE_URL` (`pnpm db:up`) and proves the checkpoint tables and a resume
across two turns on one thread.

The contract's own conformance kit runs against this runtime in `src/conformance.test.ts`:

```bash
pnpm --filter @harness/runtime-deepagents exec vitest run src/conformance.test.ts
```
