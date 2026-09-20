import path from 'node:path';
import { parseArgs } from 'node:util';
import { newClient } from '../domain/scaffold.js';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    'display-name': { type: 'string' },
    pack: { type: 'string' },
    target: { type: 'string' },
  },
});
if (!values.name) {
  console.error(
    'usage: pnpm new-client --name <client-slug> [--display-name "<name>"] [--pack <pack>] [--target <dir>]',
  );
  console.error('       --pack is optional: a client with no pack serves the kernel’s own tools alone.');
  console.error('       --target defaults to HARNESS_CLIENTS_DIR. A client does not live in this repository.');
  process.exit(2);
}
const result = await newClient({
  name: values.name,
  displayName: values['display-name'],
  pack: values.pack,
  target: values.target,
});
console.log(`Created ${result.dir}`);
for (const file of result.files) console.log(`  + ${file}`);
console.log('');
console.log('Next:');
console.log(`  1. Fill in ${result.dir}/client.yaml: the principals and their surface ids, the routing table,`);
console.log('     and the surfaces this client serves.');
console.log(
  `  2. Set HARNESS_CONFIG_SOURCE=files and HARNESS_CLIENTS_DIR=${path.dirname(result.dir)} in the deployment's`,
);
console.log(`     environment, and HARNESS_CLIENT=${values.name} for a dedicated host.`);
console.log(`  3. Review ${result.dir}/persona.md and the policy section before the first run.`);
