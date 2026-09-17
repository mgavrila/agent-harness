# Plan 8a: Runtime and host — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Own the loop. A `Runtime` contract with a scripted implementation and a conformance kit; a Deep Agents JS runtime that talks to LiteLLM and reaches tools only through an MCP client; kernel `threads` and `messages` tables; and one host process per client that resolves a principal per message, opens a run, hosts core-tools in-process, drives the runtime, streams the answer back, accepts approval decisions from principals of level `lead` and above, and resumes the thread when a decision executes. At the end of this plan the host serves approvals and chat on the memory surface end to end against Postgres, Compose runs it in place of the approvals service, and Hermes still serves Slack chat until Plan 8b retires it.

**Architecture:** Five moves. (1) **The runtime contract.** `@harness/runtime-api` declares `RunEvent`, `RunRequest`, `RunHandle`, `RuntimeSession`, `RuntimeDeps`, `Runtime`, `defineRuntime`; its `testing` subpath carries the OpenAI-wire fake gateway (moved from core-tools and taught streaming and tool calls), `ScriptedRuntime`, an in-process tool-server fixture and `runtimeConformance`. (2) **The Deep Agents runtime.** `runtimes/deepagents` builds one `createDeepAgent` per run over `ChatOpenAI` with `configuration.baseURL`, bridges the MCP client's tools into LangChain `tool()` definitions from their JSON schemas, seeds skills and memory as state files, restricts the built-in filesystem tools to four read-only ones, strips the `task` tool, checkpoints in Postgres schema `langgraph`, maps the `messages`/`updates` stream to `RunEvent`s, counts against the budget and aborts on the signal. (3) **Threads and messages.** Migration 0011 adds `threads`, `messages` with a generated `tsv`, `approvals.thread_id`, `runs.status`, a foreign key from `runs.thread_id`, and drops `runs.caller`. (4) **Decisions by principal.** The surface contract loses `allowedUsers` and gains `MessageEvent`, `onMessage`, `startStream`; the memory surface gains inbound; the approvals handlers resolve the presser through the identity plug-in and refuse a service or anyone below `lead`; execution runs on an in-process `CoreToolsClient` built on the approver's principal; the stdio client and `child-env.ts` go. (5) **The host.** `@harness/host` is the composition root: threads, the conversation flow callable from an adapter's `onMessage` and later from an HTTP route, one `ToolDeps` per run, skill stamping, the resume hook, the approvals loops, health, and Compose runs it.

**Tech Stack:** Node `>=22`, pnpm `11.4.0`, TypeScript 7 in every package (`typescript@6.0.3` at the workspace root only), zod v4 as `import * as z from 'zod/v4'`, drizzle-orm `^0.45.2` + drizzle-kit, `@modelcontextprotocol/server`/`client` v2, vitest 5, Postgres 16. New third-party dependencies, all in `runtimes/deepagents` and pinned exactly: `deepagents@1.13.4`, `langchain@1.5.11`, `@langchain/core@1.2.11`, `@langchain/langgraph@1.4.15`, `@langchain/openai@1.5.13`, `@langchain/langgraph-checkpoint-postgres@1.0.5`, `pg@^8.23.0`. `@langchain/mcp-adapters` is **not** used (decision 3). `yaml` (already in core-tools) is added to `harness/host`.

**Spec:** `docs/superpowers/specs/2026-09-17-kernel-design.md` — this plan and `2026-09-17-plan-8b-slack-and-cutover.md` together are the row "8 Runtime and host" of its section 10. This half implements section 4.2, the contract half of section 4.3 (with the memory surface as the first inbound adapter), section 5.3, section 5.4, migration 0011 of section 6, decisions 2, 8, 9, 16, 21, invariants 1, 2, 3, 4, 9, 10 and 12 of section 8, and the three items Plan 7 deferred: `allowedUsers` retired in favour of principal-resolved decisions, `runs.caller` dropped, and skill attribution restored. Plan 8b does the Slack adapter's inbound and streaming, retires Hermes, and swaps Compose to its final shape.

## Global Constraints

Every task's requirements implicitly include this section.

- Node `>=22`; pnpm `11.4.0`; TypeScript 7 (`^7.0.2`) in every package, `typescript@6.0.3` at the workspace root only for typescript-eslint and never changed; ESM only; zod v4 imported as `import * as z from 'zod/v4'`; vitest `^5.0.0`; drizzle-orm `^0.45.2`.
- **The four gates pass at the end of every task, at zero errors:** `pnpm -r typecheck`, `pnpm lint` (zero errors; the type-aware warnings are a known backlog), `pnpm arch` (zero violations: every rule is an error), `pnpm format:check`, and `pnpm test` (lint, then every package's suite; needs Postgres on `TEST_DATABASE_URL`, see `.env.example`; the suites run serially — `fileParallelism: false`). No task ends red and no gate is parked.
- **Migrations:** edit `harness/db/src/domain/schema.ts`, then from `harness/db/` run `pnpm drizzle-kit generate` twice — the second run must print "No schema changes". Never `--custom`. Task 4 is the one migration, `0011_threads_and_messages`.
- **Every new environment variable is documented in `.env.example` in the same commit** that first reads it: `harness/core-tools/src/app/surface.test.ts` scans the source for every name the code reads and fails on one the example file does not document. This plan adds `HARNESS_RUNTIME`, `HARNESS_HOST_PRINCIPAL`, `HARNESS_RUN_MAX_MODEL_CALLS`, `HARNESS_RUN_MAX_TOOL_CALLS`, `HARNESS_RUN_TIMEOUT_S` and `HARNESS_HISTORY_MAX_MESSAGES`; it removes `SLACK_ALLOWED_USERS` and `MEMORY_ALLOWED_USERS` (Task 5). The `APPROVALS_*` loop and health names are kept unchanged and read by the host (decision 18).
- **Every new package gets one `PACKAGES` row and one `WORKSPACE_DIRS` entry in `.dependency-cruiser.cjs`** plus the rules spec section 3.1 lists: Task 1 `runtime-api-imports-only-shared`; Task 3 `a-runtime-imports-only-api-and-shared` (a runtime never imports core-tools, db, a surface, a pack or the host — its tests included), `the-host-never-statically-imports-a-plugin` in Task 6 (from `harness/host/src`, no static edge into `surfaces/`, `identities/`, `runtimes/` or `packs/`; `*.test.ts` and `src/testing.ts` exempt). Task 3 also adds `runtimes/*` to `pnpm-workspace.yaml`, to the root `arch`/`arch:graph` globs and to `SOURCE_ROOTS` in `harness/core-tools/src/app/record-surface.ts`; Task 9 adds `COPY runtimes ./runtimes` to `node.Dockerfile`, the one image that installs the host. `docs/architecture/graph.svg` is regenerated with `pnpm arch:graph` in Task 10 only if `which dot` prints a path.
- **The tool-surface snapshot (`docs/architecture/tool-surface.json`) does not change in this plan**: no tool is added, removed or reshaped. **The compose snapshot (`docs/architecture/compose-surface.yaml`) changes in Task 9 only**, which re-records it with `pnpm surface:record` and describes the diff in the commit. Every other task leaves both files byte-identical.
- **Kernel vocabulary.** `harness/core-tools/src/kernel-vocabulary.test.ts` keeps its empty allowlist. `deepagents`, `langchain` and `langgraph` may appear only under `runtimes/deepagents/`; Task 3 adds `harness/runtime-api/src`, `harness/host/src` and `runtimes/deepagents/src` to the scans: the first two for framework vocabulary, all three for credentialing, messaging and deployment vocabulary (`hermes`, `demo-practice`). `provider` stays forbidden in kernel source, so the host and the runtime say "identity plug-in" and "runtime plug-in".
- **Commit messages: conventional prefix, imperative subject, and NO trailer of any kind.** No `Co-Authored-By`, no `Generated with`, nothing. This overrides any trailer guidance from the environment.
- **TDD in every task:** write the failing test first, run it and watch it fail, implement, run it green, run the gates, commit.
- **Deployability inside this plan.** Hermes keeps serving Slack chat at every commit. The approvals process is not runnable between Task 5 (which deletes `harness/approvals/src/app/main.ts`) and Task 8 (which adds `harness/host/src/app/main.ts`); Task 9 points Compose at the host. `docker compose build` still succeeds throughout (the image builds; only its command would fail), which is all CI runs. The branch merges as one pull request.
- **Never run `docker compose up`, `docker compose down`, `pnpm db:up` or `pnpm db:down` from a task.** `docker compose ... config` is read-only and is what the surface recorder uses.
- **Never source `.env` into the shell before running tests.**
- Test database: `postgres://harness:harness@localhost:15432/harness_test`. It exists; do not create or drop it. Task 4's migration test creates and drops `harness_test_migration_0011_<pid>` over that connection, as `migration-0010.test.ts` does. The runtime's checkpointer test creates schema `langgraph` in `harness_test` through `PostgresSaver.setup()` and leaves it: `resetDatabase` never touches it.
- Do not push from a task.

---

## Facts verified for this plan

Everything below was read out of the worktree at `.claude/worktrees/plan-8-runtime-host` (branch `worktree-plan-8-runtime-host`, on Plan 7 at `ce4a780`) or run in a scratch install on 2026-09-17. Quote the file, not memory. Plan 7 may still receive small fixes: every reference here is a file and a name, never a line number.

### The spike install

| Fact | Value | Where |
|---|---|---|
| Versions `pnpm add deepagents @langchain/langgraph @langchain/core langchain @langchain/openai @langchain/langgraph-checkpoint-postgres zod @langchain/mcp-adapters` resolved to | `deepagents 1.13.4`, `@langchain/langgraph 1.4.15`, `@langchain/core 1.2.11`, `langchain 1.5.11`, `@langchain/openai 1.5.13`, `@langchain/langgraph-checkpoint-postgres 1.0.5`, `@langchain/mcp-adapters 1.1.4`, `zod 4.6.5` | the scratch `package.json` and `pnpm list` |
| Every LangChain package peers on zod 4 | `zod@4.6.5` is the one zod in the tree; `deepagents` declares `zod ^4.3.6` | `pnpm list --depth 1` |
| `createDeepAgent` option names | `model?: BaseLanguageModel \| string`, `tools?`, `systemPrompt?: string \| SystemMessage \| SystemPromptConfig` (the structured form deprecated), `middleware?`, `subagents?`, `checkpointer?: BaseCheckpointSaver \| boolean`, `store?`, `backend?`, `interruptOn?`, `name?`, `memory?: string[]`, `skills?: string[]`, `permissions?: FilesystemPermission[]`, `stateSchema?`, `contextSchema?`, `responseFormat?`, `streamTransformers?` | `deepagents/dist/agent-*.d.ts`, `interface CreateDeepAgentParams` |
| Filesystem tools can be restricted to a read-only set | `createFilesystemMiddleware({ tools: ['read_file', 'ls', 'glob', 'grep'] })`; `read_file` must be in every explicit list; passing this middleware in `middleware:` replaced the built-in one (the wire carried one `read_file`, no `write_file`/`edit_file`/`delete`/`execute`) | `FilesystemMiddlewareOptions.tools`; spike run |
| The `task` subagent tool is published even with no subagents | tools on the wire: `records_search, ls, read_file, glob, grep, task` | spike run |
| …and a `wrapModelCall` middleware removes it | `createMiddleware({ name, wrapModelCall: (request, handler) => handler({ ...request, tools: request.tools.filter((t) => t.name !== 'task') }) })` from `langchain`; the wire then carried five tools | spike run |
| `ModelRequest` carries `model`, `messages`, `systemPrompt`, `systemMessage`, `tools`, `toolChoice?`, `state`; `langchain` exports `modelFallbackMiddleware(...fallbackModels: (string \| AgentLanguageModelLike)[])`, `modelCallLimitMiddleware`, `toolCallLimitMiddleware` and `createMiddleware` | the fallback is the built-in middleware; the budget counters are the runtime's own (they have to end the run with a fixed message) | `langchain/dist/agents/nodes/types.d.ts`, `dist/agents/middleware/modelFallback.d.ts`, `dist/index.d.ts` |
| `Runnable.withFallbacks` exists but returns `RunnableWithFallbacks`, which is not the `BaseLanguageModel` `createDeepAgent` takes as `model` | typed `withFallbacks(fields: { fallbacks: Runnable[] } \| Runnable[]): RunnableWithFallbacks` | `@langchain/core/dist/runnables/base.d.ts`; decision 4 |
| Backends | `StateBackend` (zero-arg constructor; files live in agent state and are checkpointed), `StoreBackend({ store, namespace })`, `CompositeBackend(defaultBackend, routes)`, `FilesystemBackend({ rootDir })` | `deepagents/dist/agent-*.d.ts` |
| Skills and memory over a `StateBackend` are seeded through the `files` input | `files: { '/skills/<name>/SKILL.md': { content: string[], created_at, modified_at }, '/memories/MEMORY.md': {...} }`; `skills: ['/skills/']`, `memory: ['/memories/MEMORY.md']`; the state kept both files after the run | `CreateDeepAgentParams.skills` docs; spike run (`STATE files [ '/skills/…', '/memories/MEMORY.md' ]`) |
| `FileData` v1 is `{ content: string[]; created_at: string; modified_at: string }` | | `interface FileDataV1` |
| Skills middleware puts the catalogue in the prompt and the body is read with `read_file` | the fake model's `read_file` on `/skills/credentialing-intake/SKILL.md` returned the file's numbered lines as a `ToolMessage` named `read_file` | spike run |
| `ChatOpenAI` takes the base URL and the user field | `configuration?: ClientOptions` (`baseURL?: string`), `user?: string`, `apiKey?`, `model`, `disableStreaming?` | `@langchain/openai/dist/chat_models/base.d.ts`; `openai/client.d.ts` |
| …and both reach the wire | every request carried `user: 'u-coordinator'`, `authorization: Bearer sk-test`, `stream: true`, `tools: […]` | spike run |
| Streaming | `agent.stream(input, { streamMode: ['messages', 'updates'], configurable: { thread_id }, signal, recursionLimit })` yields `[mode, payload]`; `messages` payloads are `[AIMessageChunk \| ToolMessage, { langgraph_node }]` — content deltas, `tool_call_chunks`, and a last chunk with `usage_metadata { input_tokens, output_tokens }`; `updates` payloads are `{ [nodeName]: stateDelta }` with `model_request` and `tools` keys, plus one per middleware `before_agent` | `StreamMode` in `@langchain/langgraph/dist/pregel/types.d.ts`; spike run |
| Cancel | `signal` in the stream config; aborting it made the stream throw `AbortError: This operation was aborted` with no further model call | `RunnableConfig.signal`; spike run |
| Two completions with the same `id` collapse | LangGraph's messages reducer replaces a message whose id matches; a fake that reused `chatcmpl-1` lost the second tool call silently. The fake gateway mints `chatcmpl-<n>` | spike run (matrix) |
| A `tool()` from a JSON schema is invoked with parsed arguments | `tool(async (input) => …, { name, description, schema: { type: 'object', properties, required } })`; invoked with `{ query: 'ada' }` under both streaming and non-streaming | `@langchain/core/dist/tools/index.d.ts` (the `JsonSchema7Type` overload); spike run |
| `@langchain/mcp-adapters` takes the v1 SDK client | `loadMcpTools(serverName, client: Client from '@modelcontextprotocol/sdk/client/index.js', options)` — our kernel hands a v2 `@modelcontextprotocol/client` `Client` | `@langchain/mcp-adapters/dist/tools.d.ts`; decision 3 |
| `ToolMessage.status` | `status?: 'success' \| 'error'` | `@langchain/core/dist/messages/tool.d.ts` |
| `PostgresSaver` | `PostgresSaver.fromConnString(url, { schema })`, `setup()`, `end()`, `deleteThread(threadId)`; `setup()` against `harness_test` created schema `langgraph` with `checkpoint_blobs`, `checkpoint_migrations`, `checkpoint_writes`, `checkpoints` | `@langchain/langgraph-checkpoint-postgres/dist/index.d.ts`; spike run |
| `MemorySaver` | exported from `@langchain/langgraph` | `@langchain/langgraph/dist/index.d.ts` |
| Summarisation | `createSummarizationMiddleware({ backend, trigger?, keep?, … })`; `createDeepAgent` wires it by default at `computeSummarizationDefaults(model)` | `deepagents/dist/agent-*.d.ts` |

### The repository

| Fact | Value | Where |
|---|---|---|
| The in-process MCP transport | `connectInProcess(factory: () => McpServer): Promise<{ client: Client; close }>` over `createMcpHandler` + `StreamableHTTPClientTransport` with a fetch shim | `harness/core-tools/src/domain/tooling/in-process.ts` |
| The per-run bag | `KernelConfig = Omit<ToolDeps, 'db' \| 'principal' \| 'context' \| 'sinks' \| 'tools' \| 'kernelTools' \| 'kernel'>`; `depsForRun(config, { db, principal, context })` | `harness/core-tools/src/domain/tooling/deps.ts` |
| `buildKernelConfig()` lives in the app layer and reads `process.env` | `app/server.ts`; `index.ts` never imports `app/` | `harness/core-tools/src/app/server.ts`, `.dependency-cruiser.cjs` |
| `RunContext` | `{ runId: string \| null; threadId: string \| null; surface: string \| null; conversation: string \| null; skill?; skillVersion?; tool? }`; `auditBaseFor` stamps `skill`/`skillVersion` from it | `domain/tooling/types.ts`, `context.ts` |
| `openRun(db, { client, principal, surface?, conversation?, threadId?, id? })` writes `caller` and `principal_id` | | `domain/session/repository.ts` |
| `createOrReuseApproval` writes `requestedBy: deps.principal.id` and no thread | | `domain/approvals/repository.ts` |
| `runs` has `caller NOT NULL`, `principal_id NOT NULL`, `thread_id uuid` (no FK), `surface`, `conversation`, `channel`, `started_at`, `ended_at`; no status | | `harness/db/src/domain/schema.ts` |
| `resetDatabase` truncates ten tables | `audit_log, tool_effects, model_calls, runs, approvals, deadlines, attachments, fields, documents, records` | `harness/db/src/testing.ts` |
| drizzle 0.45 pg-core has generated columns and index methods | `.generatedAlwaysAs(sql)` on a column builder; `index().using('gin', col)` | `drizzle-orm/pg-core/columns/common.d.ts`, `indexes.d.ts` |
| Migration 0010 is the last; its test replays the shipped SQL over a legacy DDL fixture in a scratch database | `migration-0010.test.ts`, `legacy-0009.test-helpers.ts`, `migration-sql.test-helpers.ts`, `scratch-database.test-helpers.ts` | `harness/db/src/domain/` |
| The fake gateway is a loopback `node:http` server answering `POST …/chat/completions` with JSON only | `FakeReply { content?, status?, errorBody?, inputTokens?, outputTokens?, costHeader?, modelName? }`, `FakeGatewayCall { model, messages, responseFormat, authorization }` | `harness/core-tools/src/domain/models/fake.ts` |
| Its importers | `core-tools/src/testing.ts` (re-export), `tools/documents.test.ts`, `app/dual-pack.test.ts`, `app/pack-healthcare/documents.test.ts`, `domain/models/gateway.test.ts`; the `./fake-gateway` subpath has no importer outside the package | grep |
| `hashArgs` canonicalises keys and sha256-hexes the JSON | | `domain/tooling/audit.ts` |
| The surface contract carries `allowedUsers` and the three helpers | `ANY_USER`, `allowsUser`, `parseAllowedUsers`; `SurfaceCapabilities { forms, privateReply, update }` | `harness/surface-api/src/surface.ts`, `types.ts` |
| `MemorySurface` records `cards`, `texts`, `privates`, `uploads`, `forms` and drives `press`/`submit` | | `harness/surface-api/src/testing.ts` |
| The Slack adapter reads four variables and declares four secrets | `APPROVALS_SLACK_BOT_TOKEN`, `APPROVALS_SLACK_APP_TOKEN`, `SLACK_APPROVALS_CHANNEL`, `SLACK_ALLOWED_USERS`; secrets add `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | `surfaces/slack/src/config.ts`, `index.ts` |
| The approvals handlers authorise with `allowsUser(session.allowedUsers, userId)` and decide with `decidedBy: event.userId` | `mayAct`, `decide` | `harness/approvals/src/domain/handlers.ts` |
| `decideApproval` executes through `deps.core.execute(row.id)` and replies with `threadReplyText(row, mention, execution)`; `decidedCard` mentions `{ user: row.decidedBy }` | | `domain/decisions.ts`, `domain/cards.ts` |
| `CoreToolsClient { execute(approvalId); reconcile(staleAfterMinutes); close() }`; the stdio client spawns `pnpm --filter @harness/core-tools start` with `coreToolsChildEnv` | | `domain/execute/types.ts`, `mcp-client.ts`, `app/child-env.ts` |
| The approvals `main.ts` composes `loadSurfaces`, `createMcpCoreToolsClient`, `surfaceSinks`, `registerApprovalHandlers`, `startRunner`, `startHealthServer` and reads `APPROVALS_POLL_SECONDS`, `EFFECTS_DISPATCH_SECONDS`, `RECONCILE_SECONDS`, `APPROVALS_HEALTH_PORT`, `APPROVALS_HEALTH_BIND` | | `harness/approvals/src/app/main.ts` |
| `loadIdentity(specifier, deps)` is exported by core-tools; `loadSurfaces(names, deps)` by approvals | | `harness/core-tools/src/index.ts`, `harness/approvals/src/index.ts` |
| `PackRegistry.skillsDirs()` is one directory per loaded pack; every skill is `<dir>/<name>/SKILL.md` with frontmatter `name`, `description`, `version` and nothing else in the folder | | `domain/packs/types.ts`; `packs/healthcare/skills/*` |
| `ROUTES` come from `@harness/gateway/routing`; the demo routes are `chat`, `extract`, `reason`, `judge` | | `harness/core-tools/src/domain/models/types.ts`; `clients/demo-practice/routing.yaml` |
| `GatewayConfig { baseUrl, apiKey, timeoutMs, maxCallsPerRun }` from `gatewayFromEnv()` | | `domain/models/gateway.ts` |
| The redaction guard | `containsRestrictedPattern(text)` at `@harness/core-tools/redaction`; `assertNoRestrictedPattern(text, what)` in `shared/redaction/patterns.ts` | those files |
| Compose today | services `postgres`, `litellm`, `files`, `core-tools` (build-only), `hermes-init`, `hermes`, `approvals` (image `harness-approvals`, `node.Dockerfile`, `CMD pnpm --filter @harness/approvals start`, ports `127.0.0.1:${APPROVALS_HEALTH_HOST_PORT:-8787}:8787`) | `harness/compose/docker-compose.yml`, `node.Dockerfile` |
| `surface.test.ts` pins the Compose shape | the files worker is reached by `hermes` and `approvals`; no socket; no client name; no forms dir | `harness/core-tools/src/app/surface.test.ts` |
| The Hermes watchdog scripts default to `http://approvals:8787/healthz` and read `APPROVALS_HEALTH_URL` | | `clients/demo-practice/scripts/*.sh` |
| The demo identity file declares `u-practice-manager` (admin), `u-coordinator` (lead), `svc-hermes`, `svc-approvals`, `svc-local` | | `clients/demo-practice/identity.yaml` |
| The kernel vocabulary scan is a list of `{ what, root, forbidden, minFiles, skip }` | `SCANNED` | `harness/core-tools/src/kernel-vocabulary.test.ts` |
| The env scan walks `harness, packs, surfaces, identities, evals, scripts` and recognises `seconds` and `port` wrappers | `SOURCE_ROOTS`, `ENV_READING_HELPERS` | `harness/core-tools/src/app/record-surface.ts` |
| `docker`, `dot` and Postgres on 15432 are available on the machine this plan was written on | | `which`; the checkpointer spike |

---

## Decisions where the spec leaves a detail open

1. **`RunRequest.principal` is a structural `RunPrincipal`, not `@harness/identity-api`'s `Principal`.** `runtime-api` may import only `@harness/shared` and zod (spec 3.1), and `Principal` lives in the identity contract. `RunPrincipal { id, kind, level, displayName }` is written out in `runtime-api` exactly as `PrincipalView` is in `pack-api`; a `Principal` is assignable to it, so the host passes the real one.

2. **`hashArgs` moves to `@harness/shared`.** Both the scripted runtime and the Deep Agents runtime emit `tool_call { argsHash }`, and neither may import core-tools. `harness/shared/src/hash.ts` gets the exact `canonicalize` + sha256-hex of `domain/tooling/audit.ts`; core-tools imports it from there and its `audit.test.ts` pins the digest, so no audit row changes.

3. **The tool bridge is ours, not `@langchain/mcp-adapters`.** The adapter takes the v1 SDK's `Client`; the kernel hands out a v2 `@modelcontextprotocol/client` `Client`. `runtimes/deepagents/src/domain/bridge.ts` maps `client.listTools()` to `tool(fn, { name, description, schema: inputSchema })` (the JSON-schema overload, verified) and `fn` to `client.callTool({ name, arguments })`. The bridge is also where `tool_call` and `tool_result` events are emitted and the tool-call budget is counted: it is the only place a kernel tool is invoked, so it is the only place that has to know.

4. **The fallback route is LangChain's `modelFallbackMiddleware`, not `withFallbacks`.** `withFallbacks` returns a `RunnableWithFallbacks`, which is not the `BaseLanguageModel` that `createDeepAgent({ model })` accepts. `langchain` exports `modelFallbackMiddleware(...fallbackModels)`, a `wrapModelCall` that retries the request with the next model on a thrown error; the runtime passes a second `ChatOpenAI` on `fallbackRoute`. The `task` tool is stripped by a `wrapModelCall` middleware of our own (`kernelToolFilter`), because `createDeepAgent` publishes it with no subagents declared.

5. **Skills and memory are seeded into agent state from the host's hand, and the runtime opens no filesystem backend.** Every run passes `files` with `/skills/<name>/SKILL.md` read from `request.skills[i].dir` and `/memories/MEMORY.md` from `request.memory`; the `StateBackend` is the default backend, the filesystem middleware is restricted to `read_file`, `ls`, `glob`, `grep`, and `permissions` denies every write. The model therefore reaches the four skill files and one memory file and nothing on disk (invariant 9). Re-seeding on every turn is what keeps an edited skill current and the memory snapshot frozen per run.

6. **`skill_activated` is a `read_file` under `/skills/`.** Progressive disclosure means a skill's body is read with the built-in tool; the runtime watches the `model_request` update for a `read_file` tool call whose `file_path` starts with `/skills/<name>/` and emits `skill_activated { name, version }` with the version the host supplied. It precedes the tool node, so it precedes the first kernel tool call the body causes. **The host stamps the context**: the runtime has no `ToolDeps`, so on that event `conversation.ts` sets `deps.context.skill` and `skillVersion` on the run's bag, which `auditBaseFor` reads from then on (Plan 7 deferral c).

7. **Continuity is the checkpointer's; `history` is the fallback.** The Deep Agents runtime keys the checkpointer on `request.threadId`; when `checkpointer.getTuple({ configurable: { thread_id } })` is undefined (a first turn, or a thread whose checkpoints were dropped) it prepends `request.history` as messages. `ScriptedRuntime` ignores history. The host trims `history` to `HARNESS_HISTORY_MAX_MESSAGES` (default 40) most recent rows and 24,000 characters, oldest dropped first.

8. **`done.text` is every text delta of the run joined.** A turn that narrates before calling a tool ("Looking that up.") and then answers is one reply; the host posts `done.text` once on a surface without streaming and streams the deltas on one that has it. Turn boundaries are joined with a blank line.

9. **A cancelled run ends with `error: 'cancelled'`; every other failure ends with a fixed message.** `RunEvent.error.message` reaches a surface, so it is never the framework's or the gateway's text (which quotes prompts). The runtime logs the full error through `deps.log` and emits `'the run failed; see the host log'`, or `'the run exceeded its budget'` when its own counters tripped. The host maps the first to `runs.status = 'cancelled'` when its own controller aborted, else `'error'`.

10. **Migration 0011 also adds `runs.status` and a foreign key.** Invariant 12 says a cancelled run "records `status: 'cancelled'`", and `runs` has no status column; 0011 adds `status text NOT NULL DEFAULT 'running'` (`running`, `done`, `error`, `cancelled`), `closeRun(db, runId, status)` sets it with `ended_at`, and `runs.thread_id` gains `REFERENCES threads(id)` now that the table exists. `runs.caller` is dropped in the same migration (Plan 7 deferral b): nothing reads it, `openRun` stops writing it, and the 0010 test keeps replaying the old shape.

11. **`threads` are keyed by `(client, surface, conversation, principal_id)` with `kind`.** A unique index on the four; `kind: 'chat' | 'playbook'`. Two people in one channel have two threads, which is what "each turn runs under the principal of the person who wrote it" needs. `messages (id, thread_id, run_id, role: 'user' | 'assistant' | 'host', principal_id, content, tsv GENERATED ALWAYS AS (to_tsvector('english', content)) STORED, created_at)` with a GIN index on `tsv`; `role = 'host'` is the resume notice.

12. **The group-chat rule is `mentioned`.** An adapter sets `mentioned: true` when the bot was addressed in a channel *and* for every direct message (a direct message is addressed by construction), so the host's whole rule is `if (!event.mentioned) return`. Plan 8b's Slack adapter follows it; the memory surface's `say` defaults it to true.

13. **`decided_by` becomes the principal id, and the card shows the display name.** `requested_by` is a principal id since Plan 7; a decision by a person is the same kind of fact. `DecisionInput.decidedBy: Principal`; `approvals.decided_by = principal.id`; `decidedCard(row, outcome)` takes `outcome.decidedByName` and renders `{ text: name }` in place of `{ user: id }`; `threadReplyText(row, who, execution)` takes the name. Invariant 3 is `mayAct` in `handlers.ts`: `identity.resolve({ surface: session.name, userId })` must answer a principal of `kind: 'user'` with `levelAtLeast(level, 'lead')`; a `service` principal is refused by kind (invariant 2), and the message is the same "You are not an approver for this workspace." in every refusal so an outsider learns nothing.

14. **Executing an approval opens a run for the approver.** `createInProcessCoreToolsClient({ db, config, client, servicePrincipal })` implements `CoreToolsClient`: `execute(approvalId, principal)` opens a run as that principal, builds `depsForRun`, connects `createCoreToolsServer` in-process, calls `approvals_execute`, closes the run; `reconcile` does the same as the host's service principal. One `ToolDeps` per run (decision 2 of the spec) and the execution's audit row carries the approver's principal id.

15. **The resume message.** After `decideApproval` records the decision and (for an approval) executes it, it calls `deps.onDecided?.({ row, decidedBy, execution })`. The host's `resume.ts` looks the thread up by `row.threadId` (null for an approval parked outside a thread, e.g. by the stdio server: nothing to resume) and runs one turn with `role: 'host'` and this exact text, as the thread's own principal:
   - approved and executed: `Approval <id> for <tool> was approved by <display name> and executed: delivery is queued in the effects outbox. Continue the workflow from here.`
   - approved, execution failed: `Approval <id> for <tool> was approved by <display name> but execution failed: <safe reason>. Nothing was sent.`
   - declined: `Approval <id> for <tool> was declined by <display name>. Nothing was sent.<" Note: …" when a note passed the redaction check>`
   The card's own thread reply on the approvals surface stays as it is; the resume is what makes the *conversation* continue.

16. **A `pending` tool result reaches the model as the kernel's own envelope.** The bridge returns the tool's text content verbatim, so the model reads `{"status":"pending","approval_id":"…"}` and SOUL rule 5 tells it what to say; the bridge emits `tool_result { status: 'pending' }` for the host's benefit only. Nothing posts on the model's behalf.

17. **The host's `KernelConfig` comes from `buildKernelConfig(env)` in core-tools' domain layer.** Today it lives in `app/server.ts`, which no other package may import. Task 6 moves `buildKernelConfig`, `formsDirFrom`, `packNames` and `parserFromEnv` to `domain/tooling/config.ts`, taking `env: EnvSource` explicitly (the domain layer may not read `process.env`; the two app entry points pass it), and exports `buildKernelConfig` from `index.ts`. `clientDirFor` and `resolvePrincipal` stay in `app/server.ts`.

18. **The host keeps the `APPROVALS_*` loop and health variable names.** They still name the approvals loops and the health endpoint; renaming would touch `.env.example`, Compose, the snapshot, the runbook and the watchdog scripts for no behaviour. The host's own new names are `HARNESS_RUNTIME`, `HARNESS_HOST_PRINCIPAL` (default `svc-host`, a service principal declared in `identity.yaml` that replaces `svc-approvals`), `HARNESS_RUN_MAX_MODEL_CALLS` (30), `HARNESS_RUN_MAX_TOOL_CALLS` (60), `HARNESS_RUN_TIMEOUT_S` (600) and `HARNESS_HISTORY_MAX_MESSAGES` (40).

19. **The host cancels through a registry, and the run API of Plan 10 will call it.** `Host.active: Map<runId, AbortController>`; `cancelRun(host, runId)` aborts it. Task 7's test cancels a `ScriptedRuntime` turn that is sleeping and asserts `runs.status = 'cancelled'` and that no assistant message was written.

20. **Invariant 10 is enforced on the row and on the final post.** `appendMessage` refuses to store a content that trips `containsRestrictedPattern` and stores `(withheld: it did not pass the redaction check)` in its place; the host posts the same marker instead of `done.text` when the text trips it. Streamed deltas are posted as they arrive: a streamed sentence cannot be recalled, the SOUL forbids the model from producing one, and the database is what the invariant's test reads.

21. **The Slack adapter compiles against the new contract in this plan and gets its inbound in Plan 8b.** Task 5 removes `SLACK_ALLOWED_USERS`, declares `streaming: false, inlineConfirm: false`, stores the `onMessage` handler on the transport's `SlackEvents` (which Bolt does not yet feed) and rejects `startStream` with a `SurfaceError`. Chat on Slack stays with Hermes until 8b.

22. **The fake gateway hangs on demand for the cancel test.** `FakeReply` may be a promise; `FakeGateway.close()` calls `server.closeAllConnections()` first so a hanging responder cannot keep the suite open.

23. **The conformance kit is parameterised by a harness the runtime package writes.** `runtimeConformance(name, harness)` registers the six rules of spec 4.2 as `it` blocks; the harness says how to make *this* runtime call one tool and answer (`script`), how to make it hang (`hang`), and what model requests it made (`modelRequests`, optional: a scripted runtime makes none). The kit owns the tool server, the `process.env` proxy and the event assertions.

---

## File structure

Paths are relative to the repository root. The workspace grows from sixteen packages to nineteen (`harness/runtime-api`, `runtimes/deepagents`, `harness/host`) and gains one top-level directory, `runtimes/`.

### `@harness/runtime-api` (Tasks 1–2)

| New / changed file | Responsibility |
|---|---|
| `harness/shared/src/hash.ts` + `hash.test.ts`, `index.ts` | `hashArgs`, `canonicalize` (moved from core-tools) |
| `harness/core-tools/src/domain/tooling/audit.ts` | imports `hashArgs` from shared |
| `harness/runtime-api/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md` | the package |
| `harness/runtime-api/src/types.ts` | the leaf: `RunEvent`, `RunPrincipal`, `RunRequest`, `RunHandle`, `RuntimeSession`, `RuntimeDeps`, `Runtime`, `RuntimeModule` |
| `harness/runtime-api/src/runtime.ts` + test | `defineRuntime` |
| `harness/runtime-api/src/gateway.ts` + `gateway.test.ts` | `startFakeGateway` (moved from core-tools; streaming, tool calls, `user`) |
| `harness/runtime-api/src/scripted.ts` + `scripted.test.ts` | `ScriptedRuntime`, `TrajectoryShape`, `parseTrajectory`, `readTrajectory` |
| `harness/runtime-api/src/tool-server.ts` | `toolServerFixture` (an in-process MCP server with declared tools) |
| `harness/runtime-api/src/conformance.ts` | `runtimeConformance`, `ConformanceHarness` |
| `harness/runtime-api/src/testing.ts`, `index.ts` | the `./testing` subpath and the public API |
| `harness/core-tools/src/domain/models/fake.ts` (deleted), `testing.ts`, `package.json` | re-export from `@harness/runtime-api/testing`; the `./fake-gateway` subpath goes |

### `runtimes/deepagents` (Task 3)

| New file | Responsibility |
|---|---|
| `runtimes/deepagents/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md` | the package `@harness/runtime-deepagents` |
| `src/domain/events.ts` | `EventQueue` — the async iterable the run pushes into |
| `src/domain/bridge.ts` + test | MCP tools → LangChain tools; emits `tool_call`/`tool_result`; counts tool calls |
| `src/domain/middleware.ts` + test | `kernelToolFilter`, `modelFallback` |
| `src/domain/prompt.ts` + test | `systemPrompt(persona)` = persona + the kernel rules block |
| `src/domain/files.ts` + test | `seedFiles(request)` — skills and memory as state files |
| `src/domain/checkpointer.ts` | `openCheckpointer(databaseUrl)` on schema `langgraph` |
| `src/domain/run.ts` + `run.test.ts` | `runDeepAgent(request, ctx)`: the agent, the stream mapping, the budget, the abort |
| `src/index.ts` + `index.test.ts`, `src/conformance.test.ts` | `runtime`, and the kit |
| `.dependency-cruiser.cjs`, `pnpm-workspace.yaml`, root `package.json`, `harness/core-tools/src/app/record-surface.ts`, `kernel-vocabulary.test.ts`, the four Dockerfiles | the new directory |

### Migration 0011 (Task 4)

`harness/db/src/domain/schema.ts` (`threads`, `messages`, `approvals.threadId`, `runs.status`, the FK, no `caller`), `harness/db/drizzle/0011_threads_and_messages.sql`, `meta/`, `legacy-0010.test-helpers.ts`, `migration-0011.test.ts`, `schema.test.ts`, `testing.ts`; `harness/core-tools/src/domain/session/repository.ts` (`closeRun`, no `caller`), `approvals/repository.ts` (`threadId`), `index.ts`.

### Decisions by principal (Task 5)

`harness/surface-api/src/types.ts`, `surface.ts`, `index.ts`, `testing.ts`, `surface.test.ts`, `memory.test.ts`; `surfaces/memory/src/index.ts` + test; `surfaces/slack/src/config.ts`, `session.ts`, `index.ts`, `testing.ts`, `transport/types.ts`, `bolt.ts`, `fake.ts`, `index.test.ts`, `session.test.ts`; `harness/approvals/src/domain/execute/types.ts`, `in-process.ts` (new), `mcp-client.ts` (deleted), `fake.ts`, `handlers.ts` + test, `decisions.ts` + test, `cards.ts` + test, `surfaces/dual-surface.test.ts`, `runner.test.ts`, `app/main.ts` (deleted), `app/child-env.ts` + test (deleted), `index.ts`, `testing.ts`, `package.json`; `.env.example`.

### `@harness/host` (Tasks 6–8)

| New file | Responsibility |
|---|---|
| `harness/host/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, `src/test-global-setup.ts` | the package |
| `harness/core-tools/src/domain/tooling/config.ts` + test | `buildKernelConfig(env)` and friends (moved) |
| `src/domain/runtime/registry.ts` + test | `loadRuntime(specifier, deps)` |
| `src/domain/threads/repository.ts` + test | `findOrCreateThread`, `appendMessage`, `recentHistory` |
| `src/domain/threads/trim.ts` + test | `trimHistory(rows, budget)` |
| `src/domain/skills.ts` + test | `readSkillCatalogue(dirs)` |
| `src/domain/persona.ts` + test | `readPersona(clientDir)` |
| `src/domain/kernel.ts` + test | `openKernel(host, run)` — one `ToolDeps` and one in-process MCP client per run |
| `src/domain/host.ts` | `Host`, `HostBudget` — the composed object every flow takes |
| `src/domain/conversation.ts` + test | `runTurn`, `handleMessage`, `cancelRun`, `attachMessageHandlers` |
| `src/domain/resume.ts` + test | `resumeOnDecision(host)` — the `onDecided` hook |
| `src/app/main.ts` | the composition root |
| `src/testing.ts` | `testKernelConfig`, `hostFixture` |
| `src/index.ts` | the public API (what Plan 10's run API imports) |

### Compose (Task 9) and docs (Task 10)

`harness/compose/docker-compose.yml`, `node.Dockerfile`, `docs/architecture/compose-surface.yaml`, `harness/core-tools/src/app/surface.test.ts`, `clients/demo-practice/identity.yaml`, `clients/demo-practice/scripts/*.sh`, root `package.json`; `ARCHITECTURE.md`, `CONTRIBUTING.md`, `README.md`, `docs/runbook.md`, `docs/demo.md`, the package READMEs, `docs/architecture/graph.svg`.

---

## Task order

Strictly sequential:

- **Task 1** (contract, `hashArgs`, the fake gateway) first: everything else types against it.
- **Task 2** (`ScriptedRuntime`, the kit) before Task 3: the Deep Agents package runs the kit.
- **Task 3** (the runtime) before Task 6: the host's `loadRuntime` test loads it by name.
- **Task 4** (migration 0011) before Task 5: `approvals.thread_id` is what Task 5's `DecidedOutcome` carries and Task 8 resumes on.
- **Task 5** (decisions by principal) before Task 6: the host registers the new handlers.
- **Tasks 6, 7, 8** build the host bottom-up: threads and the kernel per run, then the conversation flow, then the resume hook and the entrypoint.
- **Task 9** (Compose) after the entrypoint exists.
- **Task 10** (docs) last.

Tasks 1–8 and 10 leave both snapshots byte-identical.

---

## Tasks

### Task 1: `@harness/runtime-api` — the contract, `hashArgs` in shared, and the fake gateway that streams

The contract every runtime implements, the hash both runtimes stamp on a `tool_call`, and the
OpenAI-wire fake moved out of core-tools and taught what a chat loop needs: `stream: true`
answered as server-sent events, scripted tool calls, the `user` field and the tool list recorded
on every call, and a responder that may hang.

**Files:**
- Create: `harness/shared/src/hash.ts`, `harness/shared/src/hash.test.ts`
- Modify: `harness/shared/src/index.ts`, `harness/core-tools/src/domain/tooling/audit.ts`
- Create: `harness/runtime-api/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`
- Create: `harness/runtime-api/src/types.ts`, `runtime.ts`, `runtime.test.ts`, `gateway.ts`, `gateway.test.ts`, `testing.ts`, `index.ts`
- Delete: `harness/core-tools/src/domain/models/fake.ts`
- Modify: `harness/core-tools/src/testing.ts`, `harness/core-tools/package.json`, `harness/core-tools/src/domain/models/types.ts` (one comment)
- Modify: `.dependency-cruiser.cjs`

**Interfaces:**
- Consumes: `EnvSource`, `Logger`, `Level`, `ConfigError` from `@harness/shared`; `Client` from `@modelcontextprotocol/client`.
- Produces:

  ```ts
  // @harness/shared — hash.ts
  function canonicalize(value: unknown): unknown
  function hashArgs(args: unknown): string            // sha256 hex of canonical JSON; byte-identical to today's audit hash

  // @harness/runtime-api — types.ts
  type RunEvent =
    | { type: 'text'; delta: string }
    | { type: 'tool_call'; name: string; argsHash: string }
    | { type: 'tool_result'; name: string; status: 'ok' | 'pending' | 'error' }
    | { type: 'skill_activated'; name: string; version: string }
    | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number }
    | { type: 'done'; text: string }
    | { type: 'error'; message: string };
  interface RunPrincipal { readonly id: string; readonly kind: 'user' | 'service'; readonly level: Level; readonly displayName: string }
  interface RunAttachment { name: string; path: string }
  interface RunSkill { name: string; version: string; description: string; dir: string }
  interface RunHistoryTurn { role: 'user' | 'assistant' | 'host'; content: string }
  interface RunModel { baseUrl: string; apiKey: string; route: string; fallbackRoute?: string; user: string }
  interface RunBudget { maxModelCalls: number; maxToolCalls: number; timeoutMs: number }
  interface RunRequest {
    runId: string; threadId: string; principal: RunPrincipal;
    input: { text: string; attachments: readonly RunAttachment[] };
    history: readonly RunHistoryTurn[]; persona: string; skills: readonly RunSkill[]; memory: string;
    tools: Client; model: RunModel; budget: RunBudget; signal: AbortSignal;
  }
  interface RunHandle { events: AsyncIterable<RunEvent> }
  interface RuntimeSession { readonly name: string; run(request: RunRequest): RunHandle; stop(): Promise<void> }
  interface RuntimeDeps { env: EnvSource; log: Logger; databaseUrl: string; storageDir: string }
  interface Runtime { name: string; version: string; secrets: readonly string[]; connect(deps: RuntimeDeps): Promise<RuntimeSession> }
  interface RuntimeModule { runtime: Runtime }
  function defineRuntime(runtime: Runtime): Runtime

  // @harness/runtime-api/testing — gateway.ts
  interface FakeGatewayMessage { role: string; content: unknown; [key: string]: unknown }
  interface FakeGatewayCall { model: string; messages: FakeGatewayMessage[]; responseFormat: unknown; authorization: string | undefined; user: string | undefined; stream: boolean; tools: string[] }
  interface FakeToolCall { id?: string; name: string; arguments: Record<string, unknown> }
  interface FakeReply { content?: string; toolCalls?: FakeToolCall[]; status?: number; errorBody?: unknown; inputTokens?: number; outputTokens?: number; costHeader?: string; modelName?: string }
  type Responder = (call: FakeGatewayCall) => FakeReply | Promise<FakeReply>
  interface FakeGateway { url: string; calls: FakeGatewayCall[]; setResponder(r: Responder): void; close(): Promise<void> }
  function startFakeGateway(responder?: Responder): Promise<FakeGateway>
  ```

---

- [ ] **Step 1: Write the failing test for `hashArgs` in shared**

Create `harness/shared/src/hash.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canonicalize, hashArgs } from './hash.js';

describe('hashArgs', () => {
  it('does not depend on key order, at any depth', () => {
    expect(hashArgs({ a: 1, b: { c: 2, d: [3, { e: 4, f: 5 }] } })).toBe(
      hashArgs({ b: { d: [3, { f: 5, e: 4 }], c: 2 }, a: 1 }),
    );
  });

  it('is the sha256 hex of the canonical JSON, so the audit rows written before this move still match', () => {
    // sha256 of '{"a":1,"b":"x"}'
    expect(hashArgs({ b: 'x', a: 1 })).toBe('ecf9e98ec0641e23113ff3ce8bdc78d0ddd249886517fd4a7f68cc83d4e65667');
    expect(hashArgs(undefined)).toBe(hashArgs(null));
  });

  it('canonicalizes arrays element-wise and leaves scalars alone', () => {
    expect(canonicalize([{ b: 1, a: 2 }, 'x', null])).toEqual([{ a: 2, b: 1 }, 'x', null]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @harness/shared test`
Expected: FAIL — `Cannot find module './hash.js'`.

- [ ] **Step 3: Move the hash into shared and point core-tools at it**

Create `harness/shared/src/hash.ts`:

```ts
import { createHash } from 'node:crypto';

/** Recursively sort object keys so a hash does not depend on key order. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) sorted[key] = canonicalize(source[key]);
  return sorted;
}

/**
 * Stable fingerprint of a tool's arguments: the sha256 hex of the canonical JSON.
 *
 * Here rather than in core-tools because three writers stamp it — the kernel on every audit row,
 * and both runtimes on every `tool_call` event — and neither runtime may import the kernel. The
 * bytes are exactly what `domain/tooling/audit.ts` produced before the move, so an approval's
 * idempotency key and every existing `args_hash` still match.
 */
export function hashArgs(args: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(args ?? null)))
    .digest('hex');
}
```

Add to `harness/shared/src/index.ts`:

```ts
export { canonicalize, hashArgs } from './hash.js';
```

In `harness/core-tools/src/domain/tooling/audit.ts`, delete the local `canonicalize` and `hashArgs` and the `createHash` import, and add at the top:

```ts
import { hashArgs } from '@harness/shared';
export { hashArgs };
```

(`index.ts` re-exports `hashArgs` from `./domain/tooling/audit.js` already; that keeps working.)

- [ ] **Step 4: Run shared and core-tools' audit test green**

Run: `pnpm --filter @harness/shared test && pnpm --filter @harness/core-tools exec vitest run src/domain/tooling/audit.test.ts`
Expected: PASS, including `audit.test.ts`'s existing digest assertions.

- [ ] **Step 5: Write the failing test for `defineRuntime`**

Create `harness/runtime-api/src/runtime.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { defineRuntime, type Runtime } from './runtime.js';

