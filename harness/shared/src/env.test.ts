import { describe, it, expect, afterEach } from 'vitest';
import { booleanFromEnv, numberFromEnv, optionalEnv, requiredEnv } from './env.js';

const NAME = 'TEST_NUMBER_FROM_ENV';
const FLAG = 'TEST_BOOLEAN_FROM_ENV';

afterEach(() => {
  delete process.env[NAME];
  delete process.env[FLAG];
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
    expect(() => numberFromEnv(NAME, 24, { min: 1, max: 720 })).toThrow(`${NAME} must be a number between 1 and 720`);
  });

  it('rejects a value outside the range', () => {
    process.env[NAME] = '0';
    expect(() => numberFromEnv(NAME, 24, { min: 1, max: 720 })).toThrow(`${NAME} must be a number between 1 and 720`);
    process.env[NAME] = '1000';
    expect(() => numberFromEnv(NAME, 24, { min: 1, max: 720 })).toThrow(`${NAME} must be a number between 1 and 720`);
  });
});

describe('booleanFromEnv', () => {
  it('is off when the variable is unset or empty', () => {
    expect(booleanFromEnv(FLAG)).toBe(false);
    process.env[FLAG] = '';
    expect(booleanFromEnv(FLAG)).toBe(false);
    process.env[FLAG] = '   ';
    expect(booleanFromEnv(FLAG)).toBe(false);
  });

  it.each(['true', 'TRUE', ' True ', '1'])('is on for %s', (raw) => {
    process.env[FLAG] = raw;
    expect(booleanFromEnv(FLAG)).toBe(true);
  });

  // The spellings that used to leave VERIFY_NPPES_ENABLED switched on while
  // disabling every other flag. One helper means one answer for all of them.
  it.each(['false', 'FALSE', '0', 'no', 'off', 'yes', 'ture'])('is off for %s', (raw) => {
    process.env[FLAG] = raw;
    expect(booleanFromEnv(FLAG)).toBe(false);
  });
});

describe('numberFromEnv with integer and unit', () => {
  it('rejects a fractional value when integer is set', () => {
    process.env[NAME] = '8787.5';
    expect(() => numberFromEnv(NAME, 8787, { min: 1, max: 65_535, integer: true })).toThrow(
      `${NAME} must be an integer between 1 and 65535`,
    );
  });

  it('names the unit in the failure', () => {
    process.env[NAME] = '0';
    expect(() => numberFromEnv(NAME, 5, { min: 1, max: 86_400, unit: 'seconds' })).toThrow(
      `${NAME} must be a number between 1 and 86400 seconds`,
    );
  });
});

describe('requiredEnv', () => {
  it('returns the value', () => {
    process.env[NAME] = 'sk-test';
    expect(requiredEnv(NAME)).toBe('sk-test');
  });

  it('treats an empty or whitespace value as unset and appends the hint', () => {
    process.env[NAME] = '   ';
    expect(() => requiredEnv(NAME, ' (see docs/runbook.md)')).toThrow(`${NAME} is not set (see docs/runbook.md)`);
  });

  it('reads an environment it is handed, so a caller can validate a child process env', () => {
    expect(requiredEnv(NAME, '', { [NAME]: 'from-a-fixture' })).toBe('from-a-fixture');
    expect(() => requiredEnv(NAME, '', {})).toThrow(`${NAME} is not set`);
  });
});

describe('optionalEnv', () => {
  it('is undefined when unset or empty, and the value otherwise', () => {
    expect(optionalEnv(NAME)).toBeUndefined();
    process.env[NAME] = '  ';
    expect(optionalEnv(NAME)).toBeUndefined();
    process.env[NAME] = '/srv/harness-storage';
    expect(optionalEnv(NAME)).toBe('/srv/harness-storage');
  });
});
