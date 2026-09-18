import { describe, expect, it } from 'vitest';
import type { RunPrincipal } from '@harness/runtime-api';
import { KERNEL_RULES, systemPrompt } from './prompt.js';

const CALLER: RunPrincipal = { id: 'u-coordinator', kind: 'user', level: 'lead', displayName: 'Dana Whitfield' };

describe('systemPrompt', () => {
  it('is the persona followed by the fixed rules block', () => {
    const text = systemPrompt('# Persona\nBe brief.', CALLER);
    expect(text.startsWith('# Persona\nBe brief.\n\n')).toBe(true);
    expect(text).toContain(KERNEL_RULES);
  });

  it('names the person the run is speaking with, and says not to guess one from an id', () => {
    // A live run read a principal id out of the audit log and addressed the person by the name
    // it thought the id spelled. The identity plug-in already resolved their real name; the
    // prompt just never said it.
    const text = systemPrompt('# Persona', CALLER);
    expect(text).toContain('You are speaking with Dana Whitfield (lead).');
    expect(text).toContain('never infer a name from an id');
    // In the rules block, not in the persona: a client's persona is its own and must not have to
    // carry this.
    expect(text.indexOf('Dana Whitfield')).toBeGreaterThan(text.indexOf(KERNEL_RULES));
  });

  it('names a service caller the same way, so a playbook run has no person to address', () => {
    const text = systemPrompt('# Persona', {
      id: 'svc-playbooks',
      kind: 'service',
      level: 'service',
      displayName: 'Nightly playbooks',
    });
    expect(text).toContain('You are speaking with Nightly playbooks (service).');
  });

  it('tells the model where skills and memory are and what pending means', () => {
    expect(KERNEL_RULES).toContain('/skills/');
    expect(KERNEL_RULES).toContain('/memories/MEMORY.md');
    expect(KERNEL_RULES).toContain('"pending"');
  });

  it('tells the model to read the memory file, because nothing inlines it any more', () => {
    // The framework's own memory option is not used: it inlines the file and tells the model to
    // write it back with `edit_file`, which this run neither offers nor permits. The file is
    // seeded as state, so the model has to open it like any other file.
    const memoryLine = KERNEL_RULES.split('\n').find((line) => line.includes('/memories/MEMORY.md'));
    expect(memoryLine).toBeDefined();
    expect(memoryLine).toContain('read_file');
    for (const tool of ['memory_add', 'memory_remove', 'session_search']) expect(memoryLine).toContain(tool);
    expect(KERNEL_RULES).not.toContain('edit_file');
  });
});
