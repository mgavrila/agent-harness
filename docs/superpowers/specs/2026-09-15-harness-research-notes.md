# Research notes: what recent harness papers change in this design

Date: 2026-09-15. Four papers read in full (text extracted from the PDFs), each
assessed against the Plan 1 code and the Plan 2/3 design. Evidence is
discounted where it comes from coding benchmarks only.

| Paper | What it is | Evidence quality for us |
|---|---|---|
| Cordon: Semantic Transactions for Tool-Using LLM Agents (2606.17573) | Runtime that stages tool effects, validates lineage and authority as a unit, then commits or aborts | Strong: 45/45 risky workflows contained vs 14/45 for stacked defenses; +22% latency; rollback correctness measured |
| Self-Harness: Harnesses That Improve Themselves (2606.09498) | Loop: mine failure traces, propose minimal harness edits, accept only if neither split regresses | Weak for us: coding benchmarks only, no ablation, no human-engineered baseline |
| Managing Procedural Memory in LLM Agents (2606.23127) | SKILL.md as versioned procedural memory; evolve from traces with a promotion margin | Medium: office/coding tasks, pytest verifiers; explicitly not validated on healthcare |
| Harness Updating Is Not Harness Benefit (2605.30621) | Separates the ability to propose harness updates from the ability to benefit from them | Medium: 7 models x 3 benchmarks; the adherence-decay finding is the useful part |

## A. Changes to the Plan 1 code (hardening, small, high confidence)

1. **One transaction for internal writes.** Wrap the handler and its audit row
   in `db.transaction` for tools whose effects are Postgres writes. Widen `Db`
   to `PgDatabase<NodePgQueryResultHKT, typeof schema>` so a transaction
   handle type-checks where `Db` is expected. Source: Cordon's commit
   discipline; closes the deferred Plan 1 gap.
2. **Effects outbox for external side effects.** New table `tool_effects`
   (id, run_id, tool, sink, idempotency_key, payload_encrypted, status
   `staged|dispatching|dispatched|failed|cancelled`, created_at,
   dispatched_at). A tool that sends to Slack or writes a file stages a row
   in the same transaction as its local writes; dispatch happens after
   commit, keyed by idempotency; a crash leaves a `dispatching` row instead of
   a silent gap. Source: Cordon's staged-effects outbox. Needed before Plan 3
   adds Slack and PDF outputs.
3. **Atomic approval execution.** `approvals_execute` transitions the row with
   one statement: `UPDATE approvals SET status='executing' WHERE id=$1 AND
   status='approved' AND expires_at > now()` and proceeds only if a row was
   updated. A sweep job flips expired `pending` rows to `expired`. Source:
   Cordon's authority-bound-to-a-time-window invariant; closes the lazy
   expiry race.
4. **Reconciliation job.** On startup and on a schedule: `dispatching`
   effects with no idempotency confirmation go to a manual review list
   (posted to Slack); `approved` rows never executed are resumed via their
   idempotency key; `pending` past expiry are expired. Source: Cordon's
   crash-recovery case split.
5. **Cost columns on audit rows.** Add `input_tokens`, `output_tokens`,
   `cost_usd`, `skill`, `skill_version` to `audit_log` (nullable; the runtime
   fills them in Plan 3). Source: procedural-memory paper's own token table
   shows "refined" skills sometimes cost more; measure, do not assume.
6. **Derivation pointer, not a lineage graph.** Add nullable
   `derived_from` (array of audit_log ids) to `audit_log`; a tool may declare
   which earlier results its arguments came from. Cheap; enables the one
   check per-call policy cannot do (an external send built from a
   `financial`-class read). Source: Cordon, deliberately reduced.
7. **Static robustness rules in SOUL and skills.** "Verify before
   concluding", a loop breaker after N consecutive tool errors, and a
   redirect instruction on tool error. These were the edits Self-Harness
   kept accepting across every model and benchmark; adopt them as static
   text, no loop needed.

## B. Design rules for Plans 2 and 3 (process, not code)

8. **Promotion gate = measured delta with the serving model.** A skill or
   memory change is promoted only if its pass rate on a held-out eval slice,
   run with the model that will serve it, does not regress on either split
   and improves on at least one. Store base score, post score, delta, eval
   set version in the promotion record. Source: Self-Harness acceptance rule
   plus the harness-benefit finding that benefit depends on the consumer
   model, not the proposer.
9. **Generation is free, application is gated.** Let the runtime draft
   candidate skill and memory edits with a cheap model (proposal quality is
   flat across model tiers). Never auto-apply. Application is an
   `approval`-class action with its own audit row referencing the generation
   event.
10. **Never evolve a shared pack skill from one client's traces.** Narrow
    sourcing overfits in every framework tested; a role-tuned skill reused
    elsewhere lost 5 to 7 points. Client-specific failures change only the
    client override. Pack changes require evidence from several contexts, and
    that evidence is redacted case shapes and outcomes, never raw traces,
    because raw traces carry PHI.
11. **Skill frontmatter gains `parent_version`, `eval_status`,
    `promoted_by`, and a change record** (mechanism targeted, surface edited,
    expected effect, regression risk). Rejected candidates stay as inactive
    files. Source: procedural-memory lineage schema plus Self-Harness audit
    record.
12. **Measure adherence, not just outcomes.** Per skill per run: was the
    skill loaded, were its required steps followed in order. Adherence decays
    over long trajectories even for strong models; offline pass/fail misses
    it. Eval cases for multi-step workflows assert intermediate steps (for
    example, license verification ran before roster generation), not only
    the final output.
13. **Full-suite regression sweeps on a schedule.** Per-change deltas say
    nothing about cumulative drift across many promotions; a weekly full eval
    run is a rollback trigger on its own.
14. **Hard invariant:** no self-modification path may touch eval scripts,
    the audit log, or the policy and approval logic.

## C. Explicitly not adopting

- A shadow filesystem or copy-on-write workspace (Cordon): our mutable
  state is Postgres, which already has transactions.
- A general lineage graph engine or a validation DSL: over-sized for a
  threat model of "does this write need a human".
- A separate transaction-manager service over gRPC: one process is enough.
- Unattended promotion on a numeric margin (both self-improvement papers):
  a pass rate cannot certify a compliance regression.
- Cross-client trace pooling into a shared skill body (SkillClaw pattern):
  a PHI leakage vector by construction.
- Context-specific skill adapters: the paper itself leaves them unevaluated.
- Running the Self-Harness search loop against anything but a synthetic,
  de-identified sandbox.

## Hermes self-improvement settings implied by the above

- Proposal generation (post-turn review drafting): on, cheap model.
- Skill writes: `skills.write_approval: true`, plus the promotion gate.
- Memory writes: approval plus a PHI scrub check before commit, not logging
  after the fact.
- DSPy/GEPA prompt optimization: output routed through the same promotion
  queue; its internal score is never the production gate.
- Adherence and cost telemetry: on, always.
