# Healthcare credentialing pack

Reusable content for a credentialing deployment: what to extract, what the
default policy is, and how to make test data.

| Path | What it is |
|---|---|
| `schema/provider.json` | The extraction manifest. See the `$comment` at the top for why it is a manifest and not a JSON Schema. |
| `policy.yaml` | The default action-class table. |
| `synthetic/generate.ts` | Twenty synthetic providers with four documents each, as text-layer PDFs and as scans, plus ground truth. |
| `evals/` | Case files the `@harness/evals` runner reads. |
| `skills/` | Placeholder. Skills land in Plan 3. |

Generate the synthetic corpus:

```bash
pnpm synth
```

Output goes to `synthetic/out/` and is gitignored: it is reproducible from the
seed, and twenty providers of PDFs do not belong in git.

**Everything in `synthetic/` is fabricated.** The NPIs are shaped like real ones
and will not resolve against NPPES, which is deliberate: the demo shows the
mismatch flag.
