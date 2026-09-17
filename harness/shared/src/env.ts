import { ConfigError } from './errors.js';

/**
 * The environment is read here and in `app/`, nowhere else; ESLint enforces it. A domain that
 * needs a value takes it as a parameter, or calls one of these — calling is fine anywhere,
 * because the ban is on the `process.env` syntax and not on the value.
 *
 * One reader per kind, so no variable can be validated more loosely than its neighbour. The
 * bug that motivated `booleanFromEnv` is in its own comment below.
 */

/**
 * An environment to read from. The ambient process environment satisfies it and is the default
 * everywhere below, and so does a plain map — which is what makes the last parameter of each
 * helper useful: a pack is handed its environment on `deps.env` rather than reaching for the
 * ambient one, so an eval or a test can pin a variable for the code under test without
 * touching the process. Same parsing, same error wording, whichever source it is.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface NumberEnvOptions {
  min: number;
  max: number;
  /** Reject a fractional value. Ports and counts; not thresholds. */
  integer?: boolean;
  /** Appended to the failure message, e.g. `seconds`. */
  unit?: string;
}

/**
 * Read a numeric variable, falling back when it is unset or empty. A present but unparseable
 * or out-of-range value is a configuration error and fails startup rather than silently
 * becoming `NaN` — an unvalidated typo in a port makes `listen(NaN)` pick an arbitrary free
 * port, and the process then looks healthy while nothing can reach it.
 */
export function numberFromEnv(
  name: string,
  fallback: number,
  options: NumberEnvOptions,
  env: EnvSource = process.env,
): number {
  const { min, max, integer = false, unit } = options;
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  const wellFormed = integer ? Number.isInteger(value) : Number.isFinite(value);
  if (!wellFormed || value < min || value > max) {
    throw new ConfigError(
      `${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}${unit ? ` ${unit}` : ''}`,
    );
  }
  return value;
}

/**
 * Read a boolean variable. `true` and `1` are on; everything else — unset, empty, `false`,
 * `0`, `no`, a typo — is off. Case and surrounding whitespace are ignored.
 *
 * Every flag goes through this one helper so none can be read differently from another.
 * Before it, `VERIFY_NPPES_ENABLED` alone disabled on the literal `'false'` while its
 * neighbours enabled on the literal `'true'`, so `VERIFY_NPPES_ENABLED=0` left outbound
 * registry lookups switched on while the same spelling switched everything else off. Every
 * one of these defaults to off: a deployment that sets nothing makes no outbound calls and
 * sends nothing restricted to a model.
 */
export function booleanFromEnv(name: string, env: EnvSource = process.env): boolean {
  const raw = env[name]?.trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

/**
 * Read a variable that has no sensible default, or fail startup naming it. An empty string
 * counts as unset, or a half-filled `.env` starts a process that fails later and further from
 * the cause.
 *
 * `env` is a parameter because `coreToolsChildEnv` in @harness/approvals reads an environment
 * it is handed rather than its own, its tests pass a fixture, and a pack reads the map on
 * `deps.env`.
 */
export function requiredEnv(name: string, hint = '', env: EnvSource = process.env): string {
  const value = env[name];
  if (!value || value.trim() === '') throw new ConfigError(`${name} is not set${hint}`);
  return value;
}

/** A variable with no default and no requirement. An empty string reads as absent. */
export function optionalEnv(name: string, env: EnvSource = process.env): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

/**
 * A variable with a default, where an empty value is a mistake rather than a request for that
 * default. `optionalEnv` reads an empty string as absent, so a half-filled `.env` would leave a
 * process serving the `default` client, auditing every call as `hermes`, or pointing a registry
 * lookup at a live endpoint, every one of them silently. Unset keeps the default; set-but-empty
 * fails startup naming the variable.
 */
export function envOrDefault(name: string, fallback: string, env: EnvSource = process.env): string {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (raw.trim() === '') {
    throw new ConfigError(`${name} is set but empty; give it a value, or unset it to use the default`);
  }
  return raw;
}
