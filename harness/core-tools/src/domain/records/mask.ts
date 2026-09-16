import { attachments, encrypt, fields } from '@harness/db';
import type { RecordAttachmentView, RecordFieldView } from '@harness/pack-api';
import { MASKED } from '../../shared/redaction/names.js';

/**
 * A field value belongs in exactly one column: plaintext when it may be read back, encrypted
 * when it may not. Never both, so that masking a value cannot leave a readable copy behind.
 */
export function fieldValueColumns(value: string, restricted: boolean, key: Buffer) {
  return {
    value: restricted ? null : value,
    valueEncrypted: restricted ? encrypt(value, key) : null,
  };
}

/** A field as a caller sees it. A restricted value is reported as masked, never decrypted. */
export function maskField(f: typeof fields.$inferSelect): RecordFieldView {
  return {
    name: f.name,
    value: f.restricted ? MASKED : f.value,
    restricted: f.restricted,
    confidence: f.confidence,
    status: f.status,
    source_page: f.sourcePage,
  };
}

/**
 * An attachment as a caller sees it. The number is never returned, only whether one is on file.
 *
 * `issued_at` and `properties` are here and were not on the credential view this replaces: a
 * pack's form templates read the issue date, and a pack that can no longer run its own SQL has
 * no other way to reach either.
 */
export function maskAttachment(a: typeof attachments.$inferSelect): RecordAttachmentView {
  return {
    id: a.id,
    kind: a.kind,
    issuer: a.issuer,
    number: a.numberEncrypted ? MASKED : null,
    state: a.state,
    issued_at: a.issuedAt,
    expires_at: a.expiresAt,
    properties: a.properties,
  };
}