const session = { name: 'x', run: () => ({ events: (async function* () {})() }), stop: async () => {} };
const base: Runtime = { name: 'scripted', version: '0.1.0', secrets: [], connect: async () => session };

describe('defineRuntime', () => {
  it('returns the declaration unchanged when it is well formed', () => {
    expect(defineRuntime(base)).toBe(base);
  });

  it('refuses a name that is not lowercase letters, digits and hyphens', () => {
    expect(() => defineRuntime({ ...base, name: 'Deep Agents' })).toThrow(ConfigError);
  });

  it('refuses an empty version and a secret that is not an environment variable name', () => {
    expect(() => defineRuntime({ ...base, version: ' ' })).toThrow(/no version/);
    expect(() => defineRuntime({ ...base, secrets: ['api-key'] })).toThrow(/environment variable name/);
    expect(() => defineRuntime({ ...base, secrets: ['A_KEY', 'A_KEY'] })).toThrow(/twice/);
  });
});
```

- [ ] **Step 6: Create the package and the contract**

Create `harness/runtime-api/package.json`:

```json
{
  "name": "@harness/runtime-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@harness/shared": "workspace:*",
    "@modelcontextprotocol/client": "^2.0.0",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@modelcontextprotocol/server": "^2.0.0",
    "@types/node": "^26.5.1",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

`tsconfig.json` and `vitest.config.ts` are copies of `harness/identity-api`'s. Create `harness/runtime-api/src/types.ts`:

```ts
import type { Client } from '@modelcontextprotocol/client';
import type { EnvSource, Level, Logger } from '@harness/shared';

/**
 * Every declaration of the runtime contract, in one leaf module. `runtime.ts`, `scripted.ts` and
 * `testing.ts` re-export from here and keep their own runtime functions, so no two modules of this
 * package can end up importing each other. It imports types from `@harness/shared` and the MCP
 * client, and nothing else.
 */

/** What the runtime learns as it runs. `error.message` is safe to post: never a payload value. */
export type RunEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; argsHash: string }
  | { type: 'tool_result'; name: string; status: 'ok' | 'pending' | 'error' }
  | { type: 'skill_activated'; name: string; version: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

/**
 * Who the run acts as, as much of it as a runtime needs. Structurally a subset of the identity
 * contract's `Principal`, written out here because this leaf may not import that one.
 */
export interface RunPrincipal {
  readonly id: string;
  readonly kind: 'user' | 'service';
  readonly level: Level;
  readonly displayName: string;
}

/** A file the human attached. `path` is relative to `<storageDir>/incoming`. */
export interface RunAttachment {
  name: string;
  path: string;
}

/** One skill the runtime may offer: `dir` holds `SKILL.md`. */
export interface RunSkill {
  name: string;
  version: string;
  description: string;
  dir: string;
}

export interface RunHistoryTurn {
  role: 'user' | 'assistant' | 'host';
  content: string;
}

/** How to reach the model gateway for this run. `user` is sent on every request for attribution. */
export interface RunModel {
  baseUrl: string;
  apiKey: string;
  route: string;
  fallbackRoute?: string;
  user: string;
}

export interface RunBudget {
  maxModelCalls: number;
  maxToolCalls: number;
  timeoutMs: number;
}

export interface RunRequest {
  runId: string;
  threadId: string;
  principal: RunPrincipal;
  /** The human's message, or a playbook's prompt, or the host's resume notice. */
  input: { text: string; attachments: readonly RunAttachment[] };
  /** Prior turns of this thread, newest last, already trimmed to the host's budget. */
  history: readonly RunHistoryTurn[];
  /** The persona text (SOUL.md). */
  persona: string;
  skills: readonly RunSkill[];
  /** The curated memory snapshot, frozen for this run. Empty until Plan 9 renders one. */
  memory: string;
  /** An MCP client already connected to a core-tools server built on this run's `ToolDeps`. */
  tools: Client;
  model: RunModel;
  budget: RunBudget;
  signal: AbortSignal;
}

export interface RunHandle {
  events: AsyncIterable<RunEvent>;
}

export interface RuntimeSession {
  readonly name: string;
  run(request: RunRequest): RunHandle;
  stop(): Promise<void>;
}

/** What a runtime is handed when it connects. `env` is the only environment it may read. */
export interface RuntimeDeps {
  env: EnvSource;
  log: Logger;
  databaseUrl: string;
  storageDir: string;
}

export interface Runtime {
  /** Lowercase, stable. */
  name: string;
  version: string;
  /** The environment variable names this runtime reads that are credentials. */
  secrets: readonly string[];
  connect(deps: RuntimeDeps): Promise<RuntimeSession>;
}

/** The module shape the host loads by name: `import(name)` resolves to `{ runtime }`. */
export interface RuntimeModule {
  runtime: Runtime;
}
```

Create `harness/runtime-api/src/runtime.ts`:

```ts
import { ConfigError } from '@harness/shared';
import type { Runtime } from './types.js';

export type {
  RunAttachment,
  RunBudget,
  RunEvent,
  RunHandle,
  RunHistoryTurn,
  RunModel,
  RunPrincipal,
  RunRequest,
  RunSkill,
  Runtime,
  RuntimeDeps,
  RuntimeModule,
  RuntimeSession,
} from './types.js';

const NAME = /^[a-z][a-z0-9-]*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** Declare a runtime plug-in: identity at runtime plus the checks that turn a typo into a startup failure. */
export function defineRuntime(runtime: Runtime): Runtime {
  if (!NAME.test(runtime.name)) {
    throw new ConfigError(`runtime plug-in name "${runtime.name}" must be lowercase letters, digits and hyphens`);
  }
  if (runtime.version.trim() === '') throw new ConfigError(`runtime plug-in "${runtime.name}" has no version`);
  const seen = new Set<string>();
  for (const secret of runtime.secrets) {
    if (!ENV_NAME.test(secret)) {
      throw new ConfigError(
        `runtime plug-in "${runtime.name}" secret "${secret}" must be an environment variable name (A-Z, digits, underscores)`,
      );
    }
    if (seen.has(secret)) throw new ConfigError(`runtime plug-in "${runtime.name}" lists secret "${secret}" twice`);
    seen.add(secret);
  }
  return runtime;
}
```

Create `harness/runtime-api/src/index.ts`:

```ts
/**
 * The contract between the host and a runtime plug-in: the loop that turns a message into tool
 * calls and an answer. It depends on `@harness/shared`, zod and the MCP client type, and on
 * nothing else in the workspace, so a runtime never has to depend on core-tools or the host.
 * See ARCHITECTURE.md, "The host and the runtime".
 */
export { LEVELS, USER_LEVELS, type Level } from '@harness/shared';
export { defineRuntime } from './runtime.js';
export type {
  RunAttachment,
  RunBudget,
  RunEvent,
  RunHandle,
  RunHistoryTurn,
  RunModel,
  RunPrincipal,
  RunRequest,
  RunSkill,
  Runtime,
  RuntimeDeps,
  RuntimeModule,
  RuntimeSession,
} from './types.js';
```

- [ ] **Step 7: Run the runtime test green**

Run: `pnpm install && pnpm --filter @harness/runtime-api test`
Expected: PASS (3 tests).

- [ ] **Step 8: Write the failing test for the moved fake gateway**

Create `harness/runtime-api/src/gateway.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeGateway, type FakeGateway } from './gateway.js';

let gateway: FakeGateway;
beforeEach(async () => {
  gateway = await startFakeGateway();
});
afterEach(async () => {
  await gateway.close();
});

const post = (body: Record<string, unknown>) =>
  fetch(`${gateway.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
    body: JSON.stringify({ model: 'chat', messages: [{ role: 'user', content: 'hi' }], ...body }),
  });

