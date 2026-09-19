/**
 * Field-name stems that always identify a restricted identifier. A caller may
 * mark any field restricted, but may never un-mark one of these: the check is
 * authoritative, so `restricted: false` on an `ssn` is ignored.
 */
const RESTRICTED_NAME_KEYS = ['ssn', 'socialsecurity', 'ein', 'taxid', 'dea'] as const;
/** Suffixes a key may carry: `dea`, `dea_number`, `DEA-No`, `dea_id`, ... */
const RESTRICTED_NAME_SUFFIXES = ['', 'number', 'no', 'id', 'registration'] as const;

/** Stands in for any value a caller is not allowed to read back. */
export const MASKED = '[restricted]';

/**
 * True when `name` denotes a restricted identifier. Normalizes away case and
 * separators, drops a trailing ordinal, then matches a key exactly or a key
 * plus a known suffix — so `deadline` and `npi` are not restricted while
 * `DEA-Number` is.
 *
 * The trailing ordinal matters: `fieldNameFor` in redaction/text.ts names a
 * second distinct value of a kind `ssn_2`, `ein_2`, `dea_number_2`. Those are
 * names this harness generates itself, so a caller replaying an earlier
 * extraction through `records_upsert` must not be able to land one in the
 * plaintext `fields.value` column just because it carries a suffix.
 */
export function isRestrictedName(name: string): boolean {
  // Separators are already gone, so the ordinal is a bare digit run at the end.
  const stem = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/\d+$/, '');
  return RESTRICTED_NAME_KEYS.some((key) => RESTRICTED_NAME_SUFFIXES.some((suffix) => stem === `${key}${suffix}`));
}
