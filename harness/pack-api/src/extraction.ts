import * as z from 'zod/v4';
import { ConfigError } from '@harness/shared';
import { ATTACHMENT_PROPERTIES } from './records.js';

/** Matches every document kind no other target claims. */
export const ANY_DOCUMENT_KIND = '*';

/**
 * Every member of one attachment object in the model-facing extraction schema: the three the
 * kernel always asks for, and the four columns the record model stores.
 */
export const ATTACHMENT_SLOTS = ['kind', 'confidence', 'source_page', ...ATTACHMENT_PROPERTIES] as const;
export type AttachmentSlot = (typeof ATTACHMENT_SLOTS)[number];

/**
 * Where one family of documents lands.
 *
 * Before this existed, a pack had one flat manifest and every document wrote a provider. A
 * target is what makes `documents_extract` generic: the kernel resolves the document's kind to
 * a target, builds the model-facing schema from the target record kind's fields, and writes the
 * result to a record of that kind. The three strings are agent- and model-visible prose, so the
 * pack owns them: the kernel supplies only the injection rules that must not be overridable.
 */
export interface ExtractionTarget {
  /** Document kinds this target claims. `'*'` claims everything no other target named. */
  document_kinds: readonly string[];
  /** A record kind the same pack declares. `definePack` checks it. */
  record_kind: string;
  /** Sent as `response_format.json_schema.name`. */
  schema_name: string;
  /**
   * The JSON property the model returns its attachment list under. `credentials` for
   * healthcare, because that is the word the prompt uses and the word the published schema has
   * always carried; `links` for the stories pack. The kernel's own vocabulary is `attachments`
   * and this is the one place the pack's word reaches the wire.
   */
  attachments_key: string;
  /** The imperative line that opens the extraction turn. */
  instruction: string;
  /**
   * The **prompt** sentence describing which attachments to list, written into the user turn by
   * `buildExtractionMessages`. Omit for a target with no attachments.
   */
  attachment_instruction?: string;
  /**
   * The **JSON-Schema** `description` of the attachment array, sent to the model inside
   * `response_format`. A separate string from `attachment_instruction` on purpose: today's
   * healthcare pipeline puts different text in the two places, and the `response_format` bytes
   * are part of what this plan must not change. Omit for a target with no attachments.
   */
  attachment_schema_description?: string;
  /**
   * What the model is told each member of one attachment object means, keyed by
   * `ATTACHMENT_SLOTS`. Any slot left out keeps the kernel's own colourless wording.
   *
   * The prose is the pack's because the kernel has no word for what hangs off a record:
   * "credential" is healthcare's noun for it, "link" is the stories pack's, and the module that
   * stores the row is not the one that should be picking. These strings go out inside
   * `response_format`, so they are part of what the model reads.
   */
  attachment_descriptions?: Partial<Record<AttachmentSlot, string>>;
}

/**
 * What a pack's documents are and what comes out of them.
 *
 * `role` is the first line of every prompt built from this manifest — "You read credentialing
 * documents for a medical practice and return structured data." The kernel appends its own
 * injection-defence block underneath it and a pack cannot replace that part.
 */
export interface ExtractionManifest {
  version: string;
  document_kinds: readonly string[];
  role: string;
  /**
   * Imperatives that turn up printed in this pack's documents, quoted back at the model inside
   * the kernel's injection-defence block as examples of what not to obey.
   *
   * The rule is the kernel's and a pack cannot weaken it, but the *examples* have to be a pack's:
   * "send this to the payer" is a sentence that appears in credentialing paperwork and means
   * nothing in a product meeting note, and a kernel carrying it is a kernel that knows about one
   * area of the product. The kernel supplies one example of its own that every pack shares, so a
   * pack listing none still gets a worked example.
   *
   * These strings are quoted verbatim into a prompt, so keep them short and imperative.
   */
  injection_examples: readonly string[];
  targets: ExtractionTarget[];
}

const ExtractionTargetShape = z.object({
  document_kinds: z.array(z.string().min(1)).min(1),
  record_kind: z.string().min(1),
  schema_name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  attachments_key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .default('attachments'),
  instruction: z.string().min(1),
  attachment_instruction: z.string().min(1).optional(),
  attachment_schema_description: z.string().min(1).optional(),
  // Plain string keys, checked against `ATTACHMENT_SLOTS` in `parseExtractionManifest` rather
  // than by an enum-keyed record, which zod reads as "every key required".
  attachment_descriptions: z.record(z.string(), z.string().min(1)).optional(),
});

const ExtractionManifestShape = z.object({
  version: z.string().min(1),
  document_kinds: z.array(z.string().min(1)).min(1),
  role: z.string().min(1),
  injection_examples: z.array(z.string().min(1)).default([]),
  targets: z.array(ExtractionTargetShape),
});

/**
 * `document_kinds` is plain strings, not an enum: the pack is the source of that list, so
 * validating it against a copy of itself would be circular. What guards it instead is the
 * public surface snapshot — `documents_ingest.input.kind` is built from the loaded registry.
 */
export function parseExtractionManifest(raw: unknown): ExtractionManifest {
  const parsed = ExtractionManifestShape.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`extraction manifest is invalid: ${z.prettifyError(parsed.error)}`);
  const manifest = parsed.data;
  if (manifest.targets.length === 0) throw new ConfigError('extraction manifest declares no extraction targets');
  const claimed = new Set<string>();
  for (const target of manifest.targets) {
    for (const slot of Object.keys(target.attachment_descriptions ?? {})) {
      if (!(ATTACHMENT_SLOTS as readonly string[]).includes(slot)) {
        throw new ConfigError(
          `extraction manifest: target "${target.schema_name}" describes unknown attachment slot "${slot}"`,
        );
      }
    }
    for (const kind of target.document_kinds) {
      if (claimed.has(kind)) {
        throw new ConfigError(`extraction manifest: two extraction targets both claim "${kind}"`);
      }
      claimed.add(kind);
    }
  }
  return manifest;
}

/**
 * The target a document of this kind feeds. An exact claim wins over the catch-all, and
 * `undefined` — no claim and no catch-all — is a real answer: `documents_extract` turns it into
 * a `ToolError` telling the caller to classify the document first.
 */
export function targetFor(
  manifest: ExtractionManifest,
  documentKind: string | undefined,
): ExtractionTarget | undefined {
  if (documentKind !== undefined) {
    const exact = manifest.targets.find((t) => t.document_kinds.includes(documentKind));
    if (exact) return exact;
  }
  return manifest.targets.find((t) => t.document_kinds.includes(ANY_DOCUMENT_KIND));
}