describe('startFakeGateway', () => {
  it('records the user field, the tool names and whether streaming was asked for', async () => {
    gateway.setResponder(() => ({ content: 'hello' }));
    const res = await post({ user: 'u-1', tools: [{ type: 'function', function: { name: 'records_search' } }] });
    expect(res.status).toBe(200);
    expect(gateway.calls[0]).toMatchObject({
      model: 'chat',
      user: 'u-1',
      stream: false,
      tools: ['records_search'],
      authorization: 'Bearer sk-test',
    });
    const body = (await res.json()) as { choices: { message: { content: string } }[]; usage: { prompt_tokens: number } };
    expect(body.choices[0].message.content).toBe('hello');
    expect(body.usage.prompt_tokens).toBe(11);
  });

  it('answers a scripted tool call in the non-streaming shape', async () => {
    gateway.setResponder(() => ({ toolCalls: [{ name: 'records_search', arguments: { query: 'ada' } }] }));
    const body = (await (await post({})).json()) as {
      choices: { finish_reason: string; message: { tool_calls: { id: string; function: { name: string; arguments: string } }[] } }[];
    };
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({
      id: 'call_1',
      function: { name: 'records_search', arguments: '{"query":"ada"}' },
    });
  });

  it('streams server-sent events with a unique completion id, the deltas and a final usage chunk', async () => {
    gateway.setResponder(() => ({ content: 'two words', inputTokens: 3, outputTokens: 2 }));
    const first = await post({ stream: true });
    expect(first.headers.get('content-type')).toBe('text/event-stream');
    const text = await first.text();
    const chunks = text
      .split('\n\n')
      .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map((line) => JSON.parse(line.slice('data: '.length)) as { id: string; choices: { delta: { content?: string } }[]; usage?: { prompt_tokens: number } });
    expect(chunks.map((c) => c.choices[0]?.delta.content).filter(Boolean).join('')).toBe('two words');
    expect(chunks.at(-1)?.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    const second = await (await post({ stream: true })).text();
    const idOf = (t: string) => (JSON.parse(t.split('\n\n')[0].slice('data: '.length)) as { id: string }).id;
    expect(idOf(second)).not.toBe(idOf(text));
  });

  it('streams a tool call as a name chunk, an arguments chunk and a tool_calls finish', async () => {
    gateway.setResponder(() => ({ toolCalls: [{ id: 'call_9', name: 'read_file', arguments: { file_path: '/skills/x/SKILL.md' } }] }));
    const text = await (await post({ stream: true })).text();
    expect(text).toContain('"name":"read_file"');
    expect(text).toContain('"arguments":"{\\"file_path\\":\\"/skills/x/SKILL.md\\"}"');
    expect(text).toContain('"finish_reason":"tool_calls"');
  });

  it('answers a non-2xx status with the error body', async () => {
    gateway.setResponder(() => ({ status: 503, errorBody: { error: { message: 'down' } } }));
    const res = await post({});
    expect(res.status).toBe(503);
  });

  it('closes while a responder is still hanging', async () => {
    gateway.setResponder(() => new Promise<never>(() => {}));
    const pending = post({}).catch(() => 'closed');
    await new Promise((r) => setTimeout(r, 20));
    await gateway.close();
    expect(await pending).toBe('closed');
    gateway = await startFakeGateway();
  });
});
```

- [ ] **Step 9: Run it and watch it fail**

Run: `pnpm --filter @harness/runtime-api test`
Expected: FAIL — `Cannot find module './gateway.js'`.

- [ ] **Step 10: Write the fake gateway**

Create `harness/runtime-api/src/gateway.ts` (the body of core-tools' `domain/models/fake.ts`, extended):

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeGatewayMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export interface FakeGatewayCall {
  model: string;
  messages: FakeGatewayMessage[];
  responseFormat: unknown;
  authorization: string | undefined;
  /** The attribution field a runtime must send on every request. */
  user: string | undefined;
  stream: boolean;
  /** The function names offered on this request. */
  tools: string[];
}

export interface FakeToolCall {
  /** Defaults to `call_<n>`, unique per gateway. */
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface FakeReply {
  /** The assistant message content. Defaults to `'ok'` when no tool call is scripted, else null. */
  content?: string;
  /** Tool calls the model "makes"; the finish reason becomes `tool_calls`. */
  toolCalls?: FakeToolCall[];
  /** Non-2xx to exercise the error path. Defaults to 200. */
  status?: number;
  errorBody?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  /** Value for the `x-litellm-response-cost` header. Omit to send no header. */
  costHeader?: string;
  /** Value for the response's `model` field. Defaults to the requested model. */
  modelName?: string;
}

export type Responder = (call: FakeGatewayCall) => FakeReply | Promise<FakeReply>;

export interface FakeGateway {
  url: string;
  calls: FakeGatewayCall[];
  setResponder(responder: Responder): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

interface RequestBody {
  model: string;
  messages: FakeGatewayMessage[];
  response_format?: unknown;
  user?: string;
  stream?: boolean;
  tools?: { function?: { name?: string } }[];
}

function usage(reply: FakeReply) {
  const prompt = reply.inputTokens ?? 11;
  const completion = reply.outputTokens ?? 7;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function toolCallsOf(reply: FakeReply, nextId: () => string) {
  return (reply.toolCalls ?? []).map((t) => ({
    id: t.id ?? nextId(),
    type: 'function' as const,
    function: { name: t.name, arguments: JSON.stringify(t.arguments) },
  }));
}

/** The two id sequences: one for completions, one for tool calls. Both unique per gateway. */
interface Ids {
  completion: () => string;
  call: () => string;
}

function writeJson(res: ServerResponse, body: RequestBody, reply: FakeReply, headers: Record<string, string>, ids: Ids): void {
  const toolCalls = toolCallsOf(reply, ids.call);
  res.writeHead(reply.status ?? 200, headers);
  res.end(
    JSON.stringify({
      id: ids.completion(),
      object: 'chat.completion',
      model: reply.modelName ?? body.model,
      choices: [
        {
          index: 0,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          message: {
            role: 'assistant',
            content: reply.content ?? (toolCalls.length > 0 ? null : 'ok'),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
        },
      ],
      usage: usage(reply),
    }),
  );
}

/**
 * The streaming shape: one chunk per word of content, or a name chunk and an arguments chunk per
 * tool call, then a finish chunk, then a usage chunk with no choices, then `[DONE]`. The id is
 * unique per completion: LangGraph's messages reducer replaces a message whose id it has already
 * seen, so a fake that reused one id would silently drop the second tool call of a run.
 */
function writeStream(res: ServerResponse, body: RequestBody, reply: FakeReply, headers: Record<string, string>, ids: Ids): void {
  const base = { id: ids.completion(), object: 'chat.completion.chunk', created: 1, model: reply.modelName ?? body.model };
  const chunks: unknown[] = [];
  const toolCalls = toolCallsOf(reply, ids.call);
  if (toolCalls.length > 0) {
    toolCalls.forEach((t, index) => {
      chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index, id: t.id, type: 'function', function: { name: t.function.name, arguments: '' } }] }, finish_reason: null }] });
      chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: t.function.arguments } }] }, finish_reason: null }] });
    });
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    const words = (reply.content ?? 'ok').split(' ');
    words.forEach((word, i) => {
      chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: i === words.length - 1 ? word : `${word} ` }, finish_reason: null }] });
    });
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  chunks.push({ ...base, choices: [], usage: usage(reply) });
  res.writeHead(reply.status ?? 200, { ...headers, 'content-type': 'text/event-stream' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * An OpenAI-compatible chat-completions endpoint on loopback, so a suite can exercise a model
 * caller without an API key or a network. It mimics LiteLLM closely enough to matter: the `usage`
 * block and the `x-litellm-response-cost` header are what core-tools' `callModel` reads, and the
 * streaming shape, the `user` field and the tool list are what a runtime is tested on.
 */
export async function startFakeGateway(responder: Responder = () => ({})): Promise<FakeGateway> {
  const calls: FakeGatewayCall[] = [];
  let respond = responder;
  let seq = 0;
  const nextId = (): string => {
    seq += 1;
    return `chatcmpl-${seq}`;
  };
  let callSeq = 0;
  const nextCallId = (): string => {
    callSeq += 1;
    return `call_${callSeq}`;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end('{}');
        return;
      }
      const body = JSON.parse(await readBody(req)) as RequestBody;
      const call: FakeGatewayCall = {
        model: body.model,
        messages: body.messages,
        responseFormat: body.response_format ?? null,
        authorization: req.headers.authorization,
        user: body.user,
        stream: body.stream === true,
        tools: (body.tools ?? []).map((t) => t.function?.name ?? '').filter((n) => n !== ''),
      };
      calls.push(call);

      const reply = await respond(call);
      if (reply.status && reply.status >= 400) {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.errorBody ?? { error: { message: 'boom', type: 'test_error' } }));
        return;
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (reply.costHeader !== undefined) headers['x-litellm-response-cost'] = reply.costHeader;
      const ids: Ids = { completion: nextId, call: nextCallId };
      if (call.stream) writeStream(res, body, reply, headers, ids);
      else writeJson(res, body, reply, headers, ids);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    setResponder(next) {
      respond = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // A responder that is still hanging (the cancel tests) holds a connection open; close
        // those first or `server.close` waits forever.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
```

- [ ] **Step 11: Run it green**

Run: `pnpm --filter @harness/runtime-api test`
Expected: PASS (9 tests).

- [ ] **Step 12: Point core-tools at the moved fake and delete its copy**

Create `harness/runtime-api/src/testing.ts`:

```ts
/** What a test of a runtime, or of the host, reaches for. `ScriptedRuntime` and the kit arrive in Task 2. */
export {
  startFakeGateway,
  type FakeGateway,
  type FakeGatewayCall,
  type FakeGatewayMessage,
  type FakeReply,
  type FakeToolCall,
  type Responder,
} from './gateway.js';
```

Delete `harness/core-tools/src/domain/models/fake.ts`. In `harness/core-tools/src/testing.ts` replace the last export block with:

```ts
/** The fake lives beside the contract whose wire shape it fakes; this is where kernel tests reach it. */
export {
  startFakeGateway,
  type FakeGateway,
  type FakeGatewayCall,
  type FakeReply,
  type Responder,
} from '@harness/runtime-api/testing';
```

In `harness/core-tools/package.json` remove the `"./fake-gateway"` export and add `"@harness/runtime-api": "workspace:*"` to `devDependencies`. In `harness/core-tools/src/domain/models/types.ts` change the comment sentence "`startFakeGateway` in `fake.ts` is the test double" to "`startFakeGateway` in `@harness/runtime-api/testing` is the test double". `gateway.test.ts` asserts `call.messages` and `call.responseFormat`, which keep their names and shapes.

- [ ] **Step 13: Register the package with dependency-cruiser**

In `.dependency-cruiser.cjs` add `{ name: 'runtime-api', src: 'harness/runtime-api/src', severity: 'error' }` after the `identity-api` row of `PACKAGES`, `'harness/runtime-api'` after `'harness/identity-api'` in `WORKSPACE_DIRS`, `runtime-api` to the second `collapsePattern` alternation, and this rule after `identity-api-imports-only-shared`:

```js
  {
    name: 'runtime-api-imports-only-shared',
    comment:
      '@harness/runtime-api is the contract a runtime plug-in implements. It may import @harness/shared, zod and the MCP client type, and no other workspace package: a contract that pulled in core-tools would defeat the point of having one, and one that pulled in @harness/identity-api would tie the loop to one way of knowing who is asking. RunPrincipal is written out here for exactly that reason.',
    severity: 'error',
    from: { path: '^harness/runtime-api/src/' },
    to: {
      path: '^(harness|packs|surfaces|identities|runtimes|evals|scripts)/',
      pathNot: ['^harness/runtime-api/src/', '^harness/shared/src/'],
    },
  },
```

Also add `runtimes` to the alternation `^(harness|packs|surfaces|identities|evals|scripts)/` in every other cross-package rule in the file (`pack-api-imports-only-shared`, `surface-api-imports-only-shared`, `identity-api-imports-only-shared`, `files-imports-only-shared`, `a-pack-never-imports-core-tools`, `a-surface-imports-only-api-and-shared`, `an-identity-plugin-imports-only-api-and-shared`, `shared-has-no-workspace-dependencies`), so a future edge into a runtime is caught by the same rules.

- [ ] **Step 14: Run the four gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green; both snapshots unchanged (`git status docs/architecture` is clean).

- [ ] **Step 15: Commit**

```bash
git add harness/shared harness/runtime-api harness/core-tools .dependency-cruiser.cjs pnpm-lock.yaml
git commit -m "feat(runtime-api): add the runtime contract, and a fake gateway that streams and scripts tool calls"
```

### Task 2: `ScriptedRuntime`, the tool-server fixture and the conformance kit

A runtime with no model: it replays a trajectory through `request.tools`, so the host and the
approvals bridge are tested against a real, loaded runtime. The conformance kit states the six
rules of spec 4.2 once and every runtime package runs it; the scripted runtime is its first
subject.

**Files:**
- Create: `harness/runtime-api/src/scripted.ts`, `scripted.test.ts`, `tool-server.ts`, `conformance.ts`
- Modify: `harness/runtime-api/src/testing.ts`, `README.md`

**Interfaces:**
- Consumes: the Task 1 contract; `hashArgs` from `@harness/shared`; `McpServer` from `@modelcontextprotocol/server` and `createMcpHandler`; `Client`, `StreamableHTTPClientTransport` from `@modelcontextprotocol/client`.
- Produces:

  ```ts
  // scripted.ts
  type TrajectoryStep =
    | { tool: string; args: Record<string, unknown> }
    | { say: string }
    | { skill: string; version: string }
    | { sleep: number };                                  // ms; ends early with error 'cancelled' on abort
  const TrajectoryShape: z.ZodType<TrajectoryStep[]>
  function parseTrajectory(raw: unknown): TrajectoryStep[]
  function readTrajectory(file: string): Promise<TrajectoryStep[]>       // JSON file
  type Trajectory = readonly TrajectoryStep[] | ((request: RunRequest) => readonly TrajectoryStep[])
  class ScriptedRuntime implements RuntimeSession {
    constructor(trajectory: Trajectory, name?: string)
    readonly requests: RunRequest[]                       // every request it was given, in order
    stopped: boolean
    run(request: RunRequest): RunHandle
    stop(): Promise<void>
  }
  function scriptedRuntime(trajectory: Trajectory): Runtime  // a Runtime whose connect() hands back a ScriptedRuntime

  // tool-server.ts
  interface FixtureTool { name: string; description: string; inputSchema: Record<string, unknown>; handler: (args: Record<string, unknown>) => Promise<unknown> | unknown }
  interface ToolServerFixture { client: Client; calls: { name: string; args: Record<string, unknown> }[]; close(): Promise<void> }
  function toolServerFixture(tools: readonly FixtureTool[]): Promise<ToolServerFixture>
  function fixtureRequest(over: Partial<RunRequest> & { tools: Client }): RunRequest   // a complete RunRequest with test defaults

  // conformance.ts
  interface ConformanceScript { toolCall: { name: string; args: Record<string, unknown> }; finalText: string; skill?: { name: string; version: string } }
  interface ConformanceHarness {
    connect(): Promise<RuntimeSession>;
    script(script: ConformanceScript): Promise<void> | void;   // make the next run do exactly this
    hang(): Promise<void> | void;                              // make the next run block until its signal aborts
    modelRequests?(): { user: string | undefined }[];          // since the last script()/hang(); omit for a runtime with no model
    skills?: readonly RunSkill[];                              // what `script.skill` needs on the request
  }
  function runtimeConformance(name: string, harness: ConformanceHarness): void   // registers describe/it blocks
  ```

---

- [ ] **Step 1: Write the failing test for the scripted runtime**

Create `harness/runtime-api/src/scripted.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashArgs } from '@harness/shared';
import type { RunEvent } from './types.js';
import { ScriptedRuntime, parseTrajectory, readTrajectory, scriptedRuntime } from './scripted.js';
import { fixtureRequest, toolServerFixture, type ToolServerFixture } from './tool-server.js';

let fixture: ToolServerFixture;
beforeEach(async () => {
  fixture = await toolServerFixture([
    {
      name: 'records_search',
      description: 'search',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      handler: ({ query }) => ({ status: 'ok', result: { hits: [String(query)] } }),
    },
    {
      name: 'forms_release',
      description: 'release',
      inputSchema: { type: 'object', properties: { file_id: { type: 'string' } } },
      handler: () => ({ status: 'pending', approval_id: '11111111-1111-4111-8111-111111111111' }),
    },
  ]);
});
afterEach(() => fixture.close());

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('ScriptedRuntime', () => {
  it('replays tool steps through request.tools and says the final text', async () => {
    const runtime = new ScriptedRuntime([
      { tool: 'records_search', args: { query: 'ada' } },
      { say: 'Found one.' },
    ]);
    const events = await collect(runtime.run(fixtureRequest({ tools: fixture.client })).events);
    expect(fixture.calls).toEqual([{ name: 'records_search', args: { query: 'ada' } }]);
    expect(events).toEqual([
      { type: 'tool_call', name: 'records_search', argsHash: hashArgs({ query: 'ada' }) },
      { type: 'tool_result', name: 'records_search', status: 'ok' },
      { type: 'text', delta: 'Found one.' },
      { type: 'done', text: 'Found one.' },
    ]);
    expect(runtime.requests).toHaveLength(1);
  });

  it('reports a parked tool as pending and a skill activation before the tool it causes', async () => {
    const runtime = new ScriptedRuntime([
      { skill: 'credentialing-roster', version: '1.0.0' },
      { tool: 'forms_release', args: { file_id: 'roster/x.csv' } },
      { say: 'Waiting for approval.' },
    ]);
    const events = await collect(runtime.run(fixtureRequest({ tools: fixture.client })).events);
    expect(events.map((e) => e.type)).toEqual(['skill_activated', 'tool_call', 'tool_result', 'text', 'done']);
    expect(events[2]).toEqual({ type: 'tool_result', name: 'forms_release', status: 'pending' });
  });

  it('reports a tool the server does not have as an error result and keeps going', async () => {
    const runtime = new ScriptedRuntime([{ tool: 'no_such_tool', args: {} }, { say: 'x' }]);
    const events = await collect(runtime.run(fixtureRequest({ tools: fixture.client })).events);
    expect(events[1]).toEqual({ type: 'tool_result', name: 'no_such_tool', status: 'error' });
    expect(events.at(-1)).toEqual({ type: 'done', text: 'x' });
  });

  it('ends with error "cancelled" when the signal aborts during a sleep, and says nothing more', async () => {
    const runtime = new ScriptedRuntime([{ sleep: 10_000 }, { say: 'never' }]);
    const controller = new AbortController();
    const handle = runtime.run(fixtureRequest({ tools: fixture.client, signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    expect(await collect(handle.events)).toEqual([{ type: 'error', message: 'cancelled' }]);
  });

  it('takes a trajectory chosen per request', async () => {
    const runtime = new ScriptedRuntime((request) => [{ say: `echo: ${request.input.text}` }]);
    const events = await collect(runtime.run(fixtureRequest({ tools: fixture.client, input: { text: 'hi', attachments: [] } })).events);
    expect(events.at(-1)).toEqual({ type: 'done', text: 'echo: hi' });
  });
});

describe('trajectory files', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'harness-trajectory-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('parses the four step shapes and refuses anything else', async () => {
    const file = path.join(dir, 't.json');
    await writeFile(file, JSON.stringify([{ tool: 'a', args: {} }, { say: 'b' }, { skill: 'c', version: '1' }, { sleep: 5 }]));
    expect(await readTrajectory(file)).toHaveLength(4);
    expect(() => parseTrajectory([{ shout: 'x' }])).toThrow(/trajectory/);
  });

  it('is a Runtime the host can load and connect', async () => {
    const runtime = scriptedRuntime([{ say: 'hello' }]);
    expect(runtime.name).toBe('scripted');
    const session = await runtime.connect({ env: {}, log: { info() {}, warn() {}, error() {} }, databaseUrl: '', storageDir: dir });
    expect(session).toBeInstanceOf(ScriptedRuntime);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @harness/runtime-api test`
Expected: FAIL — `Cannot find module './scripted.js'`.

- [ ] **Step 3: Write the tool-server fixture**

Create `harness/runtime-api/src/tool-server.ts`:

```ts
import * as z from 'zod/v4';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { RunRequest } from './types.js';

/** One tool an in-process fixture server publishes, declared with the JSON schema a client would see. */
export interface FixtureTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface ToolServerFixture {
  client: Client;
  /** Every call the server received, in order. What "reaches tools only through request.tools" is asserted on. */
  calls: { name: string; args: Record<string, unknown> }[];
  close(): Promise<void>;
}

/**
 * An MCP server with exactly these tools, connected in-process to a client, with no socket. The
 * same transport `@harness/core-tools`' `connectInProcess` uses, written again here because this
 * package may not import the kernel and the kit has to hand a runtime a real `Client`.
 *
 * A handler's return value is the tool's text content, JSON-encoded, and — when it is an object
 * with a `status` — its structured content too, so the kernel's `{ status: 'pending', approval_id }`
 * envelope can be scripted exactly. A handler that throws becomes an `isError` result carrying the
 * message, which is what the kernel does for a `ToolError`.
 */
export async function toolServerFixture(tools: readonly FixtureTool[]): Promise<ToolServerFixture> {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'fixture', version: '0.0.0' });
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        // `registerTool` takes a standard schema (the kernel passes a zod object); zod v4 builds one
        // from the JSON schema the fixture declares, which is the shape a real client would list.
        { description: tool.description, inputSchema: z.fromJSONSchema(tool.inputSchema as z.core.JSONSchema.JSONSchema) },
        async (args: Record<string, unknown>) => {
          calls.push({ name: tool.name, args });
          try {
            const out = await tool.handler(args);
            const structured = out !== null && typeof out === 'object' ? (out as Record<string, unknown>) : undefined;
            return { content: [{ type: 'text' as const, text: JSON.stringify(out) }], isError: false, structuredContent: structured };
          } catch (err) {
            return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
          }
        },
      );
    }
    return server;
  });
  const transport = new StreamableHTTPClientTransport(new URL('http://fixture.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'fixture-client', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return {
    client,
    calls,
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
}

/** A complete request with test defaults; `tools` is the one thing every test has to supply. */
export function fixtureRequest(over: Partial<RunRequest> & { tools: Client }): RunRequest {
  return {
    runId: '22222222-2222-4222-8222-222222222222',
    threadId: '33333333-3333-4333-8333-333333333333',
    principal: { id: 'u-test', kind: 'user', level: 'practitioner', displayName: 'Test user' },
    input: { text: 'hello', attachments: [] },
    history: [],
    persona: 'You are the test assistant.',
    skills: [],
    memory: '',
    model: { baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-test', route: 'chat', user: 'u-test' },
    budget: { maxModelCalls: 10, maxToolCalls: 10, timeoutMs: 30_000 },
    signal: new AbortController().signal,
    ...over,
  };
}
```

- [ ] **Step 4: Write the scripted runtime**

Create `harness/runtime-api/src/scripted.ts`:

```ts
import { readFile } from 'node:fs/promises';
import * as z from 'zod/v4';
import { ConfigError, hashArgs } from '@harness/shared';
import { defineRuntime } from './runtime.js';
import type { RunEvent, RunHandle, RunRequest, Runtime, RuntimeSession } from './types.js';

const StepShape = z.union([
  z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ say: z.string() }).strict(),
  z.object({ skill: z.string().min(1), version: z.string().min(1) }).strict(),
  z.object({ sleep: z.number().int().min(0) }).strict(),
]);
export const TrajectoryShape = z.array(StepShape);
export type TrajectoryStep = z.infer<typeof StepShape>;
export type Trajectory = readonly TrajectoryStep[] | ((request: RunRequest) => readonly TrajectoryStep[]);

export function parseTrajectory(raw: unknown): TrajectoryStep[] {
  const parsed = TrajectoryShape.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`trajectory is invalid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export async function readTrajectory(file: string): Promise<TrajectoryStep[]> {
  return parseTrajectory(JSON.parse(await readFile(file, 'utf8')));
}

/** The status the kernel's envelope carries, read off a tool result the way the host reads it. */
function statusOf(res: { isError?: boolean; structuredContent?: unknown }): 'ok' | 'pending' | 'error' {
  if (res.isError) return 'error';
  const status = (res.structuredContent as { status?: unknown } | undefined)?.status;
  return status === 'pending' ? 'pending' : 'ok';
}

function sleepUntil(ms: number, signal: AbortSignal): Promise<'slept' | 'aborted'> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve('aborted');
    const timer = setTimeout(() => resolve('slept'), ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve('aborted');
    }, { once: true });
  });
}

/**
 * A runtime that replays a trajectory instead of asking a model.
 *
 * Every `tool` step goes through `request.tools`, exactly as a real runtime's calls do, so the
 * host, the approvals bridge and the scheduler are tested against a loaded runtime whose tool
 * calls pass policy, audit and the outbox. `say` steps become text deltas and the joined `done`
 * text; a `skill` step is the activation event a real runtime emits when it reads a skill body; a
 * `sleep` step holds the run open so a cancel can be tested.
 */
export class ScriptedRuntime implements RuntimeSession {
  readonly name: string;
  readonly requests: RunRequest[] = [];
  stopped = false;

  private readonly trajectory: Trajectory;

  constructor(trajectory: Trajectory, name = 'scripted') {
    this.trajectory = trajectory;
    this.name = name;
  }

  run(request: RunRequest): RunHandle {
    this.requests.push(request);
    const steps = typeof this.trajectory === 'function' ? this.trajectory(request) : this.trajectory;
    const events = async function* (): AsyncGenerator<RunEvent> {
      const said: string[] = [];
      for (const step of steps) {
        if (request.signal.aborted) {
          yield { type: 'error', message: 'cancelled' };
          return;
        }
        if ('tool' in step) {
          yield { type: 'tool_call', name: step.tool, argsHash: hashArgs(step.args) };
          let status: 'ok' | 'pending' | 'error';
          try {
            status = statusOf(await request.tools.callTool({ name: step.tool, arguments: step.args }));
          } catch {
            status = 'error';
          }
          yield { type: 'tool_result', name: step.tool, status };
        } else if ('say' in step) {
          said.push(step.say);
          yield { type: 'text', delta: step.say };
        } else if ('skill' in step) {
          yield { type: 'skill_activated', name: step.skill, version: step.version };
        } else if ((await sleepUntil(step.sleep, request.signal)) === 'aborted') {
          yield { type: 'error', message: 'cancelled' };
          return;
        }
      }
      yield { type: 'done', text: said.join('\n\n') };
    };
    return { events: events() };
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

/** A `Runtime` whose sessions replay `trajectory`: what a host test loads in place of a model-backed runtime. */
export function scriptedRuntime(trajectory: Trajectory): Runtime {
  return defineRuntime({
    name: 'scripted',
    version: '0.1.0',
    secrets: [],
    connect: async () => new ScriptedRuntime(trajectory),
  });
}
```

- [ ] **Step 5: Run the scripted tests green**

Run: `pnpm --filter @harness/runtime-api test`
Expected: PASS.

- [ ] **Step 6: Write the conformance kit and run the scripted runtime through it**

Create `harness/runtime-api/src/conformance.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunEvent, RunRequest, RunSkill, RuntimeSession } from './types.js';
import { fixtureRequest, toolServerFixture, type ToolServerFixture } from './tool-server.js';

export interface ConformanceScript {
  toolCall: { name: string; args: Record<string, unknown> };
  finalText: string;
  /** When set, the run activates this skill before its tool call; `harness.skills` must list it. */
  skill?: { name: string; version: string };
}

/**
 * What a runtime package tells the kit about itself. The kit knows the contract; the harness knows
 * how to make this runtime do one thing — a scripted runtime by its trajectory, a model-backed one
 * by scripting the fake gateway.
 */
export interface ConformanceHarness {
  connect(): Promise<RuntimeSession>;
  script(script: ConformanceScript): Promise<void> | void;
  hang(): Promise<void> | void;
  modelRequests?(): { user: string | undefined }[];
  skills?: readonly RunSkill[];
}

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/**
 * The six rules of spec 4.2, as tests every runtime package registers with its own harness:
 * tools only through `request.tools`; no `process.env`; exactly one `done` or `error`; stops
 * within one model call of the signal aborting; `skill_activated` before the first tool call a
 * skill causes; `request.model.user` on every model request.
 */
export function runtimeConformance(name: string, harness: ConformanceHarness): void {
  describe(`runtime conformance: ${name}`, () => {
    let fixture: ToolServerFixture;
    let session: RuntimeSession;
    beforeEach(async () => {
      fixture = await toolServerFixture([
        {
          name: 'records_search',
          description: 'search',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          handler: ({ query }) => ({ status: 'ok', result: { hits: [String(query)] } }),
        },
      ]);
      session = await harness.connect();
    });
    afterEach(async () => {
      await session.stop();
      await fixture.close();
    });

    const request = (over: Partial<RunRequest> = {}): RunRequest =>
      fixtureRequest({ tools: fixture.client, skills: harness.skills ?? [], ...over });

    it('calls tools only through request.tools, and reports each call once', async () => {
      await harness.script({ toolCall: { name: 'records_search', args: { query: 'ada' } }, finalText: 'done' });
      const events = await collect(session.run(request()).events);
      expect(fixture.calls).toEqual([{ name: 'records_search', args: { query: 'ada' } }]);
      expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'tool_result')).toEqual([{ type: 'tool_result', name: 'records_search', status: 'ok' }]);
    });

    it('reads none of the harness variables off process.env during a run', async () => {
      // The model SDKs read their own defaults (OPENAI_BASE_URL, tracing switches) off the
      // environment; the rule is about the runtime's *configuration*, which arrives on the
      // request and on `RuntimeDeps.env`, never off the ambient environment.
      const OURS = /^(HARNESS_|LITELLM_|DATABASE_URL$|APPROVALS_|SLACK_)/;
      await harness.script({ toolCall: { name: 'records_search', args: { query: 'x' } }, finalText: 'done' });
      const real = process.env;
      const reads: string[] = [];
      process.env = new Proxy(real, {
        get(target, key) {
          if (typeof key === 'string' && OURS.test(key)) reads.push(key);
          return Reflect.get(target, key) as string | undefined;
        },
      });
      try {
        await collect(session.run(request()).events);
      } finally {
        process.env = real;
      }
      expect(reads).toEqual([]);
    });

    it('emits exactly one done or error, and done carries the final text', async () => {
      await harness.script({ toolCall: { name: 'records_search', args: { query: 'x' } }, finalText: 'All done.' });
      const events = await collect(session.run(request()).events);
      const terminal = events.filter((e) => e.type === 'done' || e.type === 'error');
      expect(terminal).toEqual([{ type: 'done', text: expect.stringContaining('All done.') as string }]);
      expect(events.at(-1)).toBe(terminal[0]);
    });

    it('stops within one model call of the signal aborting, with a single error event', async () => {
      await harness.hang();
      const controller = new AbortController();
      const handle = session.run(request({ signal: controller.signal }));
      const iterator = handle.events[Symbol.asyncIterator]();
      const first = iterator.next();
      setTimeout(() => controller.abort(), 50);
      const events: RunEvent[] = [];
      let result = await first;
      while (!result.done) {
        events.push(result.value);
        result = await iterator.next();
      }
      expect(events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', message: 'cancelled' }]);
      expect(events.some((e) => e.type === 'done')).toBe(false);
      if (harness.modelRequests) expect(harness.modelRequests().length).toBeLessThanOrEqual(1);
    });

    it('announces a skill before the first tool call its body causes', async () => {
      if (!harness.skills?.length) return;
      const skill = harness.skills[0];
      await harness.script({
        toolCall: { name: 'records_search', args: { query: 'x' } },
        finalText: 'done',
        skill: { name: skill.name, version: skill.version },
      });
      const events = await collect(session.run(request()).events);
      const activated = events.findIndex((e) => e.type === 'skill_activated');
      const firstCall = events.findIndex((e) => e.type === 'tool_call');
      expect(activated).toBeGreaterThanOrEqual(0);
      expect(activated).toBeLessThan(firstCall);
      expect(events[activated]).toEqual({ type: 'skill_activated', name: skill.name, version: skill.version });
    });

    it('sends request.model.user on every model request', async () => {
      if (!harness.modelRequests) return;
      await harness.script({ toolCall: { name: 'records_search', args: { query: 'x' } }, finalText: 'done' });
      await collect(session.run(request({ model: { baseUrl: 'unused', apiKey: 'sk', route: 'chat', user: 'u-conformance' } })).events);
      const requests = harness.modelRequests();
      expect(requests.length).toBeGreaterThan(0);
      for (const r of requests) expect(r.user).toBe('u-conformance');
    });
  });
}
```

Note: the `model.baseUrl` in the last test is whatever the harness's `connect()` decided to ignore or honour; the Deep Agents harness in Task 3 overrides `request.model.baseUrl` with its fake gateway's URL inside `connect()`'s session wrapper, so the kit stays runtime-agnostic. Add the scripted runtime's own conformance run to the bottom of `scripted.test.ts`:

```ts
import { runtimeConformance } from './conformance.js';

runtimeConformance('scripted', {
  connect: async () => new ScriptedRuntime(() => steps),
  script: (s) => {
    steps = [
      ...(s.skill ? [{ skill: s.skill.name, version: s.skill.version } as const] : []),
      { tool: s.toolCall.name, args: s.toolCall.args },
      { say: s.finalText },
    ];
  },
  hang: () => {
    steps = [{ sleep: 60_000 }, { say: 'never' }];
  },
  skills: [{ name: 'credentialing-roster', version: '1.0.0', description: 'roster', dir: '/nonexistent' }],
});
```

with `let steps: TrajectoryStep[] = [];` declared above it (import `TrajectoryStep` from `./scripted.js`). Put the two imports at the top of the file with the others.

- [ ] **Step 7: Export from the testing subpath and run green**

Extend `harness/runtime-api/src/testing.ts`:

```ts
export { ScriptedRuntime, TrajectoryShape, parseTrajectory, readTrajectory, scriptedRuntime, type Trajectory, type TrajectoryStep } from './scripted.js';
export { fixtureRequest, toolServerFixture, type FixtureTool, type ToolServerFixture } from './tool-server.js';
export { runtimeConformance, type ConformanceHarness, type ConformanceScript } from './conformance.js';
```

`conformance.ts` imports from `vitest`, so `vitest` must be a **dependency** of `@harness/runtime-api`'s testing subpath the way it is a devDependency elsewhere; keep it in `devDependencies` (every consumer of `./testing` is itself a test with vitest installed) and add `"vitest"` under `"peerDependenciesMeta"` only if `pnpm` warns.

Run: `pnpm --filter @harness/runtime-api test`
Expected: PASS — the scripted suite plus six conformance cases (the `modelRequests` case returns early for the scripted runtime).

- [ ] **Step 8: Write the README, run the gates, commit**

Create `harness/runtime-api/README.md` describing the contract (the `RunRequest` fields, the seven events, the six rules), the `testing` subpath (`startFakeGateway`, `ScriptedRuntime`, `toolServerFixture`, `runtimeConformance`) and the dependency rule, in the style of `harness/identity-api/README.md`.

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green; snapshots unchanged.

```bash
git add harness/runtime-api
git commit -m "feat(runtime-api): add ScriptedRuntime, the in-process tool fixture and the runtime conformance kit"
```

### Task 3: `runtimes/deepagents` — the Deep Agents JS runtime

The first real runtime. One `createDeepAgent` per run over `ChatOpenAI` pointed at LiteLLM; the
kernel's tools bridged from the MCP client; skills and memory seeded as state files; the
built-in filesystem tools cut to four read-only ones and the `task` tool stripped; the
checkpointer in Postgres schema `langgraph`; the `messages` and `updates` stream mapped to
`RunEvent`s; the budget counted; the signal honoured. Tested end to end against the fake gateway
and the tool fixture, then run through the conformance kit.

**Files:**
- Create: `runtimes/deepagents/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, `src/test-global-setup.ts`
- Create: `runtimes/deepagents/src/domain/events.ts`, `bridge.ts`, `bridge.test.ts`, `middleware.ts`, `middleware.test.ts`, `prompt.ts`, `prompt.test.ts`, `files.ts`, `files.test.ts`, `checkpointer.ts`, `run.ts`, `run.test.ts`
- Create: `runtimes/deepagents/src/index.ts`, `index.test.ts`, `conformance.test.ts`
- Modify: `pnpm-workspace.yaml`, root `package.json` (`arch`, `arch:graph` globs), `.dependency-cruiser.cjs`, `harness/core-tools/src/app/record-surface.ts` (`SOURCE_ROOTS`), `harness/core-tools/src/kernel-vocabulary.test.ts`

**Interfaces:**
- Consumes: the whole of `@harness/runtime-api` and its `testing` subpath; `hashArgs`, `createLogger`, `describeError` from `@harness/shared`; `createDeepAgent`, `createFilesystemMiddleware` from `deepagents`; `ChatOpenAI` from `@langchain/openai`; `tool` from `@langchain/core/tools`; `AIMessage`, `AIMessageChunk`, `HumanMessage`, `BaseMessage` from `@langchain/core/messages`; `createMiddleware`, `modelFallbackMiddleware` from `langchain`; `PostgresSaver` from `@langchain/langgraph-checkpoint-postgres`; `MemorySaver`, `BaseCheckpointSaver` from `@langchain/langgraph`.
- Produces:

  ```ts
  // events.ts
  class EventQueue<T> implements AsyncIterable<T> { push(item: T): void; close(): void }

  // bridge.ts
  interface BridgeSink { emit(event: RunEvent): void; maxToolCalls: number; onBudgetExceeded(): void }
  function bridgeTools(client: Client, sink: BridgeSink): Promise<StructuredToolInterface[]>
  function textOf(res: { content?: unknown }): string

  // middleware.ts
  const READ_ONLY_FS_TOOLS: readonly ['read_file', 'ls', 'glob', 'grep']
  const DENY_ALL_WRITES: FilesystemPermission[]
  function kernelToolFilter(): AgentMiddleware           // strips `task`
  function chatModel(model: RunModel, route: string): ChatOpenAI

  // prompt.ts
  const KERNEL_RULES: string
  function systemPrompt(persona: string): string

  // files.ts
  function seedFiles(request: RunRequest): Promise<Record<string, FileDataV1>>
  function inputText(request: RunRequest): string       // the human text plus an attachments block

  // checkpointer.ts
  const CHECKPOINT_SCHEMA = 'langgraph'
  function openCheckpointer(databaseUrl: string): Promise<PostgresSaver>   // fromConnString + setup()

  // run.ts
  interface RunContext { checkpointer: BaseCheckpointSaver; log: Logger }
  function runDeepAgent(request: RunRequest, ctx: RunContext, queue: EventQueue<RunEvent>): Promise<void>

  // index.ts
  const runtime: Runtime                                  // name 'deepagents'
  ```

---

- [ ] **Step 1: Create the package and register the directory**

Create `runtimes/deepagents/package.json`:

```json
{
  "name": "@harness/runtime-deepagents",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@harness/runtime-api": "workspace:*",
    "@harness/shared": "workspace:*",
    "@langchain/core": "1.2.11",
    "@langchain/langgraph": "1.4.15",
    "@langchain/langgraph-checkpoint-postgres": "1.0.5",
    "@langchain/openai": "1.5.13",
    "deepagents": "1.13.4",
    "langchain": "1.5.11",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@modelcontextprotocol/client": "^2.0.0",
    "@modelcontextprotocol/server": "^2.0.0",
    "@types/node": "^26.5.1",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

Exact versions, not carets: Deep Agents releases weekly and the option names in this plan were verified against these. `tsconfig.json` is a copy of `harness/identity-api`'s; `vitest.config.ts` is a copy of `harness/approvals`' (global setup, no file parallelism) and `src/test-global-setup.ts` is a copy of `harness/approvals/src/test-global-setup.ts` — the checkpointer test needs the migrated test database to exist, not its tables.

Add `- 'runtimes/*'` after `- 'identities/*'` in `pnpm-workspace.yaml`. In the root `package.json` add `'runtimes/*/src/**/*.ts'` after `'identities/*/src/**/*.ts'` in both the `arch` and `arch:graph` globs. In `.dependency-cruiser.cjs` add `{ name: 'runtime-deepagents', src: 'runtimes/deepagents/src', severity: 'error' }` after `identity-static` in `PACKAGES`, `'runtimes/deepagents'` after `'identities/static'` in `WORKSPACE_DIRS`, `'^runtimes/[^/]+/src/(?!index[.]ts)'` to `collapsePattern`, and this rule after `an-identity-plugin-imports-only-api-and-shared`:

```js
  {
    name: 'a-runtime-imports-only-api-and-shared',
    comment:
      'A runtime plug-in depends on @harness/runtime-api, @harness/shared and third-party packages only. It receives its tools as an MCP client and everything else on the request, so an edge into core-tools, @harness/db, a surface, a pack or the host would be the runtime reaching past the contract — and a cycle, because the host loads it. Its own tests are not exempt: the fake gateway and the tool fixture it needs live under @harness/runtime-api/testing for exactly that reason.',
    severity: 'error',
    from: { path: '^runtimes/([^/]+)/' },
    to: {
      path: '^(harness|packs|surfaces|identities|runtimes|evals|scripts)/',
      pathNot: ['^harness/runtime-api/src/', '^harness/shared/src/', '^runtimes/$1/'],
    },
  },
