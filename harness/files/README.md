# @harness/files

The parsing worker: an untrusted PDF or image is turned into text here, in a process that holds
no encryption key, no database URL and no provider credential, on a Compose network that routes
nowhere. core-tools reaches it through its `DocumentParser` seam (`remoteParser`, when
`HARNESS_FILES_URL` is set) and does the redaction itself on what comes back.

```
POST /extract  { "path": "incoming/scan.pdf" }      path is relative to HARNESS_STORAGE_DIR
200            { "pages": [{ "num": 1, "text": "…" }], "text": "…", "ocrUsed": false }
GET  /healthz  { "ok": true }
```

`pdftotext` reads the text layer (page count from `pdfinfo`); when the document has fewer than
40 characters per page on average it is rasterised page by page with `pdftoppm` and read with
`tesseract`, exactly as core-tools' own `localParser` does. An image is read with `tesseract`
directly. A path that is absolute, or resolves outside the storage root through `..` or a
symlink, is refused with `403` before anything is read.

| Variable              | Meaning                                                     |
| --------------------- | ----------------------------------------------------------- |
| `HARNESS_STORAGE_DIR` | the storage root; required, absolute                        |
| `HARNESS_FILES_PORT`  | listen port, default `8790`                                 |
| `HARNESS_FILES_BIND`  | listen address, default `127.0.0.1`; Compose sets `0.0.0.0` |

Error bodies are `{ "error": "…" }` and name a file's basename at most, never a path and never a
line of the page: the message ends up in `audit_log.error` on the core-tools side.

```bash
pnpm --filter @harness/files test      # the OCR cases skip when poppler or tesseract is missing
HARNESS_STORAGE_DIR=/srv/harness-storage pnpm --filter @harness/files start
```
