import { describe, expect, it } from 'vitest';
import { KERNEL_RULES, systemPrompt } from './prompt.js';

describe('systemPrompt', () => {
  it('is the persona followed by the fixed rules block', () => {
    const text = systemPrompt('# Persona\nBe brief.');
    expect(text.startsWith('# Persona\nBe brief.\n\n')).toBe(true);
    expect(text.endsWith(KERNEL_RULES)).toBe(true);
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
    expect(KERNEL_RULES).not.toContain('edit_file');
  });
});