```

In `harness/core-tools/src/app/record-surface.ts` add `'runtimes'` to `SOURCE_ROOTS` (after `'identities'`) and extend its comment: a runtime reads its configuration off `RuntimeDeps.env`, and the scan walks it so a variable it reads is documented. Run `pnpm install`.

- [ ] **Step 2: Write the failing bridge test**

Create `runtimes/deepagents/src/domain/bridge.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashArgs } from '@harness/shared';
import type { RunEvent } from '@harness/runtime-api';
import { toolServerFixture, type ToolServerFixture } from '@harness/runtime-api/testing';
import { bridgeTools, textOf } from './bridge.js';

let fixture: ToolServerFixture;
beforeEach(async () => {
  fixture = await toolServerFixture([
    {
      name: 'records_search',
      description: 'Search records',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      handler: ({ query }) => ({ status: 'ok', result: { hits: [String(query)] } }),
    },
    {
      name: 'forms_release',
      description: 'Release',
      inputSchema: { type: 'object', properties: { file_id: { type: 'string' } } },
      handler: () => ({ status: 'pending', approval_id: '11111111-1111-4111-8111-111111111111' }),
    },
    {
      name: 'explode',
      description: 'Fails',
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        throw new Error('Tool explode failed: boom');
      },
    },
  ]);
});
afterEach(() => fixture.close());

function sink(max = 10) {
  const events: RunEvent[] = [];
  let exceeded = 0;
  return { events, exceeded: () => exceeded, sink: { emit: (e: RunEvent) => events.push(e), maxToolCalls: max, onBudgetExceeded: () => (exceeded += 1) } };
}

describe('bridgeTools', () => {
  it('lists every kernel tool as a LangChain tool with its name, description and schema', async () => {
    const tools = await bridgeTools(fixture.client, sink().sink);
    expect(tools.map((t) => t.name).sort()).toEqual(['explode', 'forms_release', 'records_search']);
    expect(tools.find((t) => t.name === 'records_search')?.description).toBe('Search records');
  });

  it('invokes through the client, returns the envelope text to the model, and emits call and result', async () => {
    const { events, sink: s } = sink();
    const tools = await bridgeTools(fixture.client, s);
    const search = tools.find((t) => t.name === 'records_search')!;
    const out = await search.invoke({ query: 'ada' });
    expect(fixture.calls).toEqual([{ name: 'records_search', args: { query: 'ada' } }]);
    expect(JSON.parse(String(out))).toEqual({ status: 'ok', result: { hits: ['ada'] } });
    expect(events).toEqual([
      { type: 'tool_call', name: 'records_search', argsHash: hashArgs({ query: 'ada' }) },
      { type: 'tool_result', name: 'records_search', status: 'ok' },
    ]);
  });

  it('reports a parked call as pending and a failed call as error, both as plain text for the model', async () => {
    const { events, sink: s } = sink();
    const tools = await bridgeTools(fixture.client, s);
    const pending = String(await tools.find((t) => t.name === 'forms_release')!.invoke({ file_id: 'x' }));
    expect(JSON.parse(pending)).toMatchObject({ status: 'pending' });
    const failed = String(await tools.find((t) => t.name === 'explode')!.invoke({}));
    expect(failed).toBe('Tool explode failed: boom');
    expect(events.filter((e) => e.type === 'tool_result')).toEqual([
      { type: 'tool_result', name: 'forms_release', status: 'pending' },
      { type: 'tool_result', name: 'explode', status: 'error' },
    ]);
  });

  it('stops calling the kernel once the tool budget is spent', async () => {
    const { events, exceeded, sink: s } = sink(1);
    const tools = await bridgeTools(fixture.client, s);
    const search = tools.find((t) => t.name === 'records_search')!;
    await search.invoke({ query: 'one' });
    const refused = String(await search.invoke({ query: 'two' }));
    expect(fixture.calls).toHaveLength(1);
    expect(refused).toContain('budget');
    expect(exceeded()).toBe(1);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
  });
});

describe('textOf', () => {
  it('joins every text block', () => {
    expect(textOf({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
    expect(textOf({})).toBe('');
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter @harness/runtime-deepagents test`
Expected: FAIL — `Cannot find module './bridge.js'`.

- [ ] **Step 4: Write the event queue and the bridge**

Create `runtimes/deepagents/src/domain/events.ts`:

```ts
/**
 * The async iterable a run pushes its events into and the host reads from. Unbounded on
 * purpose: a run emits a few hundred events at most, and back-pressure on a model stream would
 * stall the model call it is reading from.
 */
export class EventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((result: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
```

Create `runtimes/deepagents/src/domain/bridge.ts`:

```ts
import type { Client } from '@modelcontextprotocol/client';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import type { JsonSchema7Type } from '@langchain/core/utils/json_schema';
import { hashArgs } from '@harness/shared';
import type { RunEvent } from '@harness/runtime-api';

export interface BridgeSink {
  emit(event: RunEvent): void;
  maxToolCalls: number;
  /** Called once, on the first call past the budget. The caller aborts the run. */
  onBudgetExceeded(): void;
}

interface CallResult {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
}

/** The text blocks of a tool result, joined: what the model reads. */
export function textOf(res: { content?: unknown }): string {
  const blocks = Array.isArray(res.content) ? (res.content as { type?: string; text?: string }[]) : [];
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

function statusOf(res: CallResult): 'ok' | 'pending' | 'error' {
  if (res.isError) return 'error';
  const status = (res.structuredContent as { status?: unknown } | undefined)?.status;
  return status === 'pending' ? 'pending' : 'ok';
}

/**
 * The kernel's tools, as LangChain tools the agent can call.
 *
 * Every invocation goes through the one `Client` the host handed over, so policy, audit and the
 * outbox are the kernel's business and the runtime has no other route into anything (spec
 * invariant 9). The bridge is also where the run learns a tool was called: it emits `tool_call`
 * before and `tool_result` after, and it counts the calls against the budget. The result is
 * handed to the model as the kernel's own text — a `pending` envelope or a "Tool x failed" line
 * — never reshaped, so what the model reads is what the audit row says.
 */
export async function bridgeTools(client: Client, sink: BridgeSink): Promise<StructuredToolInterface[]> {
  const { tools } = await client.listTools();
  let calls = 0;
  let exceeded = false;
  return (tools as { name: string; description?: string; inputSchema: unknown }[]).map((def) =>
    tool(
      async (input: Record<string, unknown>) => {
        calls += 1;
        if (calls > sink.maxToolCalls) {
          if (!exceeded) {
            exceeded = true;
            sink.onBudgetExceeded();
          }
          return 'This run has spent its tool-call budget; stop and report.';
        }
        sink.emit({ type: 'tool_call', name: def.name, argsHash: hashArgs(input) });
        let res: CallResult;
        try {
          res = (await client.callTool({ name: def.name, arguments: input })) as CallResult;
        } catch (err) {
          sink.emit({ type: 'tool_result', name: def.name, status: 'error' });
          return `Tool ${def.name} could not be reached: ${err instanceof Error ? err.name : 'error'}.`;
        }
        sink.emit({ type: 'tool_result', name: def.name, status: statusOf(res) });
        return textOf(res);
      },
      { name: def.name, description: def.description ?? '', schema: def.inputSchema as JsonSchema7Type },
    ),
  );
}
```

- [ ] **Step 5: Run the bridge tests green**

Run: `pnpm --filter @harness/runtime-deepagents test`
Expected: PASS (5 tests).

- [ ] **Step 6: Write the failing tests for the middleware, the prompt and the files**

Create `runtimes/deepagents/src/domain/middleware.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DENY_ALL_WRITES, READ_ONLY_FS_TOOLS, chatModel, kernelToolFilter } from './middleware.js';

describe('the agent configuration', () => {
  it('offers only the four read-only filesystem tools and denies every write', () => {
    expect(READ_ONLY_FS_TOOLS).toEqual(['read_file', 'ls', 'glob', 'grep']);
    expect(DENY_ALL_WRITES).toEqual([{ operations: ['write'], paths: ['/**'], mode: 'deny' }]);
  });

  it('builds a chat model on the gateway route with the principal as the user', () => {
    const model = chatModel({ baseUrl: 'http://gateway', apiKey: 'sk-x', route: 'chat', user: 'u-1' }, 'reason');
    expect(model.model).toBe('reason');
    expect(model.user).toBe('u-1');
    expect(model.clientConfig.baseURL).toBe('http://gateway/v1');
  });

  it('names the tool filter so the middleware order stays readable', () => {
    expect(kernelToolFilter().name).toBe('KernelToolFilter');
  });
});
```

Create `runtimes/deepagents/src/domain/prompt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { KERNEL_RULES, systemPrompt } from './prompt.js';

describe('systemPrompt', () => {
  it('is the persona followed by the fixed rules block', () => {
    const text = systemPrompt('# Persona\nBe brief.');
    expect(text.startsWith('# Persona\nBe brief.\n\n')).toBe(true);
    expect(text.endsWith(KERNEL_RULES)).toBe(true);
  });

  it('tells the model where skills and memory are and what pending means', () => {
    expect(KERNEL_RULES).toContain('/skills/');
    expect(KERNEL_RULES).toContain('/memories/MEMORY.md');
    expect(KERNEL_RULES).toContain('"pending"');
  });
});
```

Create `runtimes/deepagents/src/domain/files.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureRequest } from '@harness/runtime-api/testing';
import { inputText, seedFiles } from './files.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-skills-'));
  await mkdir(path.join(dir, 'credentialing-intake'));
  await writeFile(path.join(dir, 'credentialing-intake', 'SKILL.md'), '---\nname: credentialing-intake\n---\n# Intake\n');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const tools = null as never;

describe('seedFiles', () => {
  it('puts every skill body under /skills/<name>/SKILL.md and the memory under /memories/MEMORY.md', async () => {
    const files = await seedFiles(
      fixtureRequest({
        tools,
        skills: [{ name: 'credentialing-intake', version: '1.0.0', description: 'x', dir: path.join(dir, 'credentialing-intake') }],
        memory: '# Memory\n- prefers short answers',
      }),
    );
    expect(Object.keys(files).sort()).toEqual(['/memories/MEMORY.md', '/skills/credentialing-intake/SKILL.md']);
    expect(files['/skills/credentialing-intake/SKILL.md'].content).toEqual(['---', 'name: credentialing-intake', '---', '# Intake']);
    expect(files['/memories/MEMORY.md'].content).toEqual(['# Memory', '- prefers short answers']);
  });

  it('seeds an empty memory as a placeholder line, so the memory file always exists', async () => {
    const files = await seedFiles(fixtureRequest({ tools, memory: '' }));
    expect(files['/memories/MEMORY.md'].content).toEqual(['(no memories yet)']);
  });
});

describe('inputText', () => {
  it('is the text alone when nothing was attached', () => {
    expect(inputText(fixtureRequest({ tools, input: { text: 'hi', attachments: [] } }))).toBe('hi');
  });

  it('lists attachments as storage-relative paths the ingest tool takes', () => {
    const text = inputText(fixtureRequest({ tools, input: { text: 'File these.', attachments: [{ name: 'licence.pdf', path: 'licence.pdf' }] } }));
    expect(text).toBe('File these.\n\nAttachments (pass the path to documents_ingest):\n- incoming/licence.pdf (licence.pdf)');
  });
});
```

- [ ] **Step 7: Run them and watch them fail**

Run: `pnpm --filter @harness/runtime-deepagents test`
Expected: FAIL — three missing modules.

- [ ] **Step 8: Write the middleware, the prompt and the files modules**

Create `runtimes/deepagents/src/domain/middleware.ts`:

```ts
import { ChatOpenAI } from '@langchain/openai';
import type { FilesystemPermission } from 'deepagents';
import { createMiddleware } from 'langchain';
import type { RunModel } from '@harness/runtime-api';

/**
 * The built-in filesystem tools the model may see: enough to read a skill body and search the
 * seeded files, nothing that writes. `read_file` is required by the filesystem middleware in
 * every explicit list.
 */
export const READ_ONLY_FS_TOOLS = ['read_file', 'ls', 'glob', 'grep'] as const;

/** Belt and braces under the allowlist above: no write reaches the state backend either. */
export const DENY_ALL_WRITES: FilesystemPermission[] = [{ operations: ['write'], paths: ['/**'], mode: 'deny' }];

/**
 * Deep Agents publishes a `task` tool for delegating to subagents even when none are declared.
 * This run has none (spec 5.4), so the tool is removed from every model request; a tool the
 * model cannot see is a tool it cannot call.
 */
export function kernelToolFilter() {
  return createMiddleware({
    name: 'KernelToolFilter',
    wrapModelCall: (request, handler) => handler({ ...request, tools: request.tools.filter((t) => t.name !== 'task') }),
  });
}

/**
 * A chat model on one gateway route. The base URL is LiteLLM's OpenAI-compatible endpoint; the
 * key is the proxy's master key, so no vendor key is ever in this process; `user` is the
 * principal id, which LiteLLM records as the spender (spec decision 16).
 */
export function chatModel(model: RunModel, route: string): ChatOpenAI {
  return new ChatOpenAI({
    model: route,
    apiKey: model.apiKey,
    configuration: { baseURL: `${model.baseUrl.replace(/\/+$/, '')}/v1` },
    user: model.user,
  });
}
```

Create `runtimes/deepagents/src/domain/prompt.ts`:

```ts
/**
 * The rules the kernel adds under every persona. They say how *this* runtime is wired — where
 * the skills and the memory snapshot are, and what a parked tool looks like — and nothing about
 * any client, which is the persona's job.
 */
export const KERNEL_RULES = `## How this assistant is wired

- Your skills are files under /skills/<name>/SKILL.md. Read a skill with read_file before you follow it, and follow it as written.
- Your memory is /memories/MEMORY.md. It is read-only in this conversation; remember things only through the memory tools when they are offered.
- Every other tool is a kernel tool. A result with "status": "pending" and an approval_id means the action has NOT happened: a human has to approve it. Say so, name the approval id, and stop that part of the work until you are told the outcome.
- A tool result that starts with "Tool ... failed" or "... is blocked by policy" is the kernel refusing. Report it; do not retry the same call with the same arguments.
- Files the human attached are already in the store; the message lists their paths.`;

export function systemPrompt(persona: string): string {
  return `${persona.trimEnd()}\n\n${KERNEL_RULES}`;
}
```

Create `runtimes/deepagents/src/domain/files.ts`:

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunRequest } from '@harness/runtime-api';

/** Deep Agents' v1 file record: content as lines. */
export interface FileDataV1 {
  content: string[];
  created_at: string;
  modified_at: string;
}

function fileOf(text: string, at: string): FileDataV1 {
  return { content: text.replace(/\n$/, '').split('\n'), created_at: at, modified_at: at };
}

/**
 * The files the model may read, seeded into agent state on every turn: each skill's SKILL.md
 * under `/skills/<name>/`, and the memory snapshot under `/memories/MEMORY.md`. Seeding rather
 * than mounting is what keeps the runtime off the host filesystem: the model sees these lines and
 * nothing else on disk, and an edited skill is current on the next turn because it is re-read.
 */
export async function seedFiles(request: RunRequest): Promise<Record<string, FileDataV1>> {
  const at = new Date().toISOString();
  const files: Record<string, FileDataV1> = {};
  for (const skill of request.skills) {
    files[`/skills/${skill.name}/SKILL.md`] = fileOf(await readFile(path.join(skill.dir, 'SKILL.md'), 'utf8'), at);
  }
  files['/memories/MEMORY.md'] = fileOf(request.memory.trim() === '' ? '(no memories yet)' : request.memory, at);
  return files;
}

/** The human's text, plus the attachments as the storage-relative paths `documents_ingest` takes. */
export function inputText(request: RunRequest): string {
  if (request.input.attachments.length === 0) return request.input.text;
  const lines = request.input.attachments.map((a) => `- incoming/${a.path} (${a.name})`);
  return `${request.input.text}\n\nAttachments (pass the path to documents_ingest):\n${lines.join('\n')}`;
}
```

- [ ] **Step 9: Run them green**

Run: `pnpm --filter @harness/runtime-deepagents test`
Expected: PASS.

- [ ] **Step 10: Write the failing run test**

Create `runtimes/deepagents/src/domain/run.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashArgs } from '@harness/shared';
import type { RunEvent, RunRequest } from '@harness/runtime-api';
import {
  fixtureRequest,
  startFakeGateway,
  toolServerFixture,
  type FakeGateway,
  type FakeReply,
  type ToolServerFixture,
} from '@harness/runtime-api/testing';
import { EventQueue } from './events.js';
import { runDeepAgent } from './run.js';

let gateway: FakeGateway;
let fixture: ToolServerFixture;
let skillsDir: string;
const log = { info() {}, warn() {}, error() {} };

beforeEach(async () => {
  gateway = await startFakeGateway();
  fixture = await toolServerFixture([
    {
      name: 'records_search',
      description: 'search',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      handler: ({ query }) => ({ status: 'ok', result: { hits: [String(query)] } }),
    },
  ]);
  skillsDir = await mkdtemp(path.join(tmpdir(), 'harness-run-skills-'));
  await mkdir(path.join(skillsDir, 'credentialing-intake'));
  await writeFile(
    path.join(skillsDir, 'credentialing-intake', 'SKILL.md'),
    '---\nname: credentialing-intake\ndescription: Take documents into the record store.\n---\n# Intake\nCall records_search first.\n',
  );
});
afterEach(async () => {
  await gateway.close();
  await fixture.close();
  await rm(skillsDir, { recursive: true, force: true });
});

/** A responder that answers the n-th model call with the n-th reply and repeats the last one. */
function script(replies: FakeReply[]): void {
  let turn = 0;
  gateway.setResponder(() => {
    const reply = replies[Math.min(turn, replies.length - 1)];
    turn += 1;
    return reply;
  });
}

function request(over: Partial<RunRequest> = {}): RunRequest {
  return fixtureRequest({
    tools: fixture.client,
    model: { baseUrl: gateway.url, apiKey: 'sk-test', route: 'chat', user: 'u-coordinator' },
    skills: [{ name: 'credentialing-intake', version: '1.0.0', description: 'intake', dir: path.join(skillsDir, 'credentialing-intake') }],
    ...over,
  });
}

async function run(req: RunRequest, checkpointer = new MemorySaver()): Promise<RunEvent[]> {
  const queue = new EventQueue<RunEvent>();
  const finished = runDeepAgent(req, { checkpointer, log }, queue);
  const events: RunEvent[] = [];
  for await (const e of queue) events.push(e);
  await finished;
  return events;
}

describe('runDeepAgent', () => {
  it('reads a skill, calls a kernel tool, streams the answer and finishes with done', async () => {
    script([
      { toolCalls: [{ name: 'read_file', arguments: { file_path: '/skills/credentialing-intake/SKILL.md' } }] },
      { toolCalls: [{ name: 'records_search', arguments: { query: 'ada' } }] },
      { content: 'All filed.', inputTokens: 20, outputTokens: 4 },
    ]);
    const events = await run(request());
    expect(fixture.calls).toEqual([{ name: 'records_search', args: { query: 'ada' } }]);
    const types = events.map((e) => e.type);
    expect(types.indexOf('skill_activated')).toBeLessThan(types.indexOf('tool_call'));
    expect(events).toContainEqual({ type: 'skill_activated', name: 'credentialing-intake', version: '1.0.0' });
    expect(events).toContainEqual({ type: 'tool_call', name: 'records_search', argsHash: hashArgs({ query: 'ada' }) });
    expect(events).toContainEqual({ type: 'tool_result', name: 'records_search', status: 'ok' });
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('All filed.');
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: 'done', text: 'All filed.' });
    // Every model request carried the principal and offered the kernel tool and the four read-only file tools only.
    expect(gateway.calls).toHaveLength(3);
    for (const call of gateway.calls) {
      expect(call.user).toBe('u-coordinator');
      expect(call.tools.sort()).toEqual(['glob', 'grep', 'ls', 'read_file', 'records_search']);
      expect(call.authorization).toBe('Bearer sk-test');
    }
    // The persona and the kernel rules are the system prompt.
    const system = gateway.calls[0].messages.find((m) => m.role === 'system');
    expect(String(system?.content)).toContain('You are the test assistant.');
    expect(String(system?.content)).toContain('/skills/');
  });

  it('seeds history when the thread has no checkpoint yet, and not when it has', async () => {
    script([{ content: 'ok' }]);
    const checkpointer = new MemorySaver();
    await run(request({ history: [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }, { role: 'host', content: 'Approval x was approved.' }] }), checkpointer);
    const first = gateway.calls[0].messages.map((m) => `${m.role}:${String(m.content)}`);
    expect(first).toContain('user:earlier question');
    expect(first).toContain('assistant:earlier answer');
    expect(first.some((m) => m.startsWith('user:') && m.includes('Approval x was approved.'))).toBe(true);
    await run(request({ input: { text: 'second turn', attachments: [] }, history: [{ role: 'user', content: 'must not appear twice' }] }), checkpointer);
    const second = gateway.calls[1].messages.map((m) => String(m.content));
    expect(second.filter((c) => c === 'earlier question')).toHaveLength(1);
    expect(second).not.toContain('must not appear twice');
    expect(second).toContain('second turn');
  });

  it('ends with error "cancelled" and no done when the signal aborts mid-run', async () => {
    gateway.setResponder(() => new Promise<never>(() => {}));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const events = await run(request({ signal: controller.signal }));
    expect(events).toEqual([{ type: 'error', message: 'cancelled' }]);
    expect(gateway.calls).toHaveLength(1);
  });

  it('stops within one call of the model-call budget', async () => {
    script([{ toolCalls: [{ name: 'records_search', arguments: { query: 'again' } }] }]);
    const events = await run(request({ budget: { maxModelCalls: 3, maxToolCalls: 100, timeoutMs: 30_000 } }));
    expect(events.at(-1)).toEqual({ type: 'error', message: 'the run exceeded its budget' });
    expect(gateway.calls.length).toBeLessThanOrEqual(4);
  });

  it('stops when the tool-call budget is spent', async () => {
    script([{ toolCalls: [{ name: 'records_search', arguments: { query: 'again' } }] }]);
    const events = await run(request({ budget: { maxModelCalls: 100, maxToolCalls: 2, timeoutMs: 30_000 } }));
    expect(events.at(-1)).toEqual({ type: 'error', message: 'the run exceeded its budget' });
    expect(fixture.calls).toHaveLength(2);
  });

  it('turns a gateway failure into the fixed error message and logs the detail', async () => {
    gateway.setResponder(() => ({ status: 503, errorBody: { error: { message: 'secret prompt text' } } }));
    const logged: string[] = [];
    const queue = new EventQueue<RunEvent>();
    const finished = runDeepAgent(request(), { checkpointer: new MemorySaver(), log: { ...log, error: (m: string) => logged.push(m) } }, queue);
    const events: RunEvent[] = [];
    for await (const e of queue) events.push(e);
    await finished;
    expect(events.at(-1)).toEqual({ type: 'error', message: 'the run failed; see the host log' });
    expect(JSON.stringify(events)).not.toContain('secret prompt text');
    expect(logged.length).toBeGreaterThan(0);
  });

  it('lists an attachment in the human message', async () => {
    script([{ content: 'ok' }]);
    await run(request({ input: { text: 'File this.', attachments: [{ name: 'w9.pdf', path: 'w9.pdf' }] } }));
    const human = gateway.calls[0].messages.find((m) => m.role === 'user');
    expect(String(human?.content)).toContain('incoming/w9.pdf');
  });
});
```

- [ ] **Step 11: Run it and watch it fail**

Run: `pnpm --filter @harness/runtime-deepagents test`
Expected: FAIL — `Cannot find module './run.js'`.

- [ ] **Step 12: Write the run**

Create `runtimes/deepagents/src/domain/run.ts`:

```ts
import { AIMessage, AIMessageChunk, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { createDeepAgent, createFilesystemMiddleware } from 'deepagents';
import { modelFallbackMiddleware } from 'langchain';
import type { Logger } from '@harness/shared';
import type { RunEvent, RunRequest } from '@harness/runtime-api';
import { bridgeTools } from './bridge.js';
import type { EventQueue } from './events.js';
import { inputText, seedFiles } from './files.js';
import { DENY_ALL_WRITES, READ_ONLY_FS_TOOLS, chatModel, kernelToolFilter } from './middleware.js';
import { systemPrompt } from './prompt.js';

export interface RunContext {
  checkpointer: BaseCheckpointSaver;
  log: Logger;
}

const BUDGET_MESSAGE = 'the run exceeded its budget';
const FAILED_MESSAGE = 'the run failed; see the host log';

/** A skill activation is a `read_file` under `/skills/<name>/`; the version is the host's. */
const SKILL_PATH = /^\/skills\/([^/]+)\//;

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as { type?: string; text?: string }[])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

function historyMessages(request: RunRequest): BaseMessage[] {
  return request.history.map((turn) =>
    turn.role === 'assistant' ? new AIMessage(turn.content) : new HumanMessage(turn.content),
  );
}

/**
 * One run of the Deep Agents loop, from the request to a closed queue.
 *
 * The agent is built per run because everything about it is per run: the model carries the
 * principal as `user`, the tools are this run's kernel, the prompt is this client's persona.
 * Only the checkpointer is shared, keyed by the thread. Continuity is the checkpoint's; the
 * history on the request is used once, for a thread with no checkpoint yet (decision 7).
 *
 * Events come from two places. The bridge emits every kernel tool call and result and counts them
 * against the budget. This function reads the `messages` stream for text deltas and usage and the
 * `updates` stream for model turns — counted against the budget, and watched for the `read_file`
 * of a skill body, which is what `skill_activated` means here (decision 6).
 *
 * Exactly one terminal event, always: `done` with the run's text, or `error` with one of three
 * fixed messages. The framework's and the gateway's own messages go to the log and never into
 * an event, because an event reaches a surface (decision 9).
 */
export async function runDeepAgent(request: RunRequest, ctx: RunContext, queue: EventQueue<RunEvent>): Promise<void> {
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(request.budget.timeoutMs)]);
  let exceeded = false;
  const exceed = (): void => {
    exceeded = true;
    controller.abort();
  };
  const turns: string[][] = [];
  let modelCalls = 0;
  const activated = new Set<string>();

  try {
    const tools = await bridgeTools(request.tools, {
      emit: (e) => queue.push(e),
      maxToolCalls: request.budget.maxToolCalls,
      onBudgetExceeded: exceed,
    });
    const model = chatModel(request.model, request.model.route);
    const middleware = [
      createFilesystemMiddleware({ tools: READ_ONLY_FS_TOOLS }),
      kernelToolFilter(),
      ...(request.model.fallbackRoute ? [modelFallbackMiddleware(chatModel(request.model, request.model.fallbackRoute))] : []),
    ];
    const agent = createDeepAgent({
      model,
      tools,
      systemPrompt: systemPrompt(request.persona),
      skills: ['/skills/'],
      memory: ['/memories/MEMORY.md'],
      checkpointer: ctx.checkpointer,
      permissions: DENY_ALL_WRITES,
      middleware,
    });

    const config = { configurable: { thread_id: request.threadId } };
    const fresh = (await ctx.checkpointer.getTuple(config)) === undefined;
    const messages: BaseMessage[] = [...(fresh ? historyMessages(request) : []), new HumanMessage(inputText(request))];
    const files = await seedFiles(request);

    const stream = (await agent.stream(
      { messages, files },
      {
        ...config,
        streamMode: ['messages', 'updates'],
        signal,
        recursionLimit: 2 * request.budget.maxModelCalls + 10,
      },
    )) as AsyncIterable<[string, unknown]>;

    for await (const [mode, payload] of stream) {
      if (mode === 'messages') {
        const [chunk] = payload as [BaseMessage, unknown];
        if (!(chunk instanceof AIMessageChunk || chunk instanceof AIMessage)) continue;
        const delta = contentText(chunk.content);
        if (delta !== '') {
          if (turns.length === 0) turns.push([]);
          turns[turns.length - 1].push(delta);
          queue.push({ type: 'text', delta });
        }
        const usage = chunk.usage_metadata;
        if (usage) queue.push({ type: 'usage', inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, costUsd: 0 });
        continue;
      }
      const update = payload as Record<string, { messages?: BaseMessage[] } | undefined>;
      if (!('model_request' in update)) continue;
      modelCalls += 1;
      turns.push([]);
      if (modelCalls > request.budget.maxModelCalls) exceed();
      for (const message of update.model_request?.messages ?? []) {
        if (!(message instanceof AIMessage || message instanceof AIMessageChunk)) continue;
        for (const call of message.tool_calls ?? []) {
          if (call.name !== 'read_file') continue;
          const match = SKILL_PATH.exec(String((call.args as { file_path?: unknown }).file_path ?? ''));
          const skill = match && request.skills.find((s) => s.name === match[1]);
          if (!skill || activated.has(skill.name)) continue;
          activated.add(skill.name);
          queue.push({ type: 'skill_activated', name: skill.name, version: skill.version });
        }
      }
    }
    if (exceeded) {
      queue.push({ type: 'error', message: BUDGET_MESSAGE });
      return;
    }
    queue.push({ type: 'done', text: turns.map((t) => t.join('')).filter((t) => t !== '').join('\n\n') });
  } catch (err) {
    if (request.signal.aborted) queue.push({ type: 'error', message: 'cancelled' });
    else if (exceeded) queue.push({ type: 'error', message: BUDGET_MESSAGE });
    else if ((signal.reason as { name?: string } | undefined)?.name === 'TimeoutError') queue.push({ type: 'error', message: 'the run timed out' });
    else {
      ctx.log.error(`run ${request.runId} failed`, err);
      queue.push({ type: 'error', message: FAILED_MESSAGE });
    }
  } finally {
    queue.close();
  }
}
```

Two things to check while making this compile, both verified against the installed types but easy to trip on: `createDeepAgent`'s generic `tools` parameter is happiest with `tools` typed as `StructuredToolInterface[]` (what `bridgeTools` returns); and the `stream` cast to `AsyncIterable<[string, unknown]>` is the whole of the typing the loop needs — do not widen it further. The budget test that stops on model calls passes because the abort is raised while the next model request is in flight (`exceed()` aborts the shared signal), which is exactly "within one model call".

- [ ] **Step 13: Run the run tests green**

Run: `pnpm --filter @harness/runtime-deepagents test`
Expected: PASS (7 run tests plus the earlier ones).

- [ ] **Step 14: Write the checkpointer, the runtime and their tests**

Create `runtimes/deepagents/src/domain/checkpointer.ts`:

```ts
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

/** The checkpointer keeps its own tables in this schema; kernel code never references them (spec 6). */
export const CHECKPOINT_SCHEMA = 'langgraph';

/** A saver on the host's database, with its schema and tables created if they are not there yet. */
export async function openCheckpointer(databaseUrl: string): Promise<PostgresSaver> {
  const saver = PostgresSaver.fromConnString(databaseUrl, { schema: CHECKPOINT_SCHEMA });
  await saver.setup();
  return saver;
}
```

Create `runtimes/deepagents/src/index.ts`:

```ts
import { defineRuntime, type RunEvent, type Runtime } from '@harness/runtime-api';
import { openCheckpointer } from './domain/checkpointer.js';
import { EventQueue } from './domain/events.js';
import { runDeepAgent } from './domain/run.js';

/**
 * Deep Agents JS as a runtime plug-in. The host loads this by name from `HARNESS_RUNTIME` and
 * holds nothing but the contract; every framework word lives under this directory. It reads no
 * environment of its own: the model gateway arrives on every request, the database URL on the
 * deps, and `storageDir` is not needed — the model reaches no filesystem.
 */
export const runtime: Runtime = defineRuntime({
  name: 'deepagents',
  version: '0.1.0',
  secrets: [],
  connect: async (deps) => {
    const checkpointer = await openCheckpointer(deps.databaseUrl);
    deps.log.info('deepagents: checkpointer ready in schema langgraph');
    return {
      name: 'deepagents',
      run(request) {
        const queue = new EventQueue<RunEvent>();
        void runDeepAgent(request, { checkpointer, log: deps.log }, queue);
        return { events: queue };
      },
      stop: () => checkpointer.end(),
    };
  },
});
```

Create `runtimes/deepagents/src/index.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runtime } from './index.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://harness:harness@localhost:15432/harness_test';
const log = { info() {}, warn() {}, error() {} };

describe('the deepagents runtime', () => {
  it('declares its name and no secrets: the gateway key arrives on every request', () => {
    expect(runtime.name).toBe('deepagents');
    expect(runtime.secrets).toEqual([]);
  });

  it('creates the checkpoint tables in schema langgraph when it connects, and stops cleanly', async () => {
    const session = await runtime.connect({ env: {}, log, databaseUrl: url, storageDir: '/nonexistent' });
    expect(session.name).toBe('deepagents');
    const pool = new pg.Pool({ connectionString: url });
    try {
      const { rows } = await pool.query(
        "select table_name from information_schema.tables where table_schema = 'langgraph' order by table_name",
      );
      expect(rows.map((r: { table_name: string }) => r.table_name)).toEqual([
        'checkpoint_blobs',
        'checkpoint_migrations',
        'checkpoint_writes',
        'checkpoints',
      ]);
    } finally {
      await pool.end();
    }
    await session.stop();
  });
});
```

(`pg` and `@types/pg` go in `devDependencies` for this test; drop the unused `drizzle-orm` import — it is not a dependency of this package.)

Create `runtimes/deepagents/src/conformance.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import { afterAll, beforeAll } from 'vitest';
import type { RunEvent, RuntimeSession } from '@harness/runtime-api';
import { runtimeConformance, startFakeGateway, type FakeGateway, type FakeReply } from '@harness/runtime-api/testing';
import { EventQueue } from './domain/events.js';
import { runDeepAgent } from './domain/run.js';

let gateway: FakeGateway;
let skillsDir: string;
let since = 0;

beforeAll(async () => {
  gateway = await startFakeGateway();
  skillsDir = await mkdtemp(path.join(tmpdir(), 'harness-conformance-'));
  await mkdir(path.join(skillsDir, 'credentialing-roster'));
  await writeFile(path.join(skillsDir, 'credentialing-roster', 'SKILL.md'), '---\nname: credentialing-roster\ndescription: roster\n---\n# Roster\n');
});
afterAll(async () => {
  await gateway.close();
  await rm(skillsDir, { recursive: true, force: true });
});

function script(replies: FakeReply[]): void {
  since = gateway.calls.length;
  let turn = 0;
  gateway.setResponder(() => {
    const reply = replies[Math.min(turn, replies.length - 1)];
    turn += 1;
    return reply;
  });
}

/** A session over a memory checkpointer whose model is pointed at the fake gateway. */
function session(): RuntimeSession {
  const checkpointer = new MemorySaver();
  const log = { info() {}, warn() {}, error() {} };
  return {
    name: 'deepagents',
    run(request) {
      const queue = new EventQueue<RunEvent>();
      void runDeepAgent({ ...request, model: { ...request.model, baseUrl: gateway.url } }, { checkpointer, log }, queue);
      return { events: queue };
    },
    stop: async () => {},
  };
}

runtimeConformance('deepagents', {
  connect: async () => session(),
  script: (s) =>
    script([
      ...(s.skill ? [{ toolCalls: [{ name: 'read_file', arguments: { file_path: `/skills/${s.skill.name}/SKILL.md` } }] }] : []),
      { toolCalls: [{ name: s.toolCall.name, arguments: s.toolCall.args }] },
      { content: s.finalText },
    ]),
  hang: () => {
    since = gateway.calls.length;
    gateway.setResponder(() => new Promise<never>(() => {}));
  },
  modelRequests: () => gateway.calls.slice(since).map((c) => ({ user: c.user })),
  skills: [{ name: 'credentialing-roster', version: '1.0.0', description: 'roster', dir: path.join(skillsDir, 'credentialing-roster') }],
});
```

- [ ] **Step 15: Run the whole package green**

Run: `pnpm --filter @harness/runtime-deepagents test`
Expected: PASS — the unit suites, the two `index` tests and six conformance cases.

- [ ] **Step 16: Extend the kernel vocabulary scan**

In `harness/core-tools/src/kernel-vocabulary.test.ts` add to `SCANNED`:

```ts
  {
    what: 'framework and vendor vocabulary',
    root: 'harness/runtime-api/src',
    forbidden: FRAMEWORK_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'deployment vocabulary',
    root: 'harness/runtime-api/src',
    forbidden: DEPLOYMENT_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'credentialing vocabulary',
    root: 'runtimes/deepagents/src',
    forbidden: DOMAIN_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'messaging vocabulary',
    root: 'runtimes/deepagents/src',
    forbidden: MESSAGING_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'deployment vocabulary',
    root: 'runtimes/deepagents/src',
    forbidden: DEPLOYMENT_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
```

and extend the file's header comment: the runtime plug-in is the only place `deepagents`, `langchain` and `langgraph` may live, and it is scanned for everything else. The `credentialing-intake` skill name in `run.test.ts` and `conformance.test.ts` is why tests are skipped, as everywhere. `KERNEL_RULES` in `prompt.ts` says "kernel tool", "memory tools", "documents_ingest" — none of the forbidden words; keep it that way.

- [ ] **Step 17: Write the README, run the gates, commit**

Create `runtimes/deepagents/README.md`: what the runtime is, the pinned versions and why they are exact, the per-run agent, the bridge, the four file tools and the denied writes, `/skills/` and `/memories/MEMORY.md`, the `langgraph` schema, the budget, the three error messages, and how to run the conformance kit.

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green; snapshots unchanged.

```bash
git add runtimes pnpm-workspace.yaml package.json pnpm-lock.yaml .dependency-cruiser.cjs harness/core-tools/src/app/record-surface.ts harness/core-tools/src/kernel-vocabulary.test.ts
git commit -m "feat(runtimes): add the Deep Agents runtime behind the runtime contract"
```

### Task 4: Migration 0011 — `threads`, `messages`, `approvals.thread_id`, `runs.status`, no `runs.caller`

The kernel's record of every conversation, independent of the checkpointer's format (spec
decision 9). Plus the two columns the host's flows need on tables that exist: the thread an
approval was parked from, so a decision can resume it, and the status a run ends in, so a
cancel is a fact. `runs.caller` goes (Plan 7 deferral b).

**Files:**
- Modify: `harness/db/src/domain/schema.ts`, `harness/db/src/testing.ts`, `harness/db/src/domain/schema.test.ts`
- Create: `harness/db/drizzle/0011_threads_and_messages.sql` (generated), `harness/db/drizzle/meta/0011_snapshot.json` (generated), `harness/db/drizzle/meta/_journal.json` (updated by drizzle-kit)
- Create: `harness/db/src/domain/legacy-0010.test-helpers.ts`, `harness/db/src/domain/migration-0011.test.ts`
- Modify: `harness/core-tools/src/domain/session/repository.ts`, `session/repository.test.ts`, `domain/approvals/repository.ts`, `tools/approvals.test.ts`, `harness/core-tools/src/index.ts`

**Interfaces:**
- Produces:

  ```ts
  // @harness/db schema
  const threads   // id uuid pk, client text, surface text, conversation text, principalId text, kind text ('chat'|'playbook'), createdAt, updatedAt; unique (client, surface, conversation, principal_id)
  const messages  // id uuid pk, threadId uuid fk threads, runId uuid fk runs (nullable), role text ('user'|'assistant'|'host'), principalId text, content text, tsv tsvector generated, createdAt; gin index on tsv, index (thread_id, created_at)
  // approvals.threadId uuid (nullable, fk threads); runs.status text NOT NULL default 'running'; runs.threadId references threads; runs.caller gone

  // @harness/core-tools
  type RunStatus = 'running' | 'done' | 'error' | 'cancelled'
  function closeRun(db: Db, runId: string, status: RunStatus, now?: () => Date): Promise<void>
  ```

---

- [ ] **Step 1: Write the failing schema tests**

Append to `harness/db/src/domain/schema.test.ts` (import `messages`, `runs`, `threads` from `./schema.js`):

```ts
describe('threads and messages', () => {
  async function thread() {
    const [row] = await db
      .insert(threads)
      .values({ client: 'test', surface: 'memory', conversation: 'memory', principalId: 'u-1', kind: 'chat' })
      .returning();
    return row;
  }

  it('keys a thread by client, surface, conversation and principal', async () => {
    await thread();
    await expect(
      db.insert(threads).values({ client: 'test', surface: 'memory', conversation: 'memory', principalId: 'u-1', kind: 'chat' }),
    ).rejects.toThrow(/threads_client_surface_conversation_principal_uq/);
    const [other] = await db
      .insert(threads)
      .values({ client: 'test', surface: 'memory', conversation: 'memory', principalId: 'u-2', kind: 'chat' })
      .returning();
    expect(other.id).toBeTruthy();
  });

  it('indexes message content for full-text search through the generated tsv column', async () => {
    const t = await thread();
    await db.insert(messages).values([
      { threadId: t.id, role: 'user', principalId: 'u-1', content: 'When does the licence for Dr Reyes expire?' },
      { threadId: t.id, role: 'assistant', principalId: 'u-1', content: 'It expires on 2027-03-31.' },
    ]);
    const hits = await db
      .select({ content: messages.content })
      .from(messages)
      .where(sql`${messages.tsv} @@ plainto_tsquery('english', 'licence expire')`);
    expect(hits.map((h) => h.content)).toEqual(['When does the licence for Dr Reyes expire?']);
  });

  it('starts a run as running and has no caller column', async () => {
    const [run] = await db.insert(runs).values({ client: 'test', principalId: 'u-1' }).returning();
    expect(run.status).toBe('running');
    expect('caller' in run).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @harness/db test`
Expected: FAIL — `threads` is not exported.

- [ ] **Step 3: Change the schema**

In `harness/db/src/domain/schema.ts`, add `pgSchema`-free table declarations after `approvals` and before `runs` (so `runs` can reference `threads`), and change `runs` and `approvals`:

```ts
/**
 * One conversation: a person on a surface in one conversation, or a playbook's own thread. The
 * kernel's record of every exchange, independent of whatever a runtime checkpoints for itself
 * (spec decision 9). Keyed per principal, so two people in one channel have two threads and each
 * turn runs as the person who wrote it.
 */
export const threads = pgTable(
  'threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    client: text('client').notNull(),
    surface: text('surface').notNull(),
    conversation: text('conversation').notNull(),
    principalId: text('principal_id').notNull(),
    /** `chat` for a conversation, `playbook` for a scheduled run (Plan 9). */
    kind: text('kind').notNull().default('chat'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('threads_client_surface_conversation_principal_uq').on(t.client, t.surface, t.conversation, t.principalId),
  ],
);

export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * One turn of a thread: what the human said, what the assistant answered, or what the host
 * injected (an approval outcome). `tsv` is generated by Postgres from `content`, so episodic search
 * (Plan 9's `session_search`) never depends on an application-side index. Plaintext, so the host
 * runs the restricted-pattern guard before every insert (spec invariant 10).
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id),
    runId: uuid('run_id').references(() => runs.id),
    role: text('role').notNull(),
    principalId: text('principal_id').notNull(),
    content: text('content').notNull(),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('english', "content")`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_tsv_idx').using('gin', t.tsv), index('messages_thread_created_idx').on(t.threadId, t.createdAt)],
);
```

`messages` references `runs`, and `runs` references `threads`, so declare them in the order `threads`, `runs`, `messages` (move the `runs` block up, between `threads` and `messages`). Change `runs`:

```ts
export const runs = pgTable('runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  client: text('client').notNull(),
  /** Who this run acts as: a `Principal.id` from the client's identity plug-in. */
  principalId: text('principal_id').notNull(),
  /** The conversation thread this run belongs to. Null for the stdio server and the eval runner. */
  threadId: uuid('thread_id').references(() => threads.id),
  /** The surface the run was started from and the conversation on it. Null for the stdio server. */
  surface: text('surface'),
  conversation: text('conversation'),
  channel: text('channel'),
  /** `running` until the host closes it as `done`, `error` or `cancelled` (spec invariant 12). */
  status: text('status').notNull().default('running'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
});
```

(no `caller`). In `approvals`, add after `messageRef`:

```ts
    /** The thread the parked call was made from, so a decision can resume it. Null outside a thread. */
    threadId: uuid('thread_id').references(() => threads.id),
```

In `harness/db/src/testing.ts` add `messages, threads` to the `TRUNCATE` list (after `runs`; the `CASCADE` covers the order).

- [ ] **Step 4: Generate the migration, twice**

From `harness/db/`: `pnpm drizzle-kit generate --name threads_and_messages` then `pnpm drizzle-kit generate` again; the second must print "No schema changes". Open `harness/db/drizzle/0011_threads_and_messages.sql` and confirm it contains, in some order: `CREATE TABLE "threads"`, `CREATE TABLE "messages"` with `"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED`, `CREATE INDEX "messages_tsv_idx" ON "messages" USING gin ("tsv")`, `CREATE UNIQUE INDEX "threads_client_surface_conversation_principal_uq"`, `ALTER TABLE "approvals" ADD COLUMN "thread_id" uuid`, `ALTER TABLE "runs" ADD COLUMN "status" text DEFAULT 'running' NOT NULL`, `ALTER TABLE "runs" DROP COLUMN "caller"`, and the three foreign keys. No hand-written data section is needed: every new column has a default or is nullable. If drizzle-kit names the generated column's type with a different quoting, keep what it wrote — the test below replays the shipped file.

- [ ] **Step 5: Run the schema tests green**

Run: `pnpm --filter @harness/db test`
Expected: PASS (the global setup applies 0011 to `harness_test`).

- [ ] **Step 6: Write the migration replay test**

Create `harness/db/src/domain/legacy-0010.test-helpers.ts` — the tables 0011 touches as they stood after 0010, copied from `schema.ts` before this task (the `runs` and `approvals` DDL with `caller`, without `status`/`thread_id`), in the style of `legacy-0009.test-helpers.ts`:

```ts
export const LEGACY_0010_DDL = `
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" text NOT NULL,
	"caller" text NOT NULL,
	"principal_id" text NOT NULL,
	"thread_id" uuid,
	"surface" text,
	"conversation" text,
	"channel" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" text NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_encrypted" bytea,
	"summary" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"executed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"surface" text,
	"conversation_id" text,
	"message_ref" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
`;
```

Create `harness/db/src/domain/migration-0011.test.ts`:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../testing.js';
import type { Db } from './client.js';
import { LEGACY_0010_DDL } from './legacy-0010.test-helpers.js';
import { migrationStatements } from './migration-sql.test-helpers.js';
import { scratchDatabase } from './scratch-database.test-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, '../../drizzle/0011_threads_and_messages.sql');
const scratch = scratchDatabase(`harness_test_migration_0011_${process.pid}`);

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await scratch.create(TEST_DATABASE_URL, LEGACY_0010_DDL));
});
afterAll(async () => {
  await close?.();
  await scratch.drop(TEST_DATABASE_URL);
});

describe('migration 0011_threads_and_messages', () => {
  it('keeps every existing run and approval, drops caller, and adds status and thread_id with defaults', async () => {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`INSERT INTO runs (id, client, caller, principal_id) VALUES ('11111111-1111-4111-8111-111111111111', 'demo', 'u-1', 'u-1')`));
        await tx.execute(
          sql.raw(
            `INSERT INTO approvals (client, action, payload, summary, requested_by, expires_at, idempotency_key) VALUES ('demo', 'forms_release', '{}', 's', 'u-1', now() + interval '1 day', 'k1')`,
          ),
        );
        for (const statement of migrationStatements(MIGRATION)) await tx.execute(sql.raw(statement));

        const runs = (await tx.execute(sql.raw(`SELECT principal_id, status, thread_id FROM runs`))).rows;
        expect(runs).toEqual([{ principal_id: 'u-1', status: 'running', thread_id: null }]);
        const columns = (await tx.execute(sql.raw(`SELECT column_name FROM information_schema.columns WHERE table_name = 'runs'`))).rows.map((r) => r.column_name);
        expect(columns).not.toContain('caller');
        const approvals = (await tx.execute(sql.raw(`SELECT thread_id FROM approvals`))).rows;
        expect(approvals).toEqual([{ thread_id: null }]);

        await tx.execute(sql.raw(`INSERT INTO threads (client, surface, conversation, principal_id) VALUES ('demo', 'memory', 'memory', 'u-1')`));
        await tx.execute(
          sql.raw(`INSERT INTO messages (thread_id, role, principal_id, content) SELECT id, 'user', 'u-1', 'the licence expires soon' FROM threads`),
        );
        const hits = (await tx.execute(sql.raw(`SELECT content FROM messages WHERE tsv @@ plainto_tsquery('english', 'expires')`))).rows;
        expect(hits).toEqual([{ content: 'the licence expires soon' }]);
        tx.rollback();
      });
    } catch (err) {
      if (!(err instanceof TransactionRollbackError)) throw err;
    }
  });
});
```

Run: `pnpm --filter @harness/db test` — Expected: PASS.

- [ ] **Step 7: Write the failing core-tools tests for `closeRun`, no `caller`, and the parked thread**

In `harness/core-tools/src/domain/session/repository.test.ts` add (import `closeRun` and `runs` as the file already imports `openRun`):

```ts
  it('closes a run with its status and end time', async () => {
    const context = await openRun(db, { client: 'test', principal: TEST_PRINCIPAL, threadId: null });
    await closeRun(db, context.runId, 'cancelled', () => new Date('2026-09-15T12:30:00Z'));
    const [row] = await db.select().from(runs).where(eq(runs.id, context.runId));
    expect(row.status).toBe('cancelled');
    expect(row.endedAt?.toISOString()).toBe('2026-09-15T12:30:00.000Z');
    expect(row.principalId).toBe('u-test');
  });
