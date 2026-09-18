---
name: knowledge-sync
description: Refresh the knowledge base from this deployment's knowledge folder and report only what needs a human.
version: 1.0.0
---

# Refresh the knowledge base

Call `knowledge_sync` once. It re-reads the deployment's knowledge folder: documents that are new
or have changed are indexed again, and a document whose file is gone stops being searchable.

Then decide whether a human needs to hear about it.

- If `skipped` is empty, reply with the single line `Nothing to report.` and call nothing else. A
  routine refresh is not news.
- If `skipped` is not empty, stage one notice with `harness_notify` listing each skipped path and
  its reason, one per line, and then reply with the single line `Nothing to report.` A skipped
  document is a file somebody has to edit, and it will be skipped again tomorrow until they do.

Report nothing else, call no other tool, and never quote the contents of a document.
