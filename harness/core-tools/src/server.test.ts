import { describe, it, expect, afterEach } from 'vitest';
import { numberFromEnv } from './server.js';

const NAME = 'TEST_NUMBER_FROM_ENV';

afterEach(() => {
  delete process.env[NAME];
});

describe('numberFromEnv', () => {
  it('falls back when the variable is unset or empty', () => {
    expect(numberFromEnv(NAME, 24, { min: 1, max: 720 })).toBe(24);
    process.env[NAME] = '   ';
    expect(numberFromEnv(NAME, 24, { min: 1, max: 720 })).toBe(24);
  });

  it('parses a value inside the range', () => {
    process.env[NAME] = '0.9';
    expect(numberFromEnv(NAME, 0.85, { min: 0, max: 1 })).toBe(0.9);
  });

  it('rejects a value that is not a number', () => {
    process.env[NAME] = 'soon';
    expect(() => numberFromEnv(NAME, 24, { min: 1, max: 720 })).toThrow(
      `${NAME} must be a number between 1 and 720`,
    );
  });

  it('rejects a value outside the range', () => {
    process.env[NAME] = '0';
    expect(() => numberFromEnv(NAME, 24, { min: 1, max: 720 })).toThrow(
      `${NAME} must be a number between 1 and 720`,
    );
    process.env[NAME] = '1000';
    expect(() => numberFromEnv(NAME, 24, { min: 1, max: 720 })).toThrow(
      `${NAME} must be a number between 1 and 720`,
    );
  });
});
