# Healthcare credentialing pack

Reusable content for a credentialing deployment: what to extract, what the
default policy is, and how to make test data.

| Path                    | What it is                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `schema/provider.json`  | The extraction manifest. See the `$comment` at the top for why it is a manifest and not a JSON Schema.   |
| `policy.yaml`           | The default action-class table.                                                                          |
| `synthetic/generate.ts` | Twenty synthetic providers with four documents each, as text-layer PDFs and as scans, plus ground truth. |
| `evals/`                | Case files the `@harness/evals` runner reads.                                                            |
| `skills/`               | The four credentialing skills, each a `SKILL.md` with Hermes frontmatter plus the harness keys.          |

## Which numbers reach a model

SSN, EIN and DEA numbers are replaced with placeholders by the redaction pass
before any document text is put in a prompt, and stored encrypted on the
provider record straight from that pass. Licence, registration and policy
numbers are **not** redacted — blanking every nine-digit string would blank the
fields this pipeline exists to read — so they stay in the document text the
model sees. They are never requested as fields and never extracted, so nothing
writes them to a record. `number_restricted` in the manifest is reserved for
the day something does; today it is read by nothing.

Generate the synthetic corpus:

```bash
pnpm synth
```

Output goes to `synthetic/out/` and is gitignored: it is reproducible from the
seed, and twenty providers of PDFs do not belong in git.

**Everything in `synthetic/` is fabricated.** The NPIs are shaped like real ones
and will not resolve against NPPES, which is deliberate: the demo shows the
mismatch flag.
