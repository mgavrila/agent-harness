/**
 * The public API of @harness/host.
 *
 * This module and the `./testing` subpath are the whole of what another package may import.
 * Nothing here reaches into `app/`: the composition root reads the environment, opens a pool
 * and starts a process, and a consumer that imported it would drag all three into its own
 * startup.
 */

export { type Host, type HostBudget } from './domain/host.js';
export { loadRuntime } from './domain/runtime/registry.js';
export { WITHHELD, appendMessage, findOrCreateThread, recentHistory } from './domain/threads/repository.js';
export { HISTORY_MAX_CHARS, trimHistory } from './domain/threads/trim.js';
export { readSkillCatalogue } from './domain/skills.js';
export { readPersona } from './domain/persona.js';
export { openKernel } from './domain/kernel.js';
