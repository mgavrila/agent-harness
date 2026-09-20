# @harness/config-files

A `ConfigSource` that reads a client document from `HARNESS_CLIENTS_DIR/<id>/client.yaml`, one
sub-directory per tenant, in a directory outside this repository. The `!include` tag pulls the
long strings — the persona and each skill — out into markdown files beside the document, so a
person edits `persona.md` rather than an indented block inside YAML. When a client directory
holds a `blueprint.yaml` and an `overlay.yaml` instead, the two are resolved on load under the
blueprint's lock set, and the resolved document is what the host is handed.
