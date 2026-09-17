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
});