```

In `harness/core-tools/src/tools/approvals.test.ts` add a case that parks an action with a context carrying a `threadId` (insert a `threads` row first with `db.insert(threads)`; build deps with `makeTestDeps(db, { context: { threadId: thread.id } })`) and asserts the `approvals` row's `threadId` equals it; and that a context with `threadId: null` parks with `threadId: null`.

- [ ] **Step 8: Implement**

In `harness/core-tools/src/domain/session/repository.ts` remove the `caller: input.principal.id,` line from `openRun`'s insert and add:

```ts
export type RunStatus = 'running' | 'done' | 'error' | 'cancelled';

/** Close a run: the status it ended in and when. The one writer of `runs.status` after `openRun`. */
export async function closeRun(db: Db, runId: string, status: RunStatus, now: () => Date = () => new Date()): Promise<void> {
  await db.update(runs).set({ status, endedAt: now() }).where(eq(runs.id, runId));
}
```

(import `eq` from `drizzle-orm`). In `harness/core-tools/src/domain/approvals/repository.ts` add `threadId: deps.context.threadId,` to the `approvals` insert values. In `harness/core-tools/src/index.ts` export `closeRun` and `type RunStatus` beside `openRun`.

- [ ] **Step 9: Run core-tools, then the gates, commit**

Run: `pnpm --filter @harness/core-tools test`, then `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green; both snapshots unchanged (the tool schemas did not move).

```bash
git add harness/db harness/core-tools
git commit -m "feat(db): add threads and messages, approvals.thread_id and runs.status; drop runs.caller"
```

### Task 5: Decisions by principal — the surface contract gains inbound and loses allowlists; the in-process `CoreToolsClient`

Authorisation moves from per-surface allowlists to the identity plug-in (Plan 7 deferral a,
spec invariants 2 and 3). In the same cut the surface contract gains `MessageEvent`,
`onMessage`, `startStream`, `typing` and the two capability flags, the memory surface gains a
`say` so every host test can drive a real inbound message, and the approvals package's route
into the kernel becomes an in-process client that opens one run per execution as the approver.
The stdio client, `child-env.ts` and the approvals `main.ts` go.

**Files:**
- Modify: `harness/surface-api/src/types.ts`, `surface.ts`, `index.ts`, `testing.ts`, `surface.test.ts`, `memory.test.ts`, `README.md`
- Modify: `surfaces/memory/src/index.ts`, `index.test.ts`, `README.md`
- Modify: `surfaces/slack/src/config.ts`, `session.ts`, `index.ts`, `testing.ts`, `transport/types.ts`, `transport/bolt.ts`, `transport/fake.ts`, `index.test.ts`, `session.test.ts`
- Modify: `harness/approvals/src/domain/execute/types.ts`, `fake.ts`; Create: `execute/in-process.ts`, `in-process.test.ts`; Delete: `execute/mcp-client.ts`, `mcp-client.test.ts`
- Modify: `harness/approvals/src/domain/handlers.ts`, `handlers.test.ts`, `decisions.ts`, `decisions.test.ts`, `cards.ts`, `cards.test.ts`, `surfaces/dual-surface.test.ts`, `runner.test.ts`, `index.ts`, `testing.ts`, `package.json`, `README.md`
- Delete: `harness/approvals/src/app/main.ts`, `app/child-env.ts`, `app/child-env.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `IdentitySession`, `Principal`, `levelAtLeast` from `@harness/identity-api`; `KernelConfig`, `depsForRun`, `openRun`, `closeRun`, `createCoreToolsServer`, `connectInProcess` from `@harness/core-tools`.
- Produces:

  ```ts
  // @harness/surface-api
  interface MessageEvent { surface: string; userId: string; conversation: string; text: string; attachments: readonly { name: string; path: string }[]; message: MessageRef | null; mentioned: boolean }
  interface StreamHandle { append(delta: string): void; end(): Promise<MessageRef> }
  interface SurfaceCapabilities { forms: boolean; privateReply: boolean; update: boolean; streaming: boolean; inlineConfirm: boolean }
  // on SurfaceSession (allowedUsers removed):
  onMessage(handler: (event: MessageEvent) => Promise<void>): void;
  startStream(conversation: string, opts?: { replyTo?: MessageRef; recipient?: string }): StreamHandle;   // SurfaceError when !capabilities.streaming
  typing?(conversation: string): Promise<void>;
  // MemorySurface additions
  readonly streams: { conversation: string; text: string; ended: boolean; replyTo: MessageRef | null }[]
  say(userId: string, text: string, over?: Partial<MessageEvent>): Promise<void>       // drives the onMessage handler
  // ANY_USER, allowsUser, parseAllowedUsers: removed

  // @harness/approvals
  interface CoreToolsClient { execute(approvalId: string, principal: Principal): Promise<ExecuteOutcome>; reconcile(staleAfterMinutes: number): Promise<{ approvals_expired: number; dispatches_parked: number }>; close(): Promise<void> }
  interface InProcessCoreToolsOptions { db: Db; config: KernelConfig; client: string; servicePrincipal: Principal; now?: () => Date }
  function createInProcessCoreToolsClient(opts: InProcessCoreToolsOptions): CoreToolsClient
  interface DecidedOutcome { row: ApprovalRow; decidedBy: Principal; execution?: ExecuteOutcome }
  interface DecisionDeps { db: Db; surfaces: LoadedSurfaces; core: CoreToolsClient; identity: IdentitySession; client: string; now: () => Date; onDecided?: (outcome: DecidedOutcome) => Promise<void> }
  interface DecisionInput { approvalId: string; decision: 'approved' | 'declined'; decidedBy: Principal; surface: string; note?: string }
  function decidedCard(row: ApprovalRow, outcome: { executed: boolean; tool?: string; error?: string; decidedByName?: string }): Card
  function threadReplyText(row: ApprovalRow, who: string, execution?: ExecuteOutcome): string
  class FakeCoreToolsClient { executed: string[]; executedBy: string[]; … }   // executedBy = principal ids
  ```

---

- [ ] **Step 1: Write the failing contract tests**

Replace the `allowsUser` block of `harness/surface-api/src/surface.test.ts` with nothing (delete it and the three imports). In `harness/surface-api/src/memory.test.ts` replace the two allowlist cases with:

```ts
  it('declares streaming and no inline confirm, and reports both flags', () => {
    const surface = new MemorySurface();
    expect(surface.capabilities).toEqual({ forms: true, privateReply: true, update: true, streaming: true, inlineConfirm: false });
  });

  it('delivers a said message to the registered handler, mentioned by default', async () => {
    const surface = new MemorySurface();
    const seen: MessageEvent[] = [];
    surface.onMessage(async (event) => {
      seen.push(event);
    });
    await surface.say('U012', 'hello');
    expect(seen).toEqual([
      { surface: 'memory', userId: 'U012', conversation: 'memory', text: 'hello', attachments: [], message: null, mentioned: true },
    ]);
    await surface.say('U012', 'in a channel', { mentioned: false, conversation: 'C1' });
    expect(seen[1]).toMatchObject({ mentioned: false, conversation: 'C1' });
  });

  it('refuses to say anything before a handler is registered', async () => {
    await expect(new MemorySurface().say('U012', 'x')).rejects.toThrow(/no message handler/);
  });

  it('streams: appends accumulate, end records the text as a posted message and hands back its reference', async () => {
    const surface = new MemorySurface();
    const stream = surface.startStream('memory');
    stream.append('Hel');
    stream.append('lo');
    expect(surface.streams).toEqual([{ conversation: 'memory', text: 'Hello', ended: false, replyTo: null }]);
    const ref = await stream.end();
    expect(surface.streams[0].ended).toBe(true);
    expect(surface.texts).toEqual([{ conversation: 'memory', text: 'Hello', replyTo: null }]);
    expect(ref).toEqual({ surface: 'memory', conversation: 'memory', id: 'm1' });
  });

  it('refuses a stream when the capability is off', () => {
    const surface = new MemorySurface({ capabilities: { streaming: false } });
    expect(() => surface.startStream('memory')).toThrow(SurfaceError);
  });
```

(import `MessageEvent` from `./types.js` and `SurfaceError` from `@harness/shared`.)

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @harness/surface-api test`
Expected: FAIL — `onMessage`, `say`, `startStream` do not exist; `streaming` missing from capabilities.

- [ ] **Step 3: Change the contract and the memory surface**

In `harness/surface-api/src/types.ts`:

```ts
/** A human wrote to the assistant. Attachments are already under `<storageDir>/incoming`; `path` is relative to it. */
export interface MessageEvent {
  surface: string;
  userId: string;
  conversation: string;
  text: string;
  attachments: readonly { name: string; path: string }[];
  /** The message itself, when the surface can address it again. */
  message: MessageRef | null;
  /**
   * True when the assistant was addressed: mentioned in a channel, or written to directly. A
   * direct message is addressed by construction, so an adapter sets this true there too. The
   * host answers only when this is true.
   */
  mentioned: boolean;
}

/** A reply being written as it is produced. `end` posts what is left and returns the message. */
export interface StreamHandle {
  append(delta: string): void;
  end(): Promise<MessageRef>;
}

export interface SurfaceCapabilities {
  forms: boolean;
  privateReply: boolean;
  update: boolean;
  /** `startStream` works. Off, the host posts the whole reply once. */
  streaming: boolean;
  /** A card's buttons can sit in the conversation the question was asked in. Unused until a surface has it. */
  inlineConfirm: boolean;
}
```

On `SurfaceSession` delete `allowedUsers` and its comment; add after `onFormSubmit`:

```ts
  /** One handler for every message written to the assistant on this surface. Replaces any previous one. */
  onMessage(handler: (event: MessageEvent) => Promise<void>): void;
  /**
   * Begin a streamed reply. Throws `SurfaceError` when `capabilities.streaming` is false. `recipient`
   * is the user the reply is for, for a surface whose streaming API wants one.
   */
  startStream(conversation: string, opts?: { replyTo?: MessageRef; recipient?: string }): StreamHandle;
  /** Show that a reply is coming, where the surface can. Optional. */
  typing?(conversation: string): Promise<void>;
```

In `surface.ts` delete `ANY_USER`, `parseAllowedUsers`, `allowsUser` and their comments; in `index.ts` export only `defineSurface` from it and add `MessageEvent`, `StreamHandle` to the type exports. In `testing.ts`:

- remove `allowedUsers` from `MemorySurfaceOptions` and the class;
- `capabilities` default becomes `{ forms: true, privateReply: true, update: true, streaming: true, inlineConfirm: false, ...opts.capabilities }`;
- add fields `readonly streams: { conversation: string; text: string; ended: boolean; replyTo: MessageRef | null }[] = [];` and `private messageHandler: ((event: MessageEvent) => Promise<void>) | null = null;`;
- add methods:

```ts
  onMessage(handler: (event: MessageEvent) => Promise<void>): void {
    this.messageHandler = handler;
  }

  startStream(conversation: string, opts: { replyTo?: MessageRef; recipient?: string } = {}): StreamHandle {
    this.requires(this.capabilities.streaming, 'cannot stream a reply');
    const entry = { conversation, text: '', ended: false, replyTo: opts.replyTo ?? null };
    this.streams.push(entry);
    return {
      append: (delta) => {
        entry.text += delta;
      },
      end: async () => {
        entry.ended = true;
        return this.postText(conversation, entry.text, { replyTo: opts.replyTo });
      },
    };
  }

  /**
   * A human writes to the assistant. Mentioned by default, in the default conversation, with no
   * attachments; `over` overrides any field. This is how every host test starts a turn.
   */
  async say(userId: string, text: string, over: Partial<MessageEvent> = {}): Promise<void> {
    if (!this.messageHandler) throw new SurfaceError(`${this.name}: no message handler is registered`);
    await this.messageHandler({
      surface: this.name,
      userId,
      conversation: this.defaultConversation,
      text,
      attachments: [],
      message: null,
      mentioned: true,
      ...over,
    });
  }
```

