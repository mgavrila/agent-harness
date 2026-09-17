# @harness/surface-api

The contract between the approvals host and a messaging surface. A surface is Slack today,
Telegram or Microsoft Teams tomorrow; the host is written against this package and never
against one of them.

It depends on `@harness/shared` and zod and on nothing else in the workspace, which is what lets
the host load an adapter by name at runtime instead of importing it at build time.

| Module           | Holds                                                                        |
| ---------------- | ---------------------------------------------------------------------------- |
| `src/types.ts`   | every declaration: `Card`, `Form`, `MessageRef`, `SurfaceSession`, `Surface` |
| `src/surface.ts` | `defineSurface`, `allowsUser`, `parseAllowedUsers`                           |
| `src/models.ts`  | the zod shapes of the two outbox payloads, and the two id patterns           |
| `src/testing.ts` | `MemorySurface`, reached as `@harness/surface-api/testing`                   |

`CONTRIBUTING.md`, "Adding a surface", is the worked how-to.
