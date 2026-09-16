# Pack-agnostic core — design (Plan 5)

**Date:** 2026-09-16
**Status:** approved in discussion; awaiting written review
**Baseline:** main after the Plan 4 merge (four layers, `@harness/shared`, `@harness/pack-api`, packs loaded via `HARNESS_PACKS`, 582 tests, public-surface snapshot)
**Predecessors:** `2026-09-15-agent-harness-credentialing-design.md` (the demo product), `2026-09-16-maintainability-revamp-design.md` (the layout and the pack contract)

## 1. Goal

The product is a foundation onto which project areas are plugged: medical
credentialing today, document scanning that produces stories and epics
tomorrow, others later. After Plan 4 the pack's *content* is pluggable
(manifest, document kinds, forms, skills, eval files) but core still *is* the
credentialing product: `providers`, `credentials`, `deadlines`, the payer
roster, the NPPES lookup and the 23-tool catalogue are credentialing concepts
living in `@harness/core-tools` and `@harness/db`, and the eval harness
hard-codes the healthcare pack.

After Plan 5:

- Core is the harness kernel plus a generic record model and a manifest-driven
  document pipeline. It contains no credentialing vocabulary; a grep rule and
  the pack contract tests enforce that.
- Everything credentialing-specific lives in `packs/healthcare` and reaches
  core only through the `Pack` contract, including the tools it contributes.
- The healthcare deployment behaves exactly as today: same tool names, same
  schemas, same outputs, same skills, proven by the public-surface snapshot.
- A second, minimal pack (`packs/stories`) exists and is exercised by the
  suite, so a core that still assumes healthcare fails the build.
- The eval harness evaluates whichever pack `HARNESS_PACKS` names.

Non-goals: new product features for either pack, changing the Hermes/LiteLLM/
compose runtime shape, changing the approvals app's Slack surface, renaming
the healthcare tools (aliases keep them).

## 2. Decisions taken in discussion

| Question | Decision |
|---|---|
| Who owns the schema for a pack's records | **Core keeps a generic record model**; packs declare record kinds and field manifests in the contract and ship no migrations. |
| Which tools stay in core | **Generic core + pack aliases**: core ships `documents_*`, `records_*`, `deadlines_*`, `approvals_execute`, `audit_query`, `harness_*`; the healthcare pack contributes `verify_*`, `forms_*` and thin `providers_*` aliases so nothing visible changes. |
| Proof of pack-agnosticism | **A small proof pack** (`packs/stories`) with one record kind, one document kind, one skill, a 3-document synthetic corpus and eval cases; exercised with `HARNESS_PACKS` naming both packs. |

## 3. The generic record model

One migration (`0008_generic_records`) replaces the credentialing tables with
a pack-typed model. Tables (all client-scoped, all under the existing
append-only audit rules):

| Table | Columns (beyond id, client, timestamps) | Replaces |
|---|---|---|
| `records` | `pack text`, `kind text`, `name text`, `external_id text NULL` (e.g. NPI), `status text` | `providers` |
| `fields` | `record_id`, `name`, `value text NULL`, `value_encrypted bytea NULL`, `restricted bool`, `confidence real NULL`, `status pending/extracted/verified/rejected`, `source_page int NULL`, `source_document_id NULL` | `fields` |
| `attachments` | `record_id`, `kind text` (pack-defined, e.g. `license`, `dea`, `epic_link`), `issuer`, `state`, `number_encrypted bytea NULL`, `issued_at`, `expires_at`, `properties jsonb` | `credentials` |
| `deadlines` | `record_id`, `attachment_id NULL`, `kind text`, `due_at`, `lead_days int`, `status` | `deadlines` (same shape, re-keyed) |
| `documents` | unchanged, plus `record_id NULL` in place of `provider_id` | `documents` |

Rules that do not change: restricted values only in `bytea` columns; the
verified-field preservation rule; the client-scoped idempotency key on
approvals; the partial unique index on pending approvals; `tool_effects`,
`audit_log`, `model_calls`, `runs` untouched.

Data migration: the healthcare rows are copied once (`providers → records
(pack='healthcare', kind='provider', external_id=npi)`, `credentials →
attachments`, foreign keys re-pointed) inside the same migration, generated
with plain `drizzle-kit generate` and a hand-written data section, then the old
tables are dropped. The demo database is synthetic, so the migration is
verified on a copy of it in the migration test.

## 4. The `Pack` contract, extended

```ts
export interface Pack {
  name: string;
  version: string;
  records: RecordKindSpec[];          // NEW: kinds a pack stores, with field manifests
  documentKinds: readonly string[];
  extraction: ExtractionManifest;     // per document kind → target record kind + fields
  attachments?: AttachmentKindSpec[]; // NEW: kinds with expiry rules (lead days)
  formsDir?: string;                  // now optional
  skillsDir: string;
  policy: Partial<Policy>;
  tools?: (deps: ToolDeps) => AnyToolDef[];   // typed now, not unknown
  evals?: PackEvals;                  // NEW shape, see §7
}
export interface RecordKindSpec { kind: string; label: string; fields: ManifestField[]; nameField: string; externalIdField?: string }
export interface AttachmentKindSpec { kind: string; label: string; leadDays: number; numberRestricted: boolean; properties: string[] }
```

`@harness/pack-api` gains `defineRecordKind`, `defineAttachmentKind` and the
zod schemas for both; `definePack` validates that every extraction target
names a declared record kind and every attachment kind named by a manifest is
declared.

## 5. Core tools (generic)