Update the class comment: the fake is also the first inbound surface. In `surfaces/memory/src/index.ts` delete the `MEMORY_ALLOWED_USERS` read and the `allowedUsers` option, and rewrite the comment (there is nothing to authorise here: who may act is the identity plug-in's answer, on every surface). In `surfaces/memory/src/index.test.ts` replace the two allowlist cases with one that connects and asserts `session.capabilities.streaming` is true.

Run: `pnpm --filter @harness/surface-api test && pnpm --filter @harness/surface-memory test` — Expected: PASS.

- [ ] **Step 4: Make the Slack adapter compile against the new contract**

In `surfaces/slack/src/config.ts` delete `allowedUsers` and the `parseAllowedUsers`/`optionalEnv` imports. In `transport/types.ts` add:

```ts
/** One inbound message, narrowed off Bolt's payload in Plan 8b. Declared now so the session can register for it. */
export interface SlackInbound {
  userId: string;
  channel: string;
  text: string;
  ts: string;
  threadTs: string | null;
  /** True for a direct message or a message that mentions the bot. */
  mentioned: boolean;
  files: { name: string; url: string }[];
}
```

and `onMessage(handler: (message: SlackInbound) => Promise<void>): void;` on `SlackEvents`. In `transport/bolt.ts` add a `messageHandler` slot and `onMessage(handler) { messageHandler = handler; }` on the returned `events` — nothing feeds it yet; the Bolt listeners land in Plan 8b, and the comment says so. In `transport/fake.ts` add the same slot plus `emitMessage(message: SlackInbound)`. In `session.ts`:

- delete `allowedUsers: config.allowedUsers,`;
- `capabilities: { forms: true, privateReply: true, update: true, streaming: false, inlineConfirm: false }`;
- add:

```ts
    onMessage(handler) {
      events.onMessage(async (message) => {
        await handler({
          surface: NAME,
          userId: message.userId,
          conversation: message.channel,
          text: message.text,
          // Downloaded into <storageDir>/incoming by Plan 8b's transport; until then, none.
          attachments: message.files.map((f) => ({ name: f.name, path: f.name })),
          message: ref(message.channel, message.ts),
          mentioned: message.mentioned,
        });
      });
    },

    startStream() {
      throw new SurfaceError(`${NAME}: cannot stream a reply`);
    },
```

In `testing.ts` drop `allowedUsers: parseAllowedUsers('U012')` and the import. In `session.test.ts` update the capabilities assertion to the five flags. `index.test.ts` is unchanged (the secrets list is Plan 8b's business).

Run: `pnpm --filter @harness/surface-slack test` — Expected: PASS.

- [ ] **Step 5: Write the failing approvals tests**

In `harness/approvals/src/domain/handlers.test.ts` replace `wire` and the imports with:

```ts
import { StaticIdentity } from '@harness/identity-api/testing';
import type { Principal } from '@harness/identity-api';

const LEAD: Principal = { id: 'u-coordinator', kind: 'user', level: 'lead', displayName: 'Coordinator', surfaces: { memory: 'U012' }, attributes: {} };
const MEMBER: Principal = { id: 'u-member', kind: 'user', level: 'member', displayName: 'Member', surfaces: { memory: 'U345' }, attributes: {} };
const SERVICE: Principal = { id: 'svc-bot', kind: 'service', level: 'service', displayName: 'Bot', surfaces: { memory: 'UBOT' }, attributes: {} };

function wire(capabilities: Partial<MemorySurface['capabilities']> = {}) {
  const surface = new MemorySurface({ capabilities });
  const core = new FakeCoreToolsClient();
  const identity = new StaticIdentity([LEAD, MEMBER, SERVICE]);
  registerApprovalHandlers(surface, { db, surfaces: surfacesOf([surface]), core, identity, client: 'demo-practice', now });
  return { surface, core };
}
```

Every existing case keeps pressing as `'U012'` (now the lead). Change the first case to also assert `expect(core.executedBy).toEqual(['u-coordinator'])` and that the row's `decidedBy` is `'u-coordinator'`. Replace the "unknown user" case (whatever the current file names it) with three:

```ts
  it('refuses someone the identity plug-in does not know, privately, and learns nothing about the approval', async () => {
    const row = await seed();
    const { surface, core } = wire();
    await surface.press(APPROVE_ACTION_ID, row.id, 'U999');
    expect(core.executed).toEqual([]);
    expect(surface.privates).toEqual([{ conversation: 'memory', userId: 'U999', text: 'You are not an approver for this workspace.' }]);
  });

  it('refuses a principal below lead with the same message', async () => {
    const row = await seed();
    const { surface, core } = wire();
    await surface.press(APPROVE_ACTION_ID, row.id, 'U345');
    expect(core.executed).toEqual([]);
    expect(surface.privates[0].text).toBe('You are not an approver for this workspace.');
  });

  it('refuses a service principal whatever its level', async () => {
    const row = await seed();
    const { surface, core } = wire();
    await surface.press(APPROVE_ACTION_ID, row.id, 'UBOT');
    expect(core.executed).toEqual([]);
    expect(surface.privates[0].text).toBe('You are not an approver for this workspace.');
  });
```

The case that used `wire('')` (an empty allowlist) becomes a press by `'U999'`. In `decisions.test.ts`, every `decidedBy: 'U012'` becomes `decidedBy: LEAD` (declare `LEAD` as above) and the row assertion becomes `decidedBy: 'u-coordinator'`; `deps()` gains `identity: new StaticIdentity([LEAD])`; add:

```ts
  it('calls onDecided with the row, the principal and the execution after the card is updated', async () => {
    const row = await seed();
    const surface = await postedSurface();
    const core = new FakeCoreToolsClient();
    const seen: DecidedOutcome[] = [];
    await decideApproval({ ...deps(surface, core), onDecided: async (o) => { seen.push(o); } }, { approvalId: row.id, decision: 'approved', decidedBy: LEAD, surface: 'memory' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ decidedBy: LEAD, execution: { status: 'executed', tool: 'forms_release' } });
    expect(seen[0].row.status).toBe('approved');
  });

  it('says who decided by display name in the thread reply', async () => {
    const row = await seed();
    const surface = await postedSurface();
    await decideApproval(deps(surface, new FakeCoreToolsClient()), { approvalId: row.id, decision: 'declined', decidedBy: LEAD, surface: 'memory' });
    expect(surface.texts[0].text).toContain('declined by Coordinator');
  });
```

In `cards.test.ts` the `decidedCard` expectation changes `{ user: 'U012' }` to `{ text: 'Coordinator' }` with `decidedCard(approved, { executed: true, tool: 'forms_release', decidedByName: 'Coordinator' })`, and one new case asserts the fallback `{ text: row.decidedBy }` when no name is given. `threadReplyText` tests take a name instead of a mention function. In `dual-surface.test.ts` the `wire()` builds `new StaticIdentity([{ ...LEAD, surfaces: { slack: 'U012', memory: 'U012', stub: 'U012' } }])` and passes `identity`; the `decideApproval` call passes `decidedBy: LEAD`. In `runner.test.ts` nothing changes but `FakeCoreToolsClient`'s shape.

Create `harness/approvals/src/domain/execute/in-process.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals, auditLog, runs } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import { TEST_PRINCIPAL, makeTestDeps } from '@harness/core-tools/testing';
import { pendingApproval, useTestDb } from '../../testing.js';
import { createInProcessCoreToolsClient } from './in-process.js';

const db = useTestDb();
const LEAD: Principal = { id: 'u-coordinator', kind: 'user', level: 'lead', displayName: 'Coordinator', surfaces: {}, attributes: {} };
const HOST: Principal = { id: 'svc-host', kind: 'service', level: 'service', displayName: 'Host', surfaces: {}, attributes: {} };

/** The startup-only half of a test bag: what `buildKernelConfig` would have built. */
function config() {
  const { db: _db, principal: _p, context: _c, sinks: _s, tools: _t, kernelTools: _k, kernel: _kn, ...rest } = makeTestDeps(db);
  return rest;
}

describe('createInProcessCoreToolsClient', () => {
  it('executes an approved action as the approver, in a run of its own, and audits it under that principal', async () => {
    const client = createInProcessCoreToolsClient({ db, config: config(), client: 'test', servicePrincipal: HOST });
    const [row] = await db
      .insert(approvals)
      .values(pendingApproval({ client: 'test', action: 'harness_notify', status: 'approved', requestedBy: TEST_PRINCIPAL.id, payloadEncrypted: null }))
      .returning();
    // No payload to replay: the kernel refuses, which is enough to prove the route and the principal.
    const outcome = await client.execute(row.id, LEAD);
    expect(outcome.status).toBe('failed');
    const audit = await db.select().from(auditLog).where(eq(auditLog.tool, 'approvals_execute'));
    expect(audit).toHaveLength(1);
    expect(audit[0].caller).toBe('u-coordinator');
    const [run] = await db.select().from(runs).where(eq(runs.id, audit[0].runId!));
    expect(run).toMatchObject({ principalId: 'u-coordinator', status: 'done' });
    await client.close();
  });

  it('reconciles as the service principal', async () => {
    const client = createInProcessCoreToolsClient({ db, config: config(), client: 'test', servicePrincipal: HOST });
    expect(await client.reconcile(10)).toEqual({ approvals_expired: 0, dispatches_parked: 0 });
    const audit = await db.select().from(auditLog).where(eq(auditLog.tool, 'harness_reconcile'));
    expect(audit[0].caller).toBe('svc-host');
    await client.close();
  });
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `pnpm --filter @harness/approvals test`
Expected: FAIL — `identity` is not a known dep, `execute` takes one argument, `./in-process.js` is missing.

- [ ] **Step 7: Implement the in-process client**

Change `harness/approvals/src/domain/execute/types.ts`: `execute(approvalId: string, principal: Principal): Promise<ExecuteOutcome>` (import the type), delete `McpLauncher`, keep `CallResult`. Delete `mcp-client.ts` and its test. Create `execute/in-process.ts`:

```ts
import type { Client } from '@modelcontextprotocol/client';
import { closeRun, connectInProcess, createCoreToolsServer, depsForRun, openRun, type KernelConfig } from '@harness/core-tools';
import type { Db } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import { describeError } from '@harness/shared';
import type { CallResult, CoreToolsClient, ExecuteOutcome } from './types.js';

export interface InProcessCoreToolsOptions {
  db: Db;
  config: KernelConfig;
  client: string;
  /** Whose runs the housekeeping calls are: the host's own service principal. */
  servicePrincipal: Principal;
  now?: () => Date;
}

function textOf(res: CallResult): string {
  return (res.content ?? [])
    .map((c) => c.text ?? '')
    .join(' ')
    .trim();
}

/**
 * The kernel, hosted in this process, one run per call.
 *
 * Every call opens a `runs` row as the given principal, builds one `ToolDeps` for it, connects an
 * MCP client to a server on that bag, makes the one call, and closes the run — so an approved
 * action executes and is audited as the person who approved it, and a reconcile as the host's own
 * service identity. Still through the MCP server, never a handler directly: the call passes the
 * policy switch and lands in `audit_log` like an agent-initiated one.
 */
export function createInProcessCoreToolsClient(opts: InProcessCoreToolsOptions): CoreToolsClient {
  const now = opts.now ?? (() => new Date());

  async function withRun<T>(principal: Principal, fn: (client: Client) => Promise<T>): Promise<T> {
    const context = await openRun(opts.db, { client: opts.client, principal });
    const deps = depsForRun(opts.config, { db: opts.db, principal, context });
    const { client, close } = await connectInProcess(() => createCoreToolsServer(deps));
    let status: 'done' | 'error' = 'done';
    try {
      return await fn(client);
    } catch (err) {
      status = 'error';
      throw err;
    } finally {
      await close();
      await closeRun(opts.db, context.runId, status, now);
    }
  }

  return {
    execute: (approvalId, principal) =>
      withRun(principal, async (client) => {
        const res = (await client.callTool({ name: 'approvals_execute', arguments: { approval_id: approvalId } })) as CallResult;
        if (res.isError) return { status: 'failed', error: textOf(res) || 'approvals_execute returned an error' } satisfies ExecuteOutcome;
        const result = res.structuredContent?.result as { tool?: string } | undefined;
        return { status: 'executed', tool: result?.tool ?? 'unknown' } satisfies ExecuteOutcome;
      }).catch((err: unknown) => ({ status: 'failed', error: describeError(err) }) as ExecuteOutcome),
    reconcile: (staleAfterMinutes) =>
      withRun(opts.servicePrincipal, async (client) => {
        const res = (await client.callTool({ name: 'harness_reconcile', arguments: { stale_after_minutes: staleAfterMinutes } })) as CallResult;
        if (res.isError) throw new Error(textOf(res) || 'harness_reconcile returned an error');
        const result = res.structuredContent?.result as { approvals_expired?: number; dispatches_parked?: number } | undefined;
        return { approvals_expired: result?.approvals_expired ?? 0, dispatches_parked: result?.dispatches_parked ?? 0 };
      }),
    close: async () => {},
  };
}
```

`FakeCoreToolsClient.execute(approvalId, principal)` records `this.executedBy.push(principal.id)` beside `executed`. `@harness/approvals`' `package.json` gains `@harness/identity-api` in `dependencies` and loses nothing (the MCP client is still used by the in-process transport's type).

- [ ] **Step 8: Implement the handlers, the decision and the cards**

`harness/approvals/src/domain/handlers.ts`: `DecisionDeps` gains `identity: IdentitySession` (in `decisions.ts`); `mayAct` becomes:

```ts
/**
 * Who may act on an approval, in a fixed order: the identity plug-in has to know this surface user,
 * they have to be a person rather than a service (spec invariant 2), and their level has to clear
 * `lead` (invariant 3). Every refusal says the same thing, so an outsider learns nothing about
 * whether the approval exists; then the id itself, because a malformed uuid can name no row.
 */
async function mayAct(
  session: SurfaceSession,
  deps: DecisionDeps,
  conversation: string,
  userId: string,
  approvalId: string,
): Promise<Principal | null> {
  const principal = await deps.identity.resolve({ surface: session.name, userId });
  if (!principal || principal.kind !== 'user' || !levelAtLeast(principal.level, 'lead')) {
    log.warn(`user ${userId} on surface "${session.name}" may not decide approvals; refused action on ${approvalId}`);
    await tellUser(session, conversation, userId, UNAUTHORIZED_TEXT);
    return null;
  }
  if (!UUID_RE.test(approvalId)) {
    log.warn(`rejected a malformed approval id from ${principal.id}`);
    await tellUser(session, conversation, userId, NOT_FOUND_TEXT);
    return null;
  }
  return principal;
}
```

`decide(...)` takes the returned principal and passes `decidedBy: principal`; `openEdit` likewise; the empty-allowlist warning in `registerApprovalHandlers` is deleted; `allowsUser` import replaced by `levelAtLeast` from `@harness/identity-api`. In `decisions.ts`:

```ts
export interface DecidedOutcome {
  row: ApprovalRow;
  decidedBy: Principal;
  execution?: ExecuteOutcome;
}

export interface DecisionDeps {
  db: Db;
  surfaces: LoadedSurfaces;
  core: CoreToolsClient;
  identity: IdentitySession;
  client: string;
  now: () => Date;
  /** Called after the decision is recorded, executed and shown: the host resumes the thread here. */
  onDecided?: (outcome: DecidedOutcome) => Promise<void>;
}

export interface DecisionInput {
  approvalId: string;
  decision: 'approved' | 'declined';
  decidedBy: Principal;
  surface: string;
  note?: string;
}
```

`decideApproval` writes `decidedBy: input.decidedBy.id`, calls `deps.core.execute(row.id, input.decidedBy)`, passes `input.decidedBy.displayName` to `tellSurface` (which hands it to `decidedCard` as `decidedByName` and to `threadReplyText` as `who`), and ends with:

```ts
  if (deps.onDecided) {
    try {
      await deps.onDecided({ row, decidedBy: input.decidedBy, execution });
    } catch (err) {
      log.error(`the onDecided hook failed for ${row.id}`, err);
    }
  }
  return { outcome: 'decided', status: input.decision, execution };
```

`threadReplyText(row, who: string, execution?)` uses `who` where it used `mention(row.decidedBy)`. `decidedCard(row, outcome: { executed; tool?; error?; decidedByName? })` renders `{ text: outcome.decidedByName ?? row.decidedBy }` for the decider. `index.ts` exports `createInProcessCoreToolsClient`, `type InProcessCoreToolsOptions`, `type DecidedOutcome`, and no longer `createMcpCoreToolsClient`/`McpLauncher`. Delete `harness/approvals/src/app/main.ts`, `app/child-env.ts`, `app/child-env.test.ts`, and the `start` script from the package's `package.json`.

- [ ] **Step 9: Retire the two allowlist variables**

In `.env.example` delete the `SLACK_ALLOWED_USERS=` line and the whole "Memory adapter" block, and replace the paragraph that documented them with, under the `# --- Messaging surfaces` heading:

```
# Who may decide an approval is not a surface setting any more: a decision is accepted only from
# a principal of level `lead` or above, resolved by the identity plug-in from the surface user id
# on the surface the card was posted on (clients/<name>/identity.yaml).
```

Compose is not touched here: the `approvals` service still interpolates `SLACK_ALLOWED_USERS` into an environment nothing reads, and Task 9 rewrites that service and re-records the snapshot once. `.env.example` may drop the variable now, because the env scan compares the example against what the source reads and the compose check compares the rendered file against the recorded one.

- [ ] **Step 10: Run the approvals suite, the gates, commit**

Run: `pnpm --filter @harness/approvals test`, then the four gates and `pnpm test`.
Expected: all green; both snapshots unchanged; the env scan passes because no shipping source reads `SLACK_ALLOWED_USERS` or `MEMORY_ALLOWED_USERS` any more.

Update `harness/surface-api/README.md`, `surfaces/memory/README.md` and `harness/approvals/README.md` for the contract additions, the removed allowlist, `say`, the in-process client and the deleted entrypoint (the host is where the process now lives — Task 8).

```bash
git add harness/surface-api surfaces/memory surfaces/slack harness/approvals .env.example pnpm-lock.yaml
git commit -m "feat(approvals): decide by principal, host core-tools in-process per execution, and give surfaces an inbound contract"
```

### Task 6: `@harness/host` — the package, threads, the runtime loader, and one kernel per run

The composition root's building blocks, each testable on its own against Postgres: the kernel
configuration built once (moved out of core-tools' app layer so another package may call it),
a runtime loaded by name, threads found or created and their history trimmed, the skill
catalogue and the persona read from disk, and one `ToolDeps` plus one in-process MCP client per
run.

**Files:**
- Create: `harness/core-tools/src/domain/tooling/config.ts`, `config.test.ts`; Modify: `harness/core-tools/src/app/server.ts`, `server.test.ts`, `harness/core-tools/src/index.ts`
- Create: `harness/host/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, `src/test-global-setup.ts`, `src/index.ts`, `src/testing.ts`
- Create: `harness/host/src/domain/host.ts`, `runtime/registry.ts`, `runtime/registry.test.ts`, `threads/repository.ts`, `threads/repository.test.ts`, `threads/trim.ts`, `threads/trim.test.ts`, `skills.ts`, `skills.test.ts`, `persona.ts`, `persona.test.ts`, `kernel.ts`, `kernel.test.ts`
- Modify: `.dependency-cruiser.cjs`, `harness/core-tools/src/kernel-vocabulary.test.ts`

**Interfaces:**
- Consumes: `KernelConfig`, `depsForRun`, `openRun`, `closeRun`, `createCoreToolsServer`, `connectInProcess`, `loadIdentity`, `type RunContext`, `type ToolDeps`, `type RunStatus` from `@harness/core-tools`; `containsRestrictedPattern` from `@harness/core-tools/redaction`; `threads`, `messages` from `@harness/db`; `LoadedSurfaces` from `@harness/approvals`; `RuntimeSession`, `RuntimeModule`, `RuntimeDeps`, `RunSkill`, `RunHistoryTurn` from `@harness/runtime-api`.
- Produces:

  ```ts
  // @harness/core-tools — domain/tooling/config.ts (moved from app/server.ts, now taking env)
  function buildKernelConfig(env: EnvSource): Promise<KernelConfig>
  function formsDirFrom(packs: Pick<PackRegistry, 'formsDir'>, raw?: string): string
  function parserFromEnv(storageDir: string, filesUrl?: string): DocumentParser
  function packNames(env: EnvSource): string[]

  // @harness/host — domain/host.ts
  interface HostBudget { maxModelCalls: number; maxToolCalls: number; timeoutMs: number; maxHistoryMessages: number }
  interface Host {
    db: Db; config: KernelConfig; client: string; identity: IdentitySession; surfaces: LoadedSurfaces; runtime: RuntimeSession;
    persona: string; skills: readonly RunSkill[]; model: { baseUrl: string; apiKey: string; route: string; fallbackRoute?: string };
    budget: HostBudget; servicePrincipal: Principal; log: Logger; now: () => Date;
    active: Map<string, AbortController>;
  }

  // domain/runtime/registry.ts
  function loadRuntime(specifier: string, deps: RuntimeDeps): Promise<RuntimeSession>

  // domain/threads/repository.ts
  interface ThreadKey { client: string; surface: string; conversation: string; principalId: string }
  type ThreadRow = typeof threads.$inferSelect
  function findOrCreateThread(db: Db, key: ThreadKey, kind?: 'chat' | 'playbook'): Promise<ThreadRow>
  const WITHHELD = '(withheld: it did not pass the redaction check)'
  function appendMessage(db: Db, m: { threadId: string; runId: string | null; role: 'user' | 'assistant' | 'host'; principalId: string; content: string }): Promise<string>  // returns the stored content
  function recentHistory(db: Db, threadId: string, limit: number): Promise<RunHistoryTurn[]>   // oldest first

  // domain/threads/trim.ts
  const HISTORY_MAX_CHARS = 24_000
  function trimHistory(turns: readonly RunHistoryTurn[], budget: { maxMessages: number; maxChars: number }): RunHistoryTurn[]

  // domain/skills.ts
  function readSkillCatalogue(dirs: readonly string[]): Promise<RunSkill[]>

  // domain/persona.ts
  function readPersona(clientDir: string): Promise<string>

  // domain/kernel.ts
  interface OpenedKernel { client: Client; deps: ToolDeps; context: RunContext & { runId: string }; close(status: RunStatus): Promise<void> }
  function openKernel(host: Pick<Host, 'db' | 'config' | 'client' | 'now'>, run: { principal: Principal; threadId: string | null; surface: string | null; conversation: string | null }): Promise<OpenedKernel>

  // testing.ts
  function testKernelConfig(db: Db, overrides?: Partial<KernelConfig>): KernelConfig
  ```

---

- [ ] **Step 1: Move `buildKernelConfig` into core-tools' domain layer**

Create `harness/core-tools/src/domain/tooling/config.ts` with `formsDirFrom`, `packNames`, `parserFromEnv` and `buildKernelConfig` moved verbatim from `app/server.ts`, with two changes: every function takes `env: EnvSource` where it read the ambient environment (`packNames(env)` reads `optionalEnv('HARNESS_PACKS', env)`; `formsDirFrom(packs, raw = optionalEnv('HARNESS_FORMS_DIR', env))` becomes `formsDirFrom(packs, raw: string | undefined)` with the caller reading the variable; `parserFromEnv(storageDir, filesUrl: string | undefined)` likewise), and `buildKernelConfig(env: EnvSource)` reads `HARNESS_CLIENT`, `APPROVAL_TTL_HOURS`, `CONFIDENCE_THRESHOLD`, `HARNESS_RESTRICTED_TO_MODEL`, `HARNESS_FORMS_DIR`, `HARNESS_FILES_URL` and `HARNESS_PACKS` off `env` through the shared helpers, and sets `env` on the returned config. `loadPolicy()`, `loadKey()`, `gatewayFromEnv()` and `storageRoot()` keep reading as they do today (they are called from here as before). Move the `formsDirFrom` and `parserFromEnv` cases of `app/server.test.ts` into `domain/tooling/config.test.ts`, passing the variable explicitly instead of setting `process.env`. `app/server.ts` keeps `clientDirFor`, `resolvePrincipal` and `buildDepsFromEnv`, which now calls `buildKernelConfig(process.env)`. Export `buildKernelConfig` from `harness/core-tools/src/index.ts` beside `depsForRun`.

Run: `pnpm --filter @harness/core-tools test` — Expected: PASS.

- [ ] **Step 2: Create the host package and register it**

`harness/host/package.json`:

```json
{
  "name": "@harness/host",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "start": "tsx src/app/main.ts"
  },
  "dependencies": {
    "@harness/approvals": "workspace:*",
    "@harness/core-tools": "workspace:*",
    "@harness/db": "workspace:*",
    "@harness/identity-api": "workspace:*",
    "@harness/identity-static": "workspace:*",
    "@harness/runtime-api": "workspace:*",
    "@harness/runtime-deepagents": "workspace:*",
    "@harness/shared": "workspace:*",
    "@harness/surface-api": "workspace:*",
    "@harness/surface-memory": "workspace:*",
    "@harness/surface-slack": "workspace:*",
    "@modelcontextprotocol/client": "^2.0.0",
    "dotenv": "^17.4.2",
    "drizzle-orm": "^0.45.2",
    "yaml": "^2.9.1"
  },
  "devDependencies": {
    "@types/node": "^26.5.1",
    "tsx": "^4.23.13",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

The four plug-ins are dependencies so pnpm resolves the dynamic imports (the same reason `@harness/approvals` lists `@harness/surface-slack`); `@harness/pack-healthcare` goes in `devDependencies` for the skills test below. `tsconfig.json`, `vitest.config.ts` and `src/test-global-setup.ts` are copies of `harness/approvals`'. In `.dependency-cruiser.cjs` add `{ name: 'host', src: 'harness/host/src', severity: 'error' }` after `approvals` in `PACKAGES`, `'harness/host'` after `'harness/approvals'` in `WORKSPACE_DIRS`, and:

```js
  {
    name: 'the-host-never-statically-imports-a-plugin',
    comment:
      'The host loads its surfaces from HARNESS_SURFACES, its identity plug-in from HARNESS_IDENTITY and its runtime from HARNESS_RUNTIME, all through dynamic imports. A static edge from harness/host/src into surfaces/, identities/, runtimes/ or packs/ would wire the one process every client runs to one transport, one directory or one framework by name. src/testing.ts and *.test.ts are exempt: a host test drives the real memory surface and the real runtime loader against the packages that ship, and is not shipped itself.',
    severity: 'error',
    from: { path: '^harness/host/src/', pathNot: ['\\.test\\.ts$', '^harness/host/src/testing\\.ts$'] },
    to: { path: '^(surfaces|identities|runtimes|packs)/[^/]+/', dependencyTypesNot: ['dynamic-import'] },
  },
```

Add `harness/host/src` to `kernel-vocabulary.test.ts`'s `SCANNED` for framework, credentialing, messaging and deployment vocabulary (`minFiles: 8`, tests skipped). The host says "runtime plug-in", "identity plug-in", "surface", "conversation", "message".

- [ ] **Step 3: Write the failing tests for the loader, threads, trimming, skills, persona and the kernel**

`harness/host/src/domain/runtime/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { loadRuntime } from './registry.js';

const deps = { env: {}, log: { info() {}, warn() {}, error() {} }, databaseUrl: process.env.TEST_DATABASE_URL ?? 'postgres://harness:harness@localhost:15432/harness_test', storageDir: '/nonexistent' };

describe('loadRuntime', () => {
  it('loads the Deep Agents runtime by its package name and connects it', async () => {
    const session = await loadRuntime('@harness/runtime-deepagents', deps);
    expect(session.name).toBe('deepagents');
    await session.stop();
  });

  it('names an unresolvable specifier without quoting a filesystem path', async () => {
    await expect(loadRuntime('@harness/runtime-nope', deps)).rejects.toThrow(/cannot load runtime plug-in "@harness\/runtime-nope"/);
    await expect(loadRuntime('@harness/runtime-nope', deps)).rejects.not.toThrow(/node_modules/);
  });

  it('refuses a module that exports no runtime', async () => {
    await expect(loadRuntime('@harness/shared', deps)).rejects.toThrow(ConfigError);
  });
});
```

`harness/host/src/domain/threads/repository.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { messages } from '@harness/db';
import { useTestDb } from '../../testing.js';
import { WITHHELD, appendMessage, findOrCreateThread, recentHistory } from './repository.js';

const db = useTestDb();
const key = { client: 'test', surface: 'memory', conversation: 'memory', principalId: 'u-1' };

describe('threads', () => {
  it('creates a thread once per key and finds it afterwards', async () => {
    const a = await findOrCreateThread(db, key);
    const b = await findOrCreateThread(db, key);
    expect(b.id).toBe(a.id);
    expect(a.kind).toBe('chat');
    const other = await findOrCreateThread(db, { ...key, principalId: 'u-2' });
    expect(other.id).not.toBe(a.id);
  });

  it('appends messages and reads them back oldest first, capped to the newest N', async () => {
    const t = await findOrCreateThread(db, key);
    for (const [role, content] of [['user', 'one'], ['assistant', 'two'], ['host', 'three'], ['user', 'four']] as const) {
      await appendMessage(db, { threadId: t.id, runId: null, role, principalId: 'u-1', content });
    }
    expect(await recentHistory(db, t.id, 3)).toEqual([
      { role: 'assistant', content: 'two' },
      { role: 'host', content: 'three' },
      { role: 'user', content: 'four' },
    ]);
  });

  it('withholds a message that carries a restricted identifier instead of storing it', async () => {
    const t = await findOrCreateThread(db, key);
    const stored = await appendMessage(db, { threadId: t.id, runId: null, role: 'assistant', principalId: 'u-1', content: 'The SSN is 123-45-6789.' });
    expect(stored).toBe(WITHHELD);
    const rows = await db.select().from(messages).where(eq(messages.threadId, t.id));
    expect(rows.map((r) => r.content)).toEqual([WITHHELD]);
  });
});
```

`harness/host/src/domain/threads/trim.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { trimHistory } from './trim.js';

const turn = (i: number, size = 10) => ({ role: 'user' as const, content: `${i}`.padEnd(size, 'x') });

describe('trimHistory', () => {
  it('keeps the newest turns under both the message and the character budget', () => {
    const turns = Array.from({ length: 10 }, (_, i) => turn(i));
    expect(trimHistory(turns, { maxMessages: 3, maxChars: 1000 }).map((t) => t.content[0])).toEqual(['7', '8', '9']);
    expect(trimHistory(turns, { maxMessages: 10, maxChars: 25 }).map((t) => t.content[0])).toEqual(['8', '9']);
  });

  it('never returns a single turn that is over the character budget', () => {
    expect(trimHistory([turn(1, 100)], { maxMessages: 10, maxChars: 50 })).toEqual([]);
  });
});
```

`harness/host/src/domain/skills.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { readSkillCatalogue } from './skills.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-host-skills-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('readSkillCatalogue', () => {
  it('reads name, description and version off every SKILL.md frontmatter, in directory order', async () => {
    await mkdir(path.join(dir, 'b-skill'));
    await writeFile(path.join(dir, 'b-skill', 'SKILL.md'), '---\nname: b-skill\ndescription: Second.\nversion: 2.0.0\n---\n# B\n');
    await mkdir(path.join(dir, 'a-skill'));
    await writeFile(path.join(dir, 'a-skill', 'SKILL.md'), '---\nname: a-skill\ndescription: First.\nversion: 1.0.0\n---\n# A\n');
    await writeFile(path.join(dir, 'README.md'), 'not a skill');
    expect(await readSkillCatalogue([dir])).toEqual([
      { name: 'a-skill', version: '1.0.0', description: 'First.', dir: path.join(dir, 'a-skill') },
      { name: 'b-skill', version: '2.0.0', description: 'Second.', dir: path.join(dir, 'b-skill') },
    ]);
  });

  it('refuses a skill whose frontmatter name is not its directory name', async () => {
    await mkdir(path.join(dir, 'x'));
    await writeFile(path.join(dir, 'x', 'SKILL.md'), '---\nname: y\ndescription: d\nversion: 1\n---\n');
    await expect(readSkillCatalogue([dir])).rejects.toThrow(/"y".*"x"/);
  });

  it('reads the shipped healthcare skills', async () => {
    const skills = await readSkillCatalogue([healthcarePack.skillsDir]);
    expect(skills.map((s) => s.name)).toEqual([
      'credentialing-expirations',
      'credentialing-fill-form',
      'credentialing-intake',
      'credentialing-roster',
    ]);
  });
});
```

`harness/host/src/domain/persona.test.ts`: writes a `SOUL.md` into a temp client dir, asserts `readPersona(dir)` returns its text, and that a missing file rejects with a `ConfigError` naming `SOUL.md`.

`harness/host/src/domain/kernel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, runs } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import { testKernelConfig, useTestDb } from '../testing.js';
import { openKernel } from './kernel.js';

const db = useTestDb();
const LEAD: Principal = { id: 'u-coordinator', kind: 'user', level: 'lead', displayName: 'Coordinator', surfaces: {}, attributes: {} };

describe('openKernel', () => {
  it('opens a run, serves the published tools to an in-process client on that run, and closes with a status', async () => {
    const host = { db, config: testKernelConfig(db), client: 'test', now: () => new Date('2026-09-15T12:00:00Z') };
    const kernel = await openKernel(host, { principal: LEAD, threadId: null, surface: 'memory', conversation: 'memory' });
    const { tools } = await kernel.client.listTools();
    expect(tools.map((t) => t.name)).toContain('documents_ingest');
    await kernel.client.callTool({ name: 'harness_reconcile', arguments: { stale_after_minutes: 10 } });
    const [row] = await db.select().from(auditLog).where(eq(auditLog.tool, 'harness_reconcile'));
    expect(row).toMatchObject({ caller: 'u-coordinator', runId: kernel.context.runId });
    expect(kernel.deps.principal).toBe(LEAD);
    await kernel.close('done');
    const [run] = await db.select().from(runs).where(eq(runs.id, kernel.context.runId));
    expect(run).toMatchObject({ status: 'done', surface: 'memory', conversation: 'memory' });
  });

  it('stamps the context it was given: a later skill activation lands on the same object', async () => {
    const host = { db, config: testKernelConfig(db), client: 'test', now: () => new Date() };
    const kernel = await openKernel(host, { principal: LEAD, threadId: null, surface: null, conversation: null });
    kernel.deps.context.skill = 'credentialing-roster';
    kernel.deps.context.skillVersion = '1.0.0';
    await kernel.client.callTool({ name: 'harness_reconcile', arguments: { stale_after_minutes: 10 } });
    const [row] = await db.select().from(auditLog).where(eq(auditLog.tool, 'harness_reconcile'));
    expect(row).toMatchObject({ skill: 'credentialing-roster', skillVersion: '1.0.0' });
    await kernel.close('done');
  });
});
```

- [ ] **Step 4: Run them and watch them fail**

Run: `pnpm install && pnpm --filter @harness/host test`
Expected: FAIL — every module missing.

- [ ] **Step 5: Implement the six modules and the testing subpath**

`harness/host/src/domain/host.ts`:

```ts
import type { LoadedSurfaces } from '@harness/approvals';
import type { KernelConfig } from '@harness/core-tools';
import type { Db } from '@harness/db';
import type { IdentitySession, Principal } from '@harness/identity-api';
import type { RunSkill, RuntimeSession } from '@harness/runtime-api';
import type { Logger } from '@harness/shared';

export interface HostBudget {
  maxModelCalls: number;
  maxToolCalls: number;
  timeoutMs: number;
  maxHistoryMessages: number;
}

/**
 * Everything the host's flows take: built once by `app/main.ts` (or `hostFixture` in a test) and
 * handed to every function as its first argument, so no module holds process-wide state. `active`
 * is the one mutable member — the runs in flight, by id, so a cancel can find its controller.
 */
export interface Host {
  db: Db;
  config: KernelConfig;
  client: string;
  identity: IdentitySession;
  surfaces: LoadedSurfaces;
  runtime: RuntimeSession;
  persona: string;
  skills: readonly RunSkill[];
  model: { baseUrl: string; apiKey: string; route: string; fallbackRoute?: string };
  budget: HostBudget;
  /** The host's own identity, for reconcile and, from Plan 9, for playbooks. */
  servicePrincipal: Principal;
  log: Logger;
  now: () => Date;
  active: Map<string, AbortController>;
}
```

`harness/host/src/domain/runtime/registry.ts` — `loadRuntime(specifier, deps)`, the same shape as core-tools' `loadIdentity` (three failure modes, `ConfigError`s naming only the specifier, `module.runtime` required, `connect` errors funnelled through a `pluginFailed`), with "runtime plug-in" in every message and the hint `add it to @harness/host dependencies and run pnpm install`.

`harness/host/src/domain/threads/repository.ts`:

```ts
import { and, asc, desc, eq } from 'drizzle-orm';
import { containsRestrictedPattern } from '@harness/core-tools/redaction';
import { messages, threads, type Db } from '@harness/db';
import type { RunHistoryTurn } from '@harness/runtime-api';

export interface ThreadKey {
  client: string;
  surface: string;
  conversation: string;
  principalId: string;
}

export type ThreadRow = typeof threads.$inferSelect;

/** What a message becomes when it trips the redaction check. Invariant 10: never the value. */
export const WITHHELD = '(withheld: it did not pass the redaction check)';

/** The thread for this person in this conversation, created on first contact. Idempotent under the unique index. */
export async function findOrCreateThread(db: Db, key: ThreadKey, kind: 'chat' | 'playbook' = 'chat'): Promise<ThreadRow> {
  const where = and(
    eq(threads.client, key.client),
    eq(threads.surface, key.surface),
    eq(threads.conversation, key.conversation),
    eq(threads.principalId, key.principalId),
  );
  const existing = await db.query.threads.findFirst({ where });
  if (existing) return existing;
  await db.insert(threads).values({ ...key, kind }).onConflictDoNothing();
  const row = await db.query.threads.findFirst({ where });
  if (!row) throw new Error('thread row missing after insert');
  return row;
}

/** Store one turn. The content is checked first and replaced, never stored, when it fails. Returns what was stored. */
export async function appendMessage(
  db: Db,
  m: { threadId: string; runId: string | null; role: 'user' | 'assistant' | 'host'; principalId: string; content: string },
): Promise<string> {
  const content = containsRestrictedPattern(m.content) ? WITHHELD : m.content;
  await db.insert(messages).values({ ...m, content });
  await db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, m.threadId));
  return content;
}

/** The newest `limit` turns of a thread, oldest first: the shape `RunRequest.history` takes. */
export async function recentHistory(db: Db, threadId: string, limit: number): Promise<RunHistoryTurn[]> {
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);
  return rows.reverse().map((r) => ({ role: r.role as RunHistoryTurn['role'], content: r.content }));
}
```

(`asc` is unused; do not import it.) `harness/host/src/domain/threads/trim.ts`:

```ts
import type { RunHistoryTurn } from '@harness/runtime-api';

export const HISTORY_MAX_CHARS = 24_000;

/** The newest turns that fit both budgets, oldest first. A turn that alone exceeds the character budget is dropped. */
export function trimHistory(turns: readonly RunHistoryTurn[], budget: { maxMessages: number; maxChars: number }): RunHistoryTurn[] {
  const kept: RunHistoryTurn[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0 && kept.length < budget.maxMessages; i -= 1) {
    if (chars + turns[i].content.length > budget.maxChars) break;
    chars += turns[i].content.length;
    kept.unshift(turns[i]);
  }
  return kept;
}
```

`harness/host/src/domain/skills.ts`: for each dir, `readdir` sorted, directories only, read `<dir>/<name>/SKILL.md`, parse the frontmatter between the first two `---` lines with `yaml`, require string `name`, `description`, `version`, refuse `name !== directory` with `ConfigError(\`skill "${name}" in directory "${entry}" must be named after its directory\`)`, return `{ name, version, description, dir }`. `harness/host/src/domain/persona.ts`: `readFile(path.join(clientDir, 'SOUL.md'), 'utf8')`, `ConfigError(\`cannot read ${path.join(clientDir, 'SOUL.md')}; every client folder needs a SOUL.md\`)` on failure.

`harness/host/src/domain/kernel.ts`:

```ts
import type { Client } from '@modelcontextprotocol/client';
import {
  closeRun,
  connectInProcess,
  createCoreToolsServer,
  depsForRun,
  openRun,
  type RunContext,
  type RunStatus,
  type ToolDeps,
} from '@harness/core-tools';
import type { Principal } from '@harness/identity-api';
import type { Host } from './host.js';

export interface OpenedKernel {
  client: Client;
  /** This run's bag. The conversation flow stamps `context.skill` on it when the runtime says so. */
  deps: ToolDeps;
  context: RunContext & { runId: string };
  close(status: RunStatus): Promise<void>;
}

/**
 * One kernel per run: a `runs` row, one `ToolDeps` on it, and an MCP client connected in-process
 * to a core-tools server built on that bag (spec decision 2). Everything the runtime calls goes
 * through `client`, and everything it calls is decided, audited and staged as this principal in
 * this run.
 */
export async function openKernel(
  host: Pick<Host, 'db' | 'config' | 'client' | 'now'>,
  run: { principal: Principal; threadId: string | null; surface: string | null; conversation: string | null },
): Promise<OpenedKernel> {
  const context = await openRun(host.db, { client: host.client, ...run });
  const deps = depsForRun(host.config, { db: host.db, principal: run.principal, context });
  const { client, close } = await connectInProcess(() => createCoreToolsServer(deps));
  return {
    client,
    deps,
    context,
    close: async (status) => {
      await close();
      await closeRun(host.db, context.runId, status, host.now);
    },
  };
}
```

`harness/host/src/testing.ts`:

```ts
import type { KernelConfig } from '@harness/core-tools';
import { makeTestDeps, type TestDepsOverrides } from '@harness/core-tools/testing';
import type { Db } from '@harness/db';

export { useTestDb } from '@harness/db/testing';

/** The startup-only half of a test bag: `makeTestDeps` less the per-run members. */
export function testKernelConfig(db: Db, overrides: TestDepsOverrides = {}): KernelConfig {
  const { db: _db, principal: _principal, context: _context, sinks: _sinks, tools: _tools, kernelTools: _kernel, kernel: _k, ...config } = makeTestDeps(db, overrides);
  return config;
}
```

(`hostFixture` is added in Task 7, once the flows exist.) `harness/host/src/index.ts` exports the types and functions above (`Host`, `HostBudget`, `loadRuntime`, `findOrCreateThread`, `appendMessage`, `recentHistory`, `trimHistory`, `readSkillCatalogue`, `readPersona`, `openKernel`, `WITHHELD`).

- [ ] **Step 6: Run the host suite green, then the gates, commit**

Run: `pnpm --filter @harness/host test`, then `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`.
Expected: all green; both snapshots unchanged.

```bash
git add harness/host harness/core-tools .dependency-cruiser.cjs pnpm-lock.yaml
git commit -m "feat(host): add the host package with threads, the runtime loader and one kernel per run"
```

### Task 7: The conversation flow — a message becomes a run, the run becomes a reply

Spec 3.2 steps 1–6 as one function callable from an adapter's `onMessage` today and from Plan
10's HTTP route later: resolve the principal (or refuse and audit), find the thread, open the
kernel, build the request, drive the runtime, forward the events to the surface, record the
messages, stamp the skill, close the run. Plus cancel. Tested against the real kernel and
Postgres with the memory surface, `StaticIdentity` and `ScriptedRuntime`.

**Files:**
- Create: `harness/host/src/domain/conversation.ts`, `conversation.test.ts`
- Modify: `harness/host/src/testing.ts`, `src/index.ts`

**Interfaces:**
- Consumes: Task 6's modules; `writeAudit`, `hashArgs` from `@harness/core-tools`/`@harness/shared`; `MessageEvent`, `StreamHandle`, `SurfaceSession` from `@harness/surface-api`; `RunEvent`, `RunRequest` from `@harness/runtime-api`.
- Produces:

  ```ts
  interface TurnInput { thread: ThreadRow; principal: Principal; role: 'user' | 'host'; text: string; attachments: readonly { name: string; path: string }[]; replyTo: MessageRef | null }
  interface TurnResult { runId: string; status: RunStatus; text: string }
  function runTurn(host: Host, turn: TurnInput): Promise<TurnResult>
  function handleMessage(host: Host, event: MessageEvent): Promise<void>       // the onMessage handler body
  function attachMessageHandlers(host: Host): void                             // registers handleMessage on every loaded surface
  function cancelRun(host: Host, runId: string): boolean
  const UNAUTHORISED_TEXT = 'You are not authorised to use this assistant.'
  // testing.ts
  interface HostFixture { host: Host; surface: MemorySurface; identity: StaticIdentity; runtime: ScriptedRuntime; close(): Promise<void> }
  function hostFixture(db: Db, opts: { trajectory: Trajectory; principals?: Principal[]; budget?: Partial<HostBudget>; streaming?: boolean }): Promise<HostFixture>
  ```

---

- [ ] **Step 1: Write the fixture**

Extend `harness/host/src/testing.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { surfacesOf } from '@harness/approvals';
import type { Principal } from '@harness/identity-api';
import { StaticIdentity } from '@harness/identity-api/testing';
import { ScriptedRuntime, type Trajectory } from '@harness/runtime-api/testing';
import { MemorySurface } from '@harness/surface-api/testing';
import type { Host, HostBudget } from './domain/host.js';

export const HOST_PRINCIPAL: Principal = { id: 'svc-host', kind: 'service', level: 'service', displayName: 'Host', surfaces: {}, attributes: {} };
export const COORDINATOR: Principal = { id: 'u-coordinator', kind: 'user', level: 'lead', displayName: 'Coordinator', surfaces: { memory: 'U012' }, attributes: {} };
export const MEMBER: Principal = { id: 'u-member', kind: 'user', level: 'member', displayName: 'Member', surfaces: { memory: 'U345' }, attributes: {} };

export interface HostFixture {
  host: Host;
  surface: MemorySurface;
  identity: StaticIdentity;
  runtime: ScriptedRuntime;
  close(): Promise<void>;
}

/**
 * A whole host over the real kernel and Postgres, with the memory surface, a static identity
 * and a scripted runtime: what every flow test drives. The persona and skills are small
 * literals; a test that needs the shipped skills passes them through `testKernelConfig`'s packs
 * and `readSkillCatalogue`.
 */
export async function hostFixture(
  db: Db,
  opts: { trajectory: Trajectory; principals?: Principal[]; budget?: Partial<HostBudget>; streaming?: boolean },
): Promise<HostFixture> {
  const surface = new MemorySurface({ capabilities: { streaming: opts.streaming ?? false } });
  const identity = new StaticIdentity(opts.principals ?? [COORDINATOR, MEMBER, HOST_PRINCIPAL]);
  const runtime = new ScriptedRuntime(opts.trajectory);
  const host: Host = {
    db,
    config: testKernelConfig(db, { storageDir: mkdtempSync(path.join(tmpdir(), 'harness-host-')) }),
    client: 'test',
    identity,
    surfaces: surfacesOf([surface]),
    runtime,
    persona: 'You are the test assistant.',
    skills: [{ name: 'credentialing-roster', version: '1.0.0', description: 'roster', dir: '/nonexistent' }],
    model: { baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-test', route: 'chat', fallbackRoute: 'reason' },
    budget: { maxModelCalls: 30, maxToolCalls: 60, timeoutMs: 30_000, maxHistoryMessages: 40, ...opts.budget },
    servicePrincipal: HOST_PRINCIPAL,
    log: { info() {}, warn() {}, error() {} },
    now: () => new Date(),
    active: new Map(),
  };
  return {
    host,
    surface,
    identity,
    runtime,
    close: async () => {
      await runtime.stop();
    },
  };
}
```

- [ ] **Step 2: Write the failing flow tests**

Create `harness/host/src/domain/conversation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals, auditLog, messages, runs, threads } from '@harness/db';
import { COORDINATOR, hostFixture, useTestDb } from '../testing.js';
import { UNAUTHORISED_TEXT, attachMessageHandlers, cancelRun } from './conversation.js';

const db = useTestDb();

describe('a message on a surface', () => {
  it('runs as the resolved principal, replies once on a surface without streaming, and records both turns', async () => {
    const f = await hostFixture(db, {
      trajectory: [{ tool: 'harness_reconcile', args: { stale_after_minutes: 10 } }, { say: 'Nothing was stale.' }],
    });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'Anything stale?');

    expect(f.surface.texts).toEqual([{ conversation: 'memory', text: 'Nothing was stale.', replyTo: null }]);
    const [thread] = await db.select().from(threads);
    expect(thread).toMatchObject({ client: 'test', surface: 'memory', conversation: 'memory', principalId: 'u-coordinator', kind: 'chat' });
    const rows = await db.select().from(messages).where(eq(messages.threadId, thread.id)).orderBy(messages.createdAt);
    expect(rows.map((r) => [r.role, r.content])).toEqual([
      ['user', 'Anything stale?'],
      ['assistant', 'Nothing was stale.'],
    ]);
    const [run] = await db.select().from(runs);
    expect(run).toMatchObject({ principalId: 'u-coordinator', threadId: thread.id, surface: 'memory', conversation: 'memory', status: 'done' });
    expect(rows.every((r) => r.runId === run.id)).toBe(true);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.tool, 'harness_reconcile'));
    expect(audit).toMatchObject({ caller: 'u-coordinator', runId: run.id });
    // The runtime was handed this run's kernel, the persona, the skills and the principal as the model user.
    const request = f.runtime.requests[0];
    expect(request.principal.id).toBe('u-coordinator');
    expect(request.model).toMatchObject({ route: 'chat', fallbackRoute: 'reason', user: 'u-coordinator' });
    expect(request.persona).toBe('You are the test assistant.');
    expect(request.skills.map((s) => s.name)).toEqual(['credentialing-roster']);
    expect(request.threadId).toBe(thread.id);
    expect(request.runId).toBe(run.id);
  });

  it('refuses a user the identity plug-in does not know, runs nothing, and audits the refusal', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'never' }] });
    attachMessageHandlers(f.host);
    await f.surface.say('U999', 'hello?');
    expect(f.surface.texts).toEqual([{ conversation: 'memory', text: UNAUTHORISED_TEXT, replyTo: null }]);
    expect(f.runtime.requests).toHaveLength(0);
    expect(await db.select().from(runs)).toHaveLength(0);
    const [audit] = await db.select().from(auditLog);
    expect(audit).toMatchObject({ decision: 'unauthorised', caller: 'memory:U999', tool: 'host_message' });
  });

  it('stays silent in a group conversation unless mentioned', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'hi' }] });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'chatter', { mentioned: false, conversation: 'C1' });
    expect(f.runtime.requests).toHaveLength(0);
    await f.surface.say('U012', '@bot hi', { mentioned: true, conversation: 'C1' });
    expect(f.runtime.requests).toHaveLength(1);
    expect(f.surface.texts[0]).toMatchObject({ conversation: 'C1', text: 'hi' });
  });

  it('streams when the surface can, and posts the withheld marker in place of a reply that trips the redaction check', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'Part one.' }, { say: 'Part two.' }], streaming: true });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'go');
    expect(f.surface.streams).toEqual([{ conversation: 'memory', text: 'Part one.Part two.', ended: true, replyTo: null }]);
    expect(f.surface.texts).toHaveLength(1);

    const g = await hostFixture(db, { trajectory: [{ say: 'The SSN is 123-45-6789.' }] });
    attachMessageHandlers(g.host);
    await g.surface.say('U012', 'tell me');
    expect(g.surface.texts.at(-1)?.text).toBe('(withheld: it did not pass the redaction check)');
    const rows = await db.select().from(messages);
    expect(rows.some((r) => r.content.includes('123-45'))).toBe(false);
  });

  it('carries the prior turns of the thread as history, trimmed, and the attachments on the input', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'ok' }], budget: { maxHistoryMessages: 2 } });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'first');
    await f.surface.say('U012', 'second', { attachments: [{ name: 'w9.pdf', path: 'w9.pdf' }] });
    const request = f.runtime.requests[1];
    expect(request.history).toEqual([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'ok' }]);
    expect(request.input).toEqual({ text: 'second', attachments: [{ name: 'w9.pdf', path: 'w9.pdf' }] });
  });

  it('stamps the skill on the run context when the runtime activates one', async () => {
    const f = await hostFixture(db, {
      trajectory: [
        { skill: 'credentialing-roster', version: '1.0.0' },
        { tool: 'harness_reconcile', args: { stale_after_minutes: 10 } },
        { say: 'done' },
      ],
    });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'roster please');
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.tool, 'harness_reconcile'));
    expect(audit).toMatchObject({ skill: 'credentialing-roster', skillVersion: '1.0.0' });
  });

  it('parks an action for approval with the thread on the row, and the turn ends normally', async () => {
    const f = await hostFixture(db, {
      trajectory: [
        { tool: 'harness_notify', args: { text: 'roster ready', idempotency_key: 'roster:1' } },
        { say: 'It is waiting for approval.' },
      ],
      principals: [{ ...COORDINATOR, level: 'member' }],
    });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'send the roster');
    const [parked] = await db.select().from(approvals);
    const [thread] = await db.select().from(threads);
    expect(parked).toMatchObject({ status: 'pending', requestedBy: 'u-coordinator', threadId: thread.id });
    expect(f.surface.texts.at(-1)?.text).toBe('It is waiting for approval.');
  });

  it('cancels a run in flight: no reply, status cancelled', async () => {
    const f = await hostFixture(db, { trajectory: [{ sleep: 10_000 }, { say: 'never' }] });
    attachMessageHandlers(f.host);
    const turn = f.surface.say('U012', 'slow one');
    await new Promise((r) => setTimeout(r, 50));
    const [run] = await db.select().from(runs);
    expect(cancelRun(f.host, run.id)).toBe(true);
    await turn;
    expect(f.surface.texts).toEqual([]);
    const [after] = await db.select().from(runs);
    expect(after.status).toBe('cancelled');
    expect(f.host.active.size).toBe(0);
    expect(cancelRun(f.host, run.id)).toBe(false);
  });

  it('records an error status and tells the human once when the runtime fails', async () => {
    const f = await hostFixture(db, { trajectory: [{ sleep: 10_000 }] });
    f.host.budget.timeoutMs = 20;
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'hang');
    const [run] = await db.select().from(runs);
    expect(run.status).toBe('error');
    expect(f.surface.texts).toHaveLength(1);
    expect(f.surface.texts[0].text).toContain('cancelled');
  });
});
```

The last case relies on the host aborting the request's signal on its own timeout (which the scripted runtime reports as `cancelled`); the host reads the event and records `error` because it was the timeout, not `cancelRun`, that fired. Keep the wording of the text it posts as `The run stopped: cancelled.` — see `runTurn` below.

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm --filter @harness/host test`
Expected: FAIL — `Cannot find module './conversation.js'`.

- [ ] **Step 4: Write the flow**

Create `harness/host/src/domain/conversation.ts`:

```ts
import { hashArgs, writeAudit, type RunStatus } from '@harness/core-tools';
import { containsRestrictedPattern } from '@harness/core-tools/redaction';
import type { Principal } from '@harness/identity-api';
import type { RunEvent, RunRequest } from '@harness/runtime-api';
import { describeError } from '@harness/shared';
import type { MessageEvent, MessageRef, StreamHandle, SurfaceSession } from '@harness/surface-api';
import type { Host } from './host.js';
import { openKernel } from './kernel.js';
import { WITHHELD, appendMessage, findOrCreateThread, recentHistory, type ThreadRow } from './threads/repository.js';
import { HISTORY_MAX_CHARS, trimHistory } from './threads/trim.js';

export const UNAUTHORISED_TEXT = 'You are not authorised to use this assistant.';

export interface TurnInput {
  thread: ThreadRow;
  principal: Principal;
  /** `user` for a human's message, `host` for a notice the host writes (an approval outcome). */
  role: 'user' | 'host';
  text: string;
  attachments: readonly { name: string; path: string }[];
  replyTo: MessageRef | null;
}

export interface TurnResult {
  runId: string;
  status: RunStatus;
  text: string;
}

/** Where the reply goes: a stream when the surface has one, else one post at the end. */
function replyTarget(surface: SurfaceSession, conversation: string, replyTo: MessageRef | null, recipient: string): StreamHandle | null {
  if (!surface.capabilities.streaming) return null;
  return surface.startStream(conversation, { replyTo: replyTo ?? undefined, recipient });
}

/**
 * One turn of a thread, from the text to the reply (spec 3.2 steps 3–6).
 *
 * Callable from an adapter's `onMessage` today and from an HTTP route in Plan 10: everything it
 * needs is on `host` and `turn`, and nothing it does depends on where the text came from. One
 * kernel per run, one `RunRequest` per run, the events forwarded as they arrive, both turns
 * recorded as `messages` rows, the run closed with the status it ended in. The skill the runtime
 * activates is stamped on the run's own context, which is what `auditBaseFor` reads (decision 6).
 */
export async function runTurn(host: Host, turn: TurnInput): Promise<TurnResult> {
  const surface = host.surfaces.find(turn.thread.surface);
  if (!surface) throw new Error(`thread ${turn.thread.id} is on surface "${turn.thread.surface}", which is not loaded`);
  const kernel = await openKernel(host, {
    principal: turn.principal,
    threadId: turn.thread.id,
    surface: turn.thread.surface,
    conversation: turn.thread.conversation,
  });
  const runId = kernel.context.runId;
  const controller = new AbortController();
  host.active.set(runId, controller);
  let cancelled = false;
  const timer = setTimeout(() => controller.abort(), host.budget.timeoutMs);

  await appendMessage(host.db, { threadId: turn.thread.id, runId, role: turn.role, principalId: turn.principal.id, content: turn.text });
  const history = trimHistory(await recentHistory(host.db, turn.thread.id, host.budget.maxHistoryMessages + 1), {
    maxMessages: host.budget.maxHistoryMessages,
    maxChars: HISTORY_MAX_CHARS,
  }).slice(0, -1); // the turn just appended is the input, not history

  const request: RunRequest = {
    runId,
    threadId: turn.thread.id,
    principal: turn.principal,
    input: { text: turn.text, attachments: turn.attachments },
    history,
    persona: host.persona,
    skills: host.skills,
    memory: '',
    tools: kernel.client,
    model: { ...host.model, user: turn.principal.id },
    budget: { maxModelCalls: host.budget.maxModelCalls, maxToolCalls: host.budget.maxToolCalls, timeoutMs: host.budget.timeoutMs },
    signal: controller.signal,
  };

  let status: RunStatus = 'done';
  let text = '';
  let stream: StreamHandle | null = null;
  const recipient = turn.principal.surfaces[turn.thread.surface] ?? '';
  try {
    for await (const event of host.runtime.run(request).events) {
      switch (event.type) {
        case 'text':
          stream ??= replyTarget(surface, turn.thread.conversation, turn.replyTo, recipient);
          stream?.append(event.delta);
          break;
        case 'skill_activated':
          kernel.deps.context.skill = event.name;
          kernel.deps.context.skillVersion = event.version;
          break;
        case 'done':
          text = event.text;
          break;
        case 'error':
          cancelled = event.message === 'cancelled' && host.active.get(runId) === undefined;
          status = cancelled ? 'cancelled' : 'error';
          text = cancelled ? '' : `The run stopped: ${event.message}.`;
          break;
        default:
          break;
      }
    }
  } catch (err) {
    host.log.error(`run ${runId} failed while reading the runtime`, err);
    status = 'error';
    text = 'The run stopped: the runtime failed; see the host log.';
  } finally {
    clearTimeout(timer);
    host.active.delete(runId);
  }

  // Invariant 10 on the final post: a reply that trips the check is withheld, not sent.
  const safeText = containsRestrictedPattern(text) ? WITHHELD : text;
  try {
    if (stream) {
      if (safeText === WITHHELD) stream.append(`\n${WITHHELD}`);
      await stream.end();
    } else if (safeText !== '') {
      await surface.postText(turn.thread.conversation, safeText, { replyTo: turn.replyTo ?? undefined });
    }
  } catch (err) {
    host.log.error(`run ${runId}: could not post the reply`, err);
  }
  if (status !== 'cancelled' && text !== '') {
    await appendMessage(host.db, { threadId: turn.thread.id, runId, role: 'assistant', principalId: turn.principal.id, content: text });
  }
  await kernel.close(status);
  return { runId, status, text: safeText };
}

/**
 * Spec 3.2 steps 1–2, then the turn. A user the identity plug-in does not know is told so, once,
 * and the refusal is the one audit row a message from nobody ever produces (invariant 1). A
 * message that did not address the assistant is ignored (decision 12).
 */
export async function handleMessage(host: Host, event: MessageEvent): Promise<void> {
  if (!event.mentioned) return;
  const surface = host.surfaces.find(event.surface);
  if (!surface) return;
  const principal = await host.identity.resolve({ surface: event.surface, userId: event.userId });
  if (!principal) {
    await writeAudit(host.db, {
      client: host.client,
      caller: `${event.surface}:${event.userId}`,
      tool: 'host_message',
      actionClass: 'read',
      argsHash: hashArgs({ conversation: event.conversation }),
      decision: 'unauthorised',
    });
    try {
      await surface.postText(event.conversation, UNAUTHORISED_TEXT, { replyTo: event.message ?? undefined });
    } catch (err) {
      host.log.error('could not post the unauthorised notice', err);
    }
    return;
  }
  const thread = await findOrCreateThread(host.db, {
    client: host.client,
    surface: event.surface,
    conversation: event.conversation,
    principalId: principal.id,
  });
  await runTurn(host, { thread, principal, role: 'user', text: event.text, attachments: event.attachments, replyTo: event.message });
}

/** Register the flow on every loaded surface. A handler's failure is logged, never thrown into the adapter. */
export function attachMessageHandlers(host: Host): void {
  for (const session of host.surfaces.all) {
    session.onMessage(async (event) => {
      try {
        await handleMessage(host, event);
      } catch (err) {
        host.log.error(`the message handler failed on surface "${session.name}": ${describeError(err)}`);
      }
    });
  }
}

/** Abort a run in flight. False when no such run is active. Plan 10's run API calls this. */
export function cancelRun(host: Host, runId: string): boolean {
  const controller = host.active.get(runId);
  if (!controller) return false;
  host.active.delete(runId);
  controller.abort();
  return true;
}
```

`writeAudit`'s `decision` is typed `Decision = 'auto' | 'approval' | 'blocked' | 'error'` in core-tools; widen it to include `'unauthorised'` in `harness/core-tools/src/domain/tooling/audit.ts` (the column is `text`, and spec 3.2 names this decision). `cancelRun` deletes the controller from `active` before aborting, which is how `runTurn` tells a cancel (`active` no longer holds the run when the `cancelled` event arrives) from a timeout (the run is still in `active`, so the status is `error` and the human is told).

- [ ] **Step 5: Run the flow tests green, the gates, commit**

Run: `pnpm --filter @harness/host test`, then the four gates and `pnpm test`.
Expected: all green; both snapshots unchanged.

Export `runTurn`, `handleMessage`, `attachMessageHandlers`, `cancelRun`, `UNAUTHORISED_TEXT`, `TurnInput`, `TurnResult` from `harness/host/src/index.ts` and `hostFixture`, `HOST_PRINCIPAL`, `COORDINATOR`, `MEMBER` from `testing.ts`.

```bash
git add harness/host harness/core-tools/src/domain/tooling/audit.ts
git commit -m "feat(host): run a conversation turn from a surface message, as the resolved principal, with cancel"
```

### Task 8: The resume hook and the host entrypoint

Spec 3.2 step 7 (decision 8): a decision on a card resumes the thread the action was parked
from, with one host-authored message. Then `app/main.ts`, the composition root of everything
this plan built, replacing the approvals entrypoint deleted in Task 5.

**Files:**
- Create: `harness/host/src/domain/resume.ts`, `resume.test.ts`, `harness/host/src/app/main.ts`
- Modify: `harness/host/src/index.ts`, `README.md`, `.env.example`, `clients/demo-practice/identity.yaml`

**Interfaces:**
- Consumes: `DecidedOutcome`, `DecisionDeps`, `registerApprovalHandlers`, `startRunner`, `collectHealth`, `startHealthServer`, `DEFAULT_HEALTH_BIND`, `surfaceSinks`, `loadSurfaces`, `createInProcessCoreToolsClient`, `postPendingApprovals` from `@harness/approvals`; `runTurn`, `attachMessageHandlers` from Task 7; `buildKernelConfig`, `loadIdentity`, `outRoot` from `@harness/core-tools`; `loadRuntime`, `readPersona`, `readSkillCatalogue` from Task 6.
- Produces:

  ```ts
  function resumeText(outcome: DecidedOutcome): string
  function resumeOnDecision(host: Host): (outcome: DecidedOutcome) => Promise<void>   // the onDecided hook
  function decisionDeps(host: Host, core: CoreToolsClient): DecisionDeps
  ```

---

- [ ] **Step 1: Write the failing resume test**

Create `harness/host/src/domain/resume.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { APPROVE_ACTION_ID, DECLINE_ACTION_ID, EDIT_FORM_ID, EDIT_NOTE_FIELD_ID, createInProcessCoreToolsClient, postPendingApprovals, registerApprovalHandlers } from '@harness/approvals';
import { approvals, messages, runs } from '@harness/db';
import { COORDINATOR, HOST_PRINCIPAL, hostFixture, useTestDb } from '../testing.js';
import { attachMessageHandlers } from './conversation.js';
import { decisionDeps, resumeText } from './resume.js';

const db = useTestDb();

/** A member asks for something a member cannot do alone; a lead decides on the card. */
async function parked() {
  const f = await hostFixture(db, {
    trajectory: (request) =>
      request.input.text.startsWith('Approval ')
        ? [{ say: `Understood: ${request.input.text.split('.')[0]}.` }]
        : [{ tool: 'harness_notify', args: { text: 'roster ready', idempotency_key: 'roster:1' } }, { say: 'Waiting for approval.' }],
    principals: [{ ...COORDINATOR, id: 'u-member', level: 'member', displayName: 'Member', surfaces: { memory: 'U345' } }, COORDINATOR, HOST_PRINCIPAL],
  });
  attachMessageHandlers(f.host);
  const core = createInProcessCoreToolsClient({ db, config: f.host.config, client: 'test', servicePrincipal: HOST_PRINCIPAL });
  registerApprovalHandlers(f.surface, decisionDeps(f.host, core));
  await f.surface.say('U345', 'send the roster');
  await postPendingApprovals({ db, surface: f.surface, client: 'test', now: f.host.now });
  const [row] = await db.select().from(approvals);
  expect(row.status).toBe('pending');
  return { f, row };
}

describe('resuming a thread after a decision', () => {
  it('approves, executes as the lead, and resumes the member thread with one host message', async () => {
    const { f, row } = await parked();
    await f.surface.press(APPROVE_ACTION_ID, row.id, 'U012');
    const [after] = await db.select().from(approvals);
    expect(after).toMatchObject({ status: 'executed', decidedBy: 'u-coordinator' });
    // The host's message and the runtime's answer are on the member's thread, in order.
    const rows = await db.select().from(messages).orderBy(messages.createdAt);
    expect(rows.map((r) => [r.role, r.principalId])).toEqual([
      ['user', 'u-member'],
      ['assistant', 'u-member'],
      ['host', 'u-member'],
      ['assistant', 'u-member'],
    ]);
    expect(rows[2].content).toBe(`Approval ${row.id} for harness_notify was approved by Coordinator and executed: delivery is queued in the effects outbox. Continue the workflow from here.`);
    expect(f.surface.texts.at(-1)?.text).toBe(`Understood: Approval ${row.id} for harness_notify was approved by Coordinator and executed: delivery is queued in the effects outbox.`);
    // Three runs: the member's turn, the lead's execution, the member's resumed turn.
    const all = await db.select().from(runs);
    expect(all.map((r) => r.principalId).sort()).toEqual(['u-coordinator', 'u-member', 'u-member']);
    expect(all.every((r) => r.status === 'done')).toBe(true);
  });

  it('declines with a note and resumes with the note', async () => {
    const { f, row } = await parked();
    await f.surface.press(DECLINE_ACTION_ID, row.id, 'U012');
    const rows = await db.select().from(messages).where(eq(messages.role, 'host'));
    expect(rows[0].content).toBe(`Approval ${row.id} for harness_notify was declined by Coordinator. Nothing was sent.`);
  });

  it('carries a decline note that passes the redaction check, and withholds one that does not', () => {
    const base = { status: 'declined', id: 'a1', action: 'forms_release' } as Parameters<typeof resumeText>[0]['row'];
    const decidedBy = COORDINATOR;
    expect(resumeText({ row: { ...base, decisionNote: 'Use the Q4 roster.' }, decidedBy })).toBe(
      'Approval a1 for forms_release was declined by Coordinator. Nothing was sent. Note: Use the Q4 roster.',
    );
    expect(resumeText({ row: { ...base, decisionNote: 'ssn 123-45-6789' }, decidedBy })).toBe(
      'Approval a1 for forms_release was declined by Coordinator. Nothing was sent. Note: (withheld: it did not pass the redaction check)',
    );
  });

  it('says execution failed when it did', () => {
    const row = { status: 'approved', id: 'a1', action: 'forms_release', decisionNote: null } as Parameters<typeof resumeText>[0]['row'];
    expect(resumeText({ row, decidedBy: COORDINATOR, execution: { status: 'failed', error: 'no payload' } })).toBe(
      'Approval a1 for forms_release was approved by Coordinator but execution failed: no payload. Nothing was sent.',
    );
  });

  it('does nothing for an approval parked outside a thread', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'never' }] });
    const [row] = await db
      .insert(approvals)
      .values({ client: 'test', action: 'x', payload: {}, summary: 's', requestedBy: 'svc-local', expiresAt: new Date(Date.now() + 60_000), idempotencyKey: 'k', status: 'approved', decidedBy: 'u-coordinator' })
      .returning();
    const { resumeOnDecision } = await import('./resume.js');
    await resumeOnDecision(f.host)({ row, decidedBy: COORDINATOR, execution: { status: 'executed', tool: 'x' } });
    expect(f.runtime.requests).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @harness/host test`
Expected: FAIL — `Cannot find module './resume.js'`.

- [ ] **Step 3: Write the resume module**

Create `harness/host/src/domain/resume.ts`:

```ts
import type { CoreToolsClient, DecidedOutcome, DecisionDeps } from '@harness/approvals';
import { containsRestrictedPattern } from '@harness/core-tools/redaction';
import { eq } from 'drizzle-orm';
import { threads } from '@harness/db';
import { runTurn } from './conversation.js';
import type { Host } from './host.js';
import { WITHHELD } from './threads/repository.js';

/**
 * The one host-authored message a decision puts on the thread (decision 15). It reports what
 * already happened — the execution ran before this is called — so the agent never has to guess
 * and never says an action succeeded while it is pending. A note or an error is free text from
 * the outside and gets the redaction check every other plaintext write gets.
 */
export function resumeText({ row, decidedBy, execution }: DecidedOutcome): string {
  const head = `Approval ${row.id} for ${row.action}`;
  const who = decidedBy.displayName;
  if (row.status !== 'declined') {
    if (execution?.status === 'executed') {
      return `${head} was approved by ${who} and executed: delivery is queued in the effects outbox. Continue the workflow from here.`;
    }
    const reason = execution?.status === 'failed' && !containsRestrictedPattern(execution.error) ? execution.error : 'see the audit log';
    return `${head} was approved by ${who} but execution failed: ${reason}. Nothing was sent.`;
  }
  const note = row.decisionNote ? ` Note: ${containsRestrictedPattern(row.decisionNote) ? WITHHELD : row.decisionNote}` : '';
  return `${head} was declined by ${who}. Nothing was sent.${note}`;
}

/**
 * The `onDecided` hook: find the thread the action was parked from and run one more turn on it,
 * as the thread's own principal, with the outcome as the input. An approval parked outside a
 * thread (the stdio server, the eval runner) has nothing to resume.
 */
export function resumeOnDecision(host: Host): (outcome: DecidedOutcome) => Promise<void> {
  return async (outcome) => {
    if (!outcome.row.threadId) return;
    const thread = await host.db.query.threads.findFirst({ where: eq(threads.id, outcome.row.threadId) });
    if (!thread) return;
    const principal = await host.identity.get(thread.principalId);
    if (!principal) {
      host.log.warn(`thread ${thread.id} belongs to principal "${thread.principalId}", which the identity plug-in no longer knows; not resumed`);
      return;
    }
    await runTurn(host, { thread, principal, role: 'host', text: resumeText(outcome), attachments: [], replyTo: null });
  };
}

/** The approvals package's dependency bag, from the host's. */
export function decisionDeps(host: Host, core: CoreToolsClient): DecisionDeps {
  return {
    db: host.db,
    surfaces: host.surfaces,
    core,
    identity: host.identity,
    client: host.client,
    now: host.now,
    onDecided: resumeOnDecision(host),
  };
}
```

- [ ] **Step 4: Run the resume tests green**

Run: `pnpm --filter @harness/host test`
Expected: PASS.

- [ ] **Step 5: Write the entrypoint**

Create `harness/host/src/app/main.ts`:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import {
  DEFAULT_HEALTH_BIND,
  collectHealth,
  createInProcessCoreToolsClient,
  loadSurfaces,
  registerApprovalHandlers,
  startHealthServer,
  startRunner,
  surfaceSinks,
} from '@harness/approvals';
import { buildKernelConfig, loadIdentity } from '@harness/core-tools';
import { outRoot } from '@harness/core-tools/storage';
import { createDb } from '@harness/db';
import { ConfigError, createLogger, envOrDefault, numberFromEnv, requiredEnv } from '@harness/shared';
import { attachMessageHandlers } from '../domain/conversation.js';
import type { Host } from '../domain/host.js';
import { readPersona } from '../domain/persona.js';
import { decisionDeps } from '../domain/resume.js';
import { loadRuntime } from '../domain/runtime/registry.js';
import { readSkillCatalogue } from '../domain/skills.js';

const log = createLogger('host');

// src/app -> src -> host -> harness -> <repo>. The same resolution the other entrypoints use.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

const seconds = (name: string, fallback: number): number => numberFromEnv(name, fallback, { min: 1, max: 86_400, unit: 'seconds' });
const port = (name: string, fallback: number): number => numberFromEnv(name, fallback, { min: 1, max: 65_535, integer: true });
const names = (raw: string): string[] => raw.split(',').map((n) => n.trim()).filter((n) => n !== '');

const { db, close: closeDb } = createDb();
const config = await buildKernelConfig(process.env);
const clientDir = path.join(repoRoot, 'clients', config.client);

// The three plug-ins, by name. Identity first: the host's own principal has to be declared.
const identity = await loadIdentity(envOrDefault('HARNESS_IDENTITY', '@harness/identity-static'), { env: process.env, log, clientDir });
const servicePrincipalId = envOrDefault('HARNESS_HOST_PRINCIPAL', 'svc-host');
const servicePrincipal = await identity.get(servicePrincipalId);
if (!servicePrincipal || servicePrincipal.kind !== 'service') {
  throw new ConfigError(`HARNESS_HOST_PRINCIPAL names "${servicePrincipalId}", which the identity plug-in "${identity.name}" does not declare as a service`);
}
const surfaces = await loadSurfaces(names(requiredEnv('HARNESS_SURFACES')), { env: process.env, log, storageDir: config.storageDir });
const runtime = await loadRuntime(envOrDefault('HARNESS_RUNTIME', '@harness/runtime-deepagents'), {
  env: process.env,
  log,
  databaseUrl: requiredEnv('DATABASE_URL'),
  storageDir: config.storageDir,
});

const host: Host = {
  db,
  config,
  client: config.client,
  identity,
  surfaces,
  runtime,
  persona: await readPersona(clientDir),
  skills: await readSkillCatalogue(config.packs.skillsDirs()),
  model: { baseUrl: config.gateway.baseUrl, apiKey: config.gateway.apiKey, route: 'chat', fallbackRoute: 'reason' },
  budget: {
    maxModelCalls: numberFromEnv('HARNESS_RUN_MAX_MODEL_CALLS', 30, { min: 1, max: 1_000, integer: true }),
    maxToolCalls: numberFromEnv('HARNESS_RUN_MAX_TOOL_CALLS', 60, { min: 1, max: 5_000, integer: true }),
    timeoutMs: seconds('HARNESS_RUN_TIMEOUT_S', 600) * 1000,
    maxHistoryMessages: numberFromEnv('HARNESS_HISTORY_MAX_MESSAGES', 40, { min: 0, max: 500, integer: true }),
  },
  servicePrincipal,
  log,
  now: () => new Date(),
  active: new Map(),
};

const core = createInProcessCoreToolsClient({ db, config, client: config.client, servicePrincipal });
const deps = decisionDeps(host, core);
for (const session of surfaces.all) registerApprovalHandlers(session, deps);
attachMessageHandlers(host);

const runner = startRunner(
  { db, surfaces, core, sinks: surfaceSinks(surfaces, { outDir: outRoot(config.storageDir) }), client: config.client, encryptionKey: config.encryptionKey, now: host.now },
  {
    pollMs: seconds('APPROVALS_POLL_SECONDS', 5) * 1000,
    dispatchMs: seconds('EFFECTS_DISPATCH_SECONDS', 5) * 1000,
    reconcileMs: seconds('RECONCILE_SECONDS', 300) * 1000,
    staleAfterMinutes: 10,
  },
);

const health = startHealthServer({
  port: port('APPROVALS_HEALTH_PORT', 8787),
  bind: process.env.APPROVALS_HEALTH_BIND?.trim() || DEFAULT_HEALTH_BIND,
  snapshot: () => collectHealth(db, config.client, runner, host.now),
});

for (const session of surfaces.all) await session.start();
log.info(
  `listening (client=${config.client}, principal=${servicePrincipal.id}, runtime=${runtime.name}, identity=${identity.name}, surfaces=${surfaces.all.map((s) => s.name).join(',')}, primary=${surfaces.primary.name} on ${surfaces.primary.defaultConversation}, skills=${host.skills.length})`,
);

async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} received, stopping`);
  try {
    for (const controller of host.active.values()) controller.abort();
    await runner.stop();
    await health.close();
    for (const session of surfaces.all) await session.stop();
    await runtime.stop();
    await identity.stop();
    await core.close();
    await closeDb();
    process.exit(0);
  } catch (err) {
    log.error('shutdown failed', err);
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
```

`model.route` and `model.fallbackRoute` are the kernel's `chat` and `reason` routes (spec decision 16); both exist in every `routing.yaml` the gateway renderer accepts.

- [ ] **Step 6: Document the variables, declare the host's principal, run the gates, commit**

In `.env.example` add after the `HARNESS_IDENTITY_FILE` block:

```
# --- Host --------------------------------------------------------------------
# Which runtime plug-in owns the loop, as a package name loaded at startup.
#HARNESS_RUNTIME=@harness/runtime-deepagents

# The host's own service identity, declared in clients/<HARNESS_CLIENT>/identity.yaml:
# reconciliation runs as it, and playbooks will from Plan 9. Must be a service.
#HARNESS_HOST_PRINCIPAL=svc-host

# Per-run ceilings the host hands the runtime. A run past any of them ends with an error the
# human sees; LiteLLM's daily budget is the other half of this.
#HARNESS_RUN_MAX_MODEL_CALLS=30
#HARNESS_RUN_MAX_TOOL_CALLS=60
#HARNESS_RUN_TIMEOUT_S=600

# How many prior turns of a thread the runtime is handed as history (also capped at 24,000
# characters). The runtime's own checkpoint carries the rest.
#HARNESS_HISTORY_MAX_MESSAGES=40
```

Reword the `HARNESS_PRINCIPAL` comment: "the stdio server's principal (the MCP inspector and the eval runner); the host uses HARNESS_HOST_PRINCIPAL". In `clients/demo-practice/identity.yaml` replace the `svc-approvals` entry with:

```yaml
  # The host's own identity (HARNESS_HOST_PRINCIPAL): reconciliation, and playbooks from Plan 9.
  - id: svc-host
    kind: service
    level: service
    displayName: Harness host
```

and reword the header comment's last paragraph: the two Slack member ids are placeholders until Plan 8b's Slack inbound; replace them with the real ids then. `svc-hermes` stays until Plan 8b. Write `harness/host/README.md`: what the process is, the three plug-ins and their variables, the flows, the loops, health, and the layout. Export `resumeText`, `resumeOnDecision`, `decisionDeps` from `harness/host/src/index.ts`.

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green; the env scan finds the six new names documented; both snapshots unchanged (Compose has not moved yet).

```bash
git add harness/host .env.example clients/demo-practice/identity.yaml
git commit -m "feat(host): resume a thread when a decision executes, and add the host entrypoint"
```

### Task 9: Compose runs the host in place of the approvals service

The `approvals` service becomes `host`: same image recipe, the host's command, the host's
variables. Hermes, `hermes-init` and the Hermes watchdogs stay until Plan 8b; the watchdogs are
pointed at the renamed service so the demo keeps working. The compose snapshot moves once.

**Files:**
- Modify: `harness/compose/docker-compose.yml`, `harness/compose/node.Dockerfile`, `docs/architecture/compose-surface.yaml` (re-recorded), `harness/core-tools/src/app/surface.test.ts`, `clients/demo-practice/scripts/harness-outbox-watchdog.sh`, `clients/demo-practice/scripts/harness-reconcile-watchdog.sh`, root `package.json` (`demo:logs`), `.env.example`

---

- [ ] **Step 1: Write the failing snapshot expectations**

In `harness/core-tools/src/app/surface.test.ts`, in "the files worker boundary", rename the case "is reached by the two services that spawn a core-tools child…" to "is reached by the two services that run core-tools, which tell it where the worker is" and iterate `['hermes', 'host']`. Add to "the Compose stack names no client and mounts no socket":

```ts
  it('runs the host, not an approvals process, and gives it the three plug-in names', async () => {
    const { services } = parseYaml(await rendered()) as { services: Record<string, { environment?: Record<string, string>; image?: string }> };
    expect(services.approvals).toBeUndefined();
    expect(services.host.image).toBe('harness-host');
    for (const name of ['HARNESS_SURFACES', 'HARNESS_IDENTITY', 'HARNESS_RUNTIME', 'HARNESS_HOST_PRINCIPAL']) {
      expect(services.host.environment?.[name], name).toBeDefined();
    }
    expect(services.host.environment?.SLACK_ALLOWED_USERS).toBeUndefined();
  });
```

Run: `pnpm --filter @harness/core-tools exec vitest run src/app/surface.test.ts` — Expected: FAIL on `services.host`.

- [ ] **Step 2: Rewrite the service**

In `harness/compose/docker-compose.yml` replace the whole `approvals:` service with:

```yaml
  # The one long-running harness process per client: the runtime, the surfaces and the identity
  # plug-in it loads by name, the approvals loops, and core-tools hosted in-process. Hermes still
  # serves Slack chat beside it until Plan 8b; the host serves approvals on Slack and chat on
  # whatever other surface HARNESS_SURFACES names.
  host:
    build:
      context: ../..
      dockerfile: harness/compose/node.Dockerfile
    image: harness-host
    profiles: ['demo']
    restart: unless-stopped
    networks:
      - default
      - files
    depends_on:
      postgres:
        condition: service_healthy
      litellm:
        condition: service_healthy
      files:
        condition: service_healthy
    # No env_file here, deliberately: an explicit allowlist interpolated from ../../.env, so
    # Hermes's Slack tokens never enter this container. Anything main.ts reads is listed here.
    environment:
      DATABASE_URL: 'postgres://harness:harness@postgres:5432/harness'
      HARNESS_ENCRYPTION_KEY: '${HARNESS_ENCRYPTION_KEY:-}'
      HARNESS_CLIENT: '${HARNESS_CLIENT:-demo-practice}'
      HARNESS_STORAGE_DIR: '/srv/harness-storage'
      HARNESS_PACKS: '${HARNESS_PACKS:-@harness/pack-healthcare}'
      HARNESS_SURFACES: '${HARNESS_SURFACES:-@harness/surface-slack}'
      HARNESS_IDENTITY: '${HARNESS_IDENTITY:-@harness/identity-static}'
      HARNESS_RUNTIME: '${HARNESS_RUNTIME:-@harness/runtime-deepagents}'
      HARNESS_HOST_PRINCIPAL: '${HARNESS_HOST_PRINCIPAL:-svc-host}'
      HARNESS_POLICY_FILE: '/srv/agent-harness/clients/${HARNESS_CLIENT:?set HARNESS_CLIENT in .env}/policy.yaml'
      HARNESS_GATEWAY_URL: 'http://litellm:4000'
      HARNESS_FILES_URL: 'http://files:8790'
      LITELLM_MASTER_KEY: '${LITELLM_MASTER_KEY:?set LITELLM_MASTER_KEY in .env}'
      HARNESS_RUN_MAX_MODEL_CALLS: '${HARNESS_RUN_MAX_MODEL_CALLS:-30}'
      HARNESS_RUN_MAX_TOOL_CALLS: '${HARNESS_RUN_MAX_TOOL_CALLS:-60}'
      HARNESS_RUN_TIMEOUT_S: '${HARNESS_RUN_TIMEOUT_S:-600}'
      HARNESS_HISTORY_MAX_MESSAGES: '${HARNESS_HISTORY_MAX_MESSAGES:-40}'
      # The approver's Slack app, until Plan 8b makes it the one app.
      APPROVALS_SLACK_BOT_TOKEN: '${APPROVALS_SLACK_BOT_TOKEN:-}'
      APPROVALS_SLACK_APP_TOKEN: '${APPROVALS_SLACK_APP_TOKEN:-}'
      SLACK_APPROVALS_CHANNEL: '${SLACK_APPROVALS_CHANNEL:-}'
      APPROVALS_POLL_SECONDS: '${APPROVALS_POLL_SECONDS:-5}'
      EFFECTS_DISPATCH_SECONDS: '${EFFECTS_DISPATCH_SECONDS:-5}'
      RECONCILE_SECONDS: '${RECONCILE_SECONDS:-300}'
      APPROVALS_HEALTH_PORT: '8787'
      APPROVALS_HEALTH_BIND: '${APPROVALS_HEALTH_BIND:-0.0.0.0}'
    ports:
      - '127.0.0.1:${APPROVALS_HEALTH_HOST_PORT:-8787}:8787'
    volumes:
      - storage:/srv/harness-storage
      - ../../packs:/srv/agent-harness/packs:ro
      - ../../clients:/srv/agent-harness/clients:ro
```

Update the file's header comment (the `demo` profile is `files`, `hermes-init`, `hermes`, `host`). In `harness/compose/node.Dockerfile` add `COPY runtimes ./runtimes` after `COPY surfaces ./surfaces` with a comment (the runtime plug-in `HARNESS_RUNTIME` names, a workspace dependency of `@harness/host`), rewrite the header comment (the host and its plug-ins; core-tools is hosted in-process, so the whole workspace is installed), and change the last line to `CMD ["pnpm", "--filter", "@harness/host", "start"]`. `hermes.Dockerfile` is untouched: the frozen install accepts a workspace copy that omits packages the lockfile lists (verified in Plan 7), that image installs `@harness/core-tools` whose new devDependency `@harness/runtime-api` is under `harness/` and already copied, and Plan 8b deletes the image. In both watchdog scripts change the default to `http://host:8787/healthz`. In the root `package.json` change `demo:logs` to `... logs -f hermes host`. In `.env.example`, reword the `HARNESS_SURFACES` and `APPROVALS_*` comments from "the approvals host" to "the host" and the `APPROVALS_HEALTH_BIND` note from `http://approvals:8787` to `http://host:8787`.

- [ ] **Step 3: Re-record, run the suite, commit**

Run: `pnpm surface:record` (needs `docker` on `PATH`; the stack need not be running), then `git diff docs/architecture/compose-surface.yaml` and confirm the diff is: the `approvals` service gone, `host` present with the environment above, `harness-host` image, nothing else. `tool-surface.json` unchanged. Then `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`.
Expected: all green.

```bash
git add harness/compose docs/architecture/compose-surface.yaml harness/core-tools/src/app/surface.test.ts clients/demo-practice/scripts package.json .env.example
git commit -m "feat(compose): run the host in place of the approvals service"
```

### Task 10: Documentation

**Files:**
- Modify: `ARCHITECTURE.md`, `CONTRIBUTING.md`, `README.md`, `docs/runbook.md`, `docs/demo.md`, `harness/core-tools/README.md`, `harness/approvals/README.md`, `docs/architecture/graph.svg`

---

- [ ] **Step 1: ARCHITECTURE.md**

- "The packages": add `harness/runtime-api` (the Runtime contract, `ScriptedRuntime`, the fake gateway and the conformance kit under `testing`), `runtimes/deepagents`, `harness/host` (the one process per client), and reword `harness/approvals` to "a library the host composes: cards, decisions, the poller, the sinks, the runner, health, the in-process core-tools client". Extend the one-line graph: `shared <- runtime-api <- { host, runtimes/* }`, `{ core-tools, approvals, runtime-api, identity-api, surface-api } <- host`, `host ..> { surfaces/*, identities/*, runtimes/* }` (runtime only).
- "Surfaces": the host is `@harness/host` now; `SurfaceSession` gains `onMessage`, `startStream`, `typing`, and the two capability flags; the "Allowlists are per surface" paragraph becomes "**Who may decide is the identity plug-in's answer.** A decision is accepted only from a principal of `kind: 'user'` at level `lead` or above, resolved from the surface user id on the surface the card was posted on; a service principal cannot approve. There is no allowlist and no bypass." Drop the "Secrets … child-env" paragraph: there is no child.
- "Identity": "the host per turn from Plan 8" becomes present tense; add that `decided_by` is a principal id.
- New section "## The host and the runtime" after "Identity": the process, the three plug-ins by name, the flow of one message (resolve → thread → run → kernel in-process → runtime → events → surface → messages rows → close), the contract's seven events and six rules, the Deep Agents runtime's shape (per-run agent, bridge, four file tools, `/skills/` and `/memories/`, schema `langgraph`), the budget, cancel, the approvals resume, `threads`/`messages`, and the group-chat rule. Cite decisions 1–23 of this plan where they explain a choice.
- "Where each cross-cutting concern lives": add rows for "who may talk to the assistant" (the identity plug-in, `handleMessage`), "the loop" (the runtime plug-in), "the conversation record" (`threads`/`messages`, the host).

- [ ] **Step 2: CONTRIBUTING.md**

- "Adding a surface": step 4 gains `onMessage`, `startStream` (or `streaming: false`), `typing`, and the capability table's two new columns; step 8 says `@harness/host`'s dependencies, not `@harness/approvals`'; the `secrets` sentence loses "the core-tools child" (no child exists; secrets still say which variables are credentials).
- New "## Adding a runtime": package under `runtimes/<name>` named `@harness/runtime-<name>`, `defineRuntime`, the six rules, run `runtimeConformance` with a harness, the dependency rule, `HARNESS_RUNTIME`.
- "Adding a pack", step 10: `hermes.config.yaml`'s env block is no longer where a variable has to be named for the host (it still is for Hermes until Plan 8b); `.env` alone reaches the host.

- [ ] **Step 3: README.md, runbook, demo**

- README "Layout": add `harness/runtime-api/`, `harness/host/`, `runtimes/`; reword `harness/approvals/` to "the approvals library the host composes"; the paragraph under it gains the runtime plug-in sentence. Line 6 ("Runtime: Hermes Agent…") becomes "Runtime: Deep Agents JS behind `@harness/runtime-api`, hosted by `@harness/host`; Hermes serves Slack chat until Plan 8b."
- `docs/runbook.md`: "The approvals host and its surfaces" becomes "The host and its surfaces" — the process is `@harness/host`, the loops are unchanged, "Allowlists are per surface" is replaced by the principal rule, the "Reconciliation goes through MCP" paragraph says in-process; "Health" changes `http://approvals:8787` to `http://host:8787`; "Runs and principals" replaces `svc-approvals` with `svc-host`, says every message from a person now runs as that person's principal on the host's surfaces, and that `runs.status` and `runs.caller` changed; add a "Threads and messages" subsection with one query (the last ten messages of a thread) and the note that restricted-looking content is withheld on write; "Onboarding a client" step 2 names `svc-host`.
- `docs/demo.md`: the smoke checklist's `approvals` container becomes `host`; step 5 restores skill attribution ("`skill` and `skill_version` on the audit rows are back: the runtime stamps the skill it activated"); the "Before you start" two-app table stays for Plan 8b to collapse.
- `harness/core-tools/README.md`: `buildKernelConfig` moved to `domain/tooling/config.ts`; the fake gateway moved to `@harness/runtime-api/testing`. `harness/approvals/README.md`: no entrypoint, no child, the in-process client, `identity` on `DecisionDeps`, `onDecided`.

- [ ] **Step 4: Regenerate the graph, run the gates, commit**

Run `pnpm arch:graph` if `which dot` prints a path. Then the four gates and `pnpm test`.

```bash
git add ARCHITECTURE.md CONTRIBUTING.md README.md docs harness/core-tools/README.md harness/approvals/README.md
git commit -m "docs: describe the runtime contract, the Deep Agents runtime and the host"
```

---

## Self-review

Run after the last task, against the spec's Plan 8 scope (this half); every row here was checked when the plan was written.

| Spec item | Task |
|---|---|
| 4.2 `RunEvent`, `RunRequest`, `RunHandle`, `RuntimeSession`, `RuntimeDeps`, `Runtime`, `defineRuntime` | 1 |
| 4.2 the six rules, tested by the conformance kit; `ScriptedRuntime` replays a trajectory file through `request.tools` (decision 21) | 2 (`runtimeConformance`, `readTrajectory`) |
| 4.3 `MessageEvent`, `StreamHandle`, `capabilities.streaming`/`inlineConfirm`, `onMessage`, `startStream`, `typing`; `allowedUsers` leaves the contract | 5 |
| 4.1 last paragraph: `SLACK_ALLOWED_USERS`/`MEMORY_ALLOWED_USERS` retired; a decision only from `lead`+ resolved on the card's surface; the memory surface resolves through the test's principals (Plan 7 deferral a; invariants 2, 3) | 5 (`handlers.test.ts`) |
| 5.3 `main.ts` composition root: env, `createDb`, `buildKernelConfig`, identity, surfaces, runtime, `onMessage` on every surface, approval handlers, runner, health, shutdown in reverse | 8 |
| 5.3 `threads/` (find-or-create, trimming), `conversation.ts`, `resume.ts`, `persona.ts`, `skills.ts`, the in-process client per run; `execute/` gains an in-process `CoreToolsClient` on the approver's principal | 6, 7, 8, 5 |
| 5.3 group conversations: only when `mentioned`; each turn as the writer's principal | 7 (decision 12) |
| 5.4 `createDeepAgent` with `ChatOpenAI` + `configuration.baseURL`, `user`, the fallback route, tools from the MCP client, persona + rules block, skills as progressive disclosure, memory seeded, `PostgresSaver` on schema `langgraph`, filesystem tools restricted, no `execute`, no subagents, `interruptOn` unset, events mapped, budget counted, signal honoured | 3 (decisions 3–9) |
| 5.4 the spike pins the versions and option names before any host code depends on them | Facts verified |
| 5.1 "the runtime stamps `skill` when it activates one" (Plan 7 deferral c) | 3 (`skill_activated`), 7 (stamped on `deps.context`) |
| 6 migration 0011: `threads`, `messages` with generated `tsv` and GIN, `approvals.thread_id`; `runs.caller` dropped (Plan 7 deferral b; decision 9 of Plan 7) | 4 |
| Decision 2: one host process, core-tools in-process over the MCP in-process transport, one `ToolDeps` per run; the stdio server stays for the inspector and evals | 6 (`openKernel`), 5 (`createInProcessCoreToolsClient`), 9 (`core-tools` build-only) |
| Decision 8: the parked action is the source of truth; on execution the host resumes the thread with one host-authored message; `interruptOn` unused | 8, 3 |
| Decision 9: kernel `threads`/`messages`; the checkpointer's own tables in `langgraph` | 4, 3 |
| Decision 16: `ChatOpenAI` on LiteLLM with `user` = principal id; `chat` primary, `reason` fallback | 3, 8 |
| Invariant 1: identity only from the host; a `MessageEvent` whose user resolves to no principal runs nothing | 7 (`refuses a user…`) |
| Invariant 2: decided by `(actionClass, principal.level)`, audited with the principal id; a service cannot approve | 5, 6 (`openKernel` audit), 7 |
| Invariant 4: every write that leaves the process goes through the outbox — the host posts replies itself (a reply is the surface's own message, not an effect) and stages nothing else | 7; unchanged kernel |
| Invariant 9: the runtime reaches tools only through the MCP client and reaches no filesystem | 3 (`bridge`, `seedFiles`, `READ_ONLY_FS_TOOLS`, `DENY_ALL_WRITES`), 2 (kit) |
| Invariant 10: restricted values never in `messages` or a `RunEvent`; the check runs on every host-side write | 6 (`appendMessage`), 7 (the final post), 8 (`resumeText`), 3 (fixed error messages) |
| Invariant 12: a cancelled run stops within one model call and records `status: 'cancelled'` | 3, 7 (`cancelRun`), 4 (`runs.status`) |
| Section 7 Compose: `host` replaces `approvals`; the stdio `core-tools` stays build-only | 9 (Hermes goes in Plan 8b) |
| Section 9: host tests boot the real kernel against `TEST_DATABASE_URL` with the memory surface, the static identity and the scripted runtime; the fake gateway learns scripted tool calls; the evals are unchanged | 7, 8, 1; `evals/src` untouched |
| Decision 20 vocabulary: `deepagents`/`langchain`/`langgraph` only under `runtimes/deepagents`; the runtime, the runtime contract and the host scanned | 3, 6 |
| 3.1 dependency rules: `runtime-api` imports only shared (and zod, the MCP client type); `runtimes/*` only the contract, shared and third-party; the host imports everything below and never a plug-in statically | 1, 3, 6 |

Deferred to Plan 8b, deliberately: the Slack adapter's `message`/`app_mention` inbound, attachments into `incoming/`, streaming on Slack, the one Slack app (`SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`, `APPROVALS_SLACK_*` retired), Hermes and `hermes-init` retired, `hermes.Dockerfile` deleted, the client folder cleanup (`hermes.config.yaml`, `cron/`, `scripts/`, `svc-hermes`), the scaffolder's template list, and the final Compose shape.

**Placeholder scan.** No "TBD", "TODO", "implement later", "similar to Task N" or "add appropriate …" anywhere; every code step carries the code; every path is exact.

**Type consistency.** `RunEvent`/`RunRequest`/`RuntimeSession` (Task 1) are what `ScriptedRuntime` implements (Task 2), `runDeepAgent` consumes (Task 3), and `runTurn` builds (Task 7); `RunPrincipal` (Task 1) is what `Principal` (identity-api) is assigned to in `runTurn`; `FakeReply.toolCalls` (Task 1) is what `run.test.ts` and `conformance.test.ts` script (Task 3); `toolServerFixture`/`fixtureRequest` (Task 2) are what `bridge.test.ts`, `run.test.ts` and the kit use (Task 3); `hashArgs` (Task 1, shared) is what `ScriptedRuntime`, the bridge and `handleMessage`'s audit row call; `KernelConfig` (core-tools) is what `testKernelConfig` returns (Task 6), `createInProcessCoreToolsClient` takes (Task 5), `Host.config` holds (Task 6) and `buildKernelConfig(env)` builds (Task 6, Task 8); `CoreToolsClient.execute(approvalId, principal)` (Task 5) is what `decideApproval` calls and `FakeCoreToolsClient` records; `DecidedOutcome` (Task 5) is what `resumeText`/`resumeOnDecision` take (Task 8); `DecisionDeps.identity`/`onDecided` (Task 5) are what `decisionDeps` fills (Task 8); `ThreadRow`, `appendMessage`, `recentHistory`, `WITHHELD` (Task 6) are what `runTurn` and `resumeOnDecision` use (Tasks 7, 8); `OpenedKernel.deps.context` (Task 6) is where `runTurn` stamps the skill (Task 7); `RunStatus`/`closeRun` (Task 4) are what `openKernel.close` and `withRun` call (Tasks 6, 5); `MemorySurface.say`/`streams` (Task 5) are what every host test drives (Tasks 7, 8); `Host.active`/`cancelRun` (Tasks 6, 7) are what `main.ts` drains on shutdown (Task 8).
