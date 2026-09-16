import path from 'node:path';
import { parseArgs } from 'node:util';
import { newClient } from '../domain/scaffold.js';

const { values } = parseArgs({
  options: {
    pack: { type: 'string' },
    name: { type: 'string' },
    template: { type: 'string' },
  },
});
if (!values.pack || !values.name) {
  console.error('usage: pnpm new-client --pack <pack> --name <client-slug> [--template <client-slug>]');
  process.exit(2);
}
const result = await newClient({ pack: values.pack, name: values.name, template: values.template });
console.log(`Created ${result.dir}`);
for (const file of result.files) console.log(`  + ${file}`);
for (const file of result.skipped) console.log(`  - ${file} (not in the template)`);
console.log('');
console.log('Next:');
console.log(
  `  1. cp ${path.relative(process.cwd(), path.join(result.dir, '.env.example'))} .env   # then fill in the blanks`,
);
console.log(`     Set HARNESS_CLIENT=${values.name} and a storage directory this client does not share.`);
console.log('  2. Create the two Slack apps — one for the Hermes gateway, one for the approvals');
console.log('     app — with Socket Mode on both and Interactivity on the approver, then paste');
console.log('     both pairs of tokens.');
console.log(`  3. Review clients/${values.name}/SOUL.md and policy.yaml before the first run.`);
// Deliberately not `pnpm demo:up`: the Compose file hardcodes the
// demo-practice client folder and policy path, so that command starts
// demo-practice no matter what HARNESS_CLIENT says.
console.log('  4. Point Compose at this client and start it: see "Onboarding a client" in');
console.log('     docs/runbook.md. `pnpm demo:up` starts demo-practice, not this client.');