| Tool | Class | Replaces |
|---|---|---|
| `documents_ingest/get/list/classify/extract` | as today | unchanged names; extract writes to a record of the manifest's target kind |
| `records_upsert` `{ kind, name, external_id?, fields, attachments }` | write.internal | `providers_upsert` |
| `records_get` `{ record_id }` (masked restricted values) | read | `providers_get` |
| `records_search` `{ kind?, name?, external_id? }` | read | `providers_search` |
| `records_confirm_field` `{ record_id, name, value }` | write.internal | `providers_confirm_field` |
| `records_list_pending` `{ kind? }` | read | `providers_list_pending` |
| `deadlines_compute` `{ record_id }`, `deadlines_upcoming` `{ within_days }` | as today | unchanged, keyed on attachments |
| `approvals_execute`, `audit_query`, `harness_set_context/reconcile/notify` | as today | unchanged |

Every core tool takes `kind` values from `deps.packs`; core validates them
against the declared record kinds and never hard-codes one.

## 6. The healthcare pack after the move

`packs/healthcare/src/` gains `domain/` folders for what leaves core:
`verify/` (NPPES client, name matching), `forms/` (templates, fill, roster,
release), `credentials/` (the credential-kind specs and lead days). Its
`tools(deps)` contributes: `verify_nppes`, `verify_state_license`,
`forms_list_templates`, `forms_fill`, `forms_roster`, `forms_release`, and the
aliases `providers_upsert/get/search/confirm_field/list_pending`, each a
`defineTool` that fixes `kind: 'provider'` and calls the core `records_*`
handler through `deps.tools` (the registry map), so schemas and outputs stay
byte-identical. The surface snapshot for `HARNESS_PACKS=@harness/pack-healthcare`
must not change.

The pack's skills, SOUL rules, policy, forms and synthetic corpus stay where
they are. `isRestrictedName` and the redaction tiers stay in core (they are
data-protection primitives, not domain knowledge); the pack's manifest marks
which fields are restricted, as today.

## 7. Evals from the contract

`Pack.evals` becomes:

```ts
interface PackEvals {
  casesFile: string; injectionFile?: string;
  intakeSkill: string;            // SKILL.md whose frontmatter declares the tool set
  judgedFields: readonly string[]; // free-text fields the LLM judge may score
  generate?: string;               // module exporting generate(options) for the corpus
}
```

`@harness/evals` imports no pack. `openPipeline` loads `HARNESS_PACKS`;
`INTAKE_DECLARED_TOOLS`, `FREE_TEXT_FIELDS`, the default corpus, cases and
injection paths all come from the loaded pack; `pnpm evals -- --pack <name>`
selects one when several are loaded. The report gains `pack` and
`record_kinds` fields; the promotion gate is per pack.

## 8. The proof pack: `packs/stories`

A deliberately tiny pack whose only job is to keep core honest:

- record kind `epic` (fields: `title`, `summary`, `owner`, `target_quarter`;
  none restricted) and attachment kind `source_link` (no expiry);
- document kind `meeting_notes`; extraction manifest maps notes → an epic;
- one skill `stories-intake` (ingest → classify → extract → confirm);
- synthetic corpus: 3 text-layer documents from `synthetic/generate.ts` using
  `@harness/shared`; eval cases and one injection case;
- no forms, no verify tools, no restricted fields.

The suite runs the core-tools and evals tests once with
`HARNESS_PACKS=@harness/pack-healthcare,@harness/pack-stories` and asserts:
both packs load, `records_*` work for both kinds, the healthcare tool surface
is unchanged, and the stories intake produces an epic record from its corpus
through the fake gateway. dependency-cruiser gains
`core-never-names-a-pack-kind` (no `provider|credential|license|npi` tokens in
core-tools source outside tests) as a grep-style rule in CI.

## 9. Proof of behaviour preservation

- `docs/architecture/tool-surface.json` for the healthcare pack is byte-
  identical before and after (the aliases and contributed tools produce the
  same names, input and output schemas).
- Every existing healthcare test keeps its assertions; the tests that create
  providers directly through the DB move to the pack's test folder and use the
  records model through the alias tools.
- The migration test loads a snapshot of the demo database (synthetic data),
  runs `0008`, and asserts row counts and a sample of decrypted values match.
- The four healthcare skills run unchanged against the fake gateway in the
  evals smoke test.

## 10. Migration order (tasks)

1. `@harness/pack-api`: extended contract (`records`, `attachments`, typed
   `tools`, `PackEvals`), `defineRecordKind`/`defineAttachmentKind`, tests.
2. `@harness/db`: migration `0008_generic_records` with the data copy; schema
   in `domain/`; migration test on the demo snapshot.
3. core-tools `domain/records` (repository, mask, types) replacing
   `domain/providers`; `records_*` tools; `deadlines` re-keyed on attachments;
   `documents_extract` writing to the manifest's target kind.
4. healthcare pack: `verify/`, `forms/`, `credentials/` domains and the
   `tools(deps)` contribution with the `providers_*` aliases; core loses
   `domain/verify`, `domain/forms`, the credential specs; surface snapshot
   proven identical.
5. evals from the contract; `--pack` flag; report fields.
6. `packs/stories` proof pack, the dual-pack suite run, the vocabulary rule.
7. Docs: ARCHITECTURE (kernel vs pack boundary), CONTRIBUTING "Adding a pack"
   rewritten around record kinds, both pack READMEs, runbook migration note.

Process: subagent-driven development as before (worktree, ledger, task
reviews, one final review and fix wave, simplifier pass), merged to main when
green.

## 11. Open items deliberately left out

- The approvals app stays generic already (cards render from payloads); no
  change.
- A `records_delete`/archive tool: not needed by either pack yet.
- Per-pack policy merging (`Pack.policy` carried, not merged): unchanged
  from Plan 4's ruling.
