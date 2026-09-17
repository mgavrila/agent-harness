import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { defineIdentityProvider, parseIdentityFile, type IdentityProvider } from '@harness/identity-api';
import { StaticIdentity } from '@harness/identity-api/testing';
import { ConfigError, describeError, optionalEnv } from '@harness/shared';

/**
 * Principals from a file in the client folder.
 *
 * `HARNESS_IDENTITY_FILE` overrides the location, for a test that spawns a server under a
 * client name that has no folder and for a bare-metal run whose client folder lives elsewhere.
 * Read off `deps.env`, never the ambient environment, for the same reason a pack reads
 * `deps.env`: whoever builds the bag decides what the plug-in can see.
 */
export const identity: IdentityProvider = defineIdentityProvider({
  name: 'static',
  version: '0.1.0',
  secrets: [],
  connect: async (deps) => {
    const file = optionalEnv('HARNESS_IDENTITY_FILE', deps.env) ?? path.join(deps.clientDir, 'identity.yaml');
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      throw new ConfigError(
        `cannot read the identity file ${file} (${describeError(err)}); every client folder needs an identity.yaml`,
      );
    }
    const principals = parseIdentityFile(parseYaml(text));
    deps.log.info(`static identity: ${principals.length} principals from ${file}`);
    return new StaticIdentity(principals, 'static');
  },
});
