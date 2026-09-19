import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ClientDocument } from '@harness/config-api';

/**
 * A client's skills, on disk, because that is what a runtime is handed.
 *
 * `RunSkill.dir` is a directory the runtime reads files from, and `readSkillCatalogue` requires a
 * `SKILL.md` whose frontmatter `name` matches its directory's name. A document carries skills as
 * `name → markdown`, which is the right shape for a store and the wrong one for a plug-in, so
 * each entry is written to `<root>/<clientId>/<name>/SKILL.md` before the catalogue is read.
 * Validation is `readSkillCatalogue`'s, unchanged: a document's skill is checked exactly as a
 * pack's is.
 *
 * The directory is rebuilt from scratch every time, so a skill removed from the document is gone
 * from disk, and it is per client, so one tenant's skills are never in another's catalogue.
 */
export async function materialiseSkills(document: ClientDocument, root: string): Promise<string> {
  const dir = path.join(root, document.id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [name, markdown] of Object.entries(document.skills)) {
    await mkdir(path.join(dir, name), { recursive: true });
    await writeFile(path.join(dir, name, 'SKILL.md'), markdown, 'utf8');
  }
  return dir;
}
