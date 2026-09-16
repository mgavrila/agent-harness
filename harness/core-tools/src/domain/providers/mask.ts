import { credentials, encrypt, fields } from '@harness/db';
import { MASKED } from '../../shared/redaction/names.js';

/**
 * A field value belongs in exactly one column: plaintext when it may be read
 * back, encrypted when it may not. Never both, so that masking a value cannot
 * leave a readable copy behind.
 */
export function fieldValueColumns(value: string, restricted: boolean, key: Buffer) {
  return {
    value: restricted ? null : value,
    valueEncrypted: restricted ? encrypt(value, key) : null,
  };
}

/** A field as a caller sees it. A restricted value is reported as masked, never decrypted. */
export function maskField(f: typeof fields.$inferSelect) {
  return {
    name: f.name,
    value: f.restricted ? MASKED : f.value,
    restricted: f.restricted,
    confidence: f.confidence,
    status: f.status,
    source_page: f.sourcePage,
  };
}

/** A credential as a caller sees it. The number is never returned, only whether one is on file. */
export function maskCredential(c: typeof credentials.$inferSelect) {
  return {
    id: c.id,
    kind: c.kind,
    issuer: c.issuer,
    number: c.numberEncrypted ? MASKED : null,
    state: c.state,
    expires_at: c.expiresAt,
  };
}
