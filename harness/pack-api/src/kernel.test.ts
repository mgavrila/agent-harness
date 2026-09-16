import { describe, expect, it } from 'vitest';
import type { CoreToolView, PackKernel, PackToolDeps } from './kernel.js';

const kernel: PackKernel = {
  MASKED: '[restricted]',
  isRestrictedName: (name) => name === 'ssn',
  writeOutFile: (_deps, input) =>
    Promise.resolve({ file_id: `${input.dir}/${input.name}.${input.ext}`, path: '/tmp/x', bytes: input.bytes.length }),
  stageRelease: (_deps, args) =>
    Promise.resolve({ effect_id: 'e1', staged: true, file_id: args.file_id, filename: 'x.pdf', bytes: 1 }),
};

const echo: CoreToolView = {
  name: 'records_get',
  handler: (args: { record_id: string }) => Promise.resolve({ record: { id: args.record_id } }),
};

const deps: PackToolDeps = {
  client: 'test',
  caller: 'test-caller',
  now: () => new Date('2026-09-15T12:00:00Z'),
  storageDir: '/srv/storage',
  formsDir: '/srv/forms',
  packs: {
    byName: () => {
      throw new Error('not used');
    },
    documentKinds: () => ['other'],
    recordKinds: () => [],
    attachmentKinds: () => [],
  },
  kernelTools: new Map([['records_get', echo]]),
  kernel,
};

describe('PackToolDeps', () => {
  it('lets a pack tool reach a kernel handler by name and pass its own deps through', async () => {
    const view = deps.kernelTools.get('records_get');
    expect(view).toBeDefined();
    expect(await view!.handler({ record_id: 'r1' }, deps)).toEqual({ record: { id: 'r1' } });
  });

  it('carries the two redaction primitives a pack redact() needs, with no import of core-tools', () => {
    expect(deps.kernel.isRestrictedName('ssn')).toBe(true);
    expect(deps.kernel.MASKED).toBe('[restricted]');
  });
});
