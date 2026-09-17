import {
  parseAttachmentKind,
  parseExtractionManifest,
  parseRecordKind,
  type AttachmentKindSpec,
  type RecordKindSpec,
} from '@harness/pack-api';
import { isRestrictedName } from '../../shared/redaction/names.js';

export { type ExtractionManifest, type ExtractionTarget, type ManifestField } from '@harness/pack-api';

/**
 * Validate a pack's record kind against this build's restricted-name rules. The shape check
 * lives in `@harness/pack-api` so a pack can be typed against it; the rule that decides which
 * names are encrypted stays here, and is handed in.
 */
export function parseRecordKindSpec(raw: unknown): RecordKindSpec {
  return parseRecordKind(raw, { isRestrictedName });
}

export function parseAttachmentKindSpec(raw: unknown): AttachmentKindSpec {
  return parseAttachmentKind(raw);
}

export { parseExtractionManifest };
export type { AttachmentKindSpec, RecordKindSpec };
