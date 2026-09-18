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
if (!values.name) {
  console.error('usage: pnpm new-client --name <client-slug> [--pack <pack>] [--template <client-slug>]');
  console.error('       --pack is optional: a client with no pack serves the kernel’s own tools alone.');
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
console.log(
  values.pack
    ? `     HARNESS_PACKS names the packs this client serves; the template names the healthcare pack.`
    : `     Set HARNESS_PACKS= (empty) — this client was scaffolded with no pack.`,
);
console.log('  2. Create one Slack app (Socket Mode and Interactivity on; see docs/runbook.md),');
console.log("     paste its two tokens and the approvals channel id, and put the two humans'");
console.log('     Slack member ids in identity.yaml.');
console.log(`  3. Review clients/${values.name}/SOUL.md and policy.yaml before the first run.`);
console.log('     playbooks.yaml runs as svc-playbooks; keep that principal in identity.yaml or change both.');
console.log(
  `  4. COMPOSE_PROJECT_NAME=${values.name} docker compose --env-file .env -f harness/compose/docker-compose.yml --profile demo up -d --build,`,
);
console.log('     or `pnpm demo:up` with HARNESS_CLIENT set in .env.');
