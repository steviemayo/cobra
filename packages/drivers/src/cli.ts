// Kestrel driver SDK command line.
//   pnpm --filter @kestrel/drivers driver validate my-driver.json
//   pnpm --filter @kestrel/drivers driver render my-driver.json --level=50 --input=in2 --output=out1 --name=Movie
import { readFileSync } from 'node:fs';
import {
  checkDriverSpec,
  commandValues,
  escapeLine,
  escapePath,
  renderTemplate,
  resolveSettings,
} from '@kestrel/model';

const [command, file, ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(
  rest.flatMap((a) => {
    const m = /^--([a-z]+)=(.*)$/.exec(a);
    return m ? [[m[1]!, m[2]!] as const] : [];
  }),
);

function load() {
  if (!file) {
    console.error('Usage: driver <validate|render> <file.json> [--level=50 --input=in2 --output=out1 --name=Movie]');
    process.exit(2);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const checked = checkDriverSpec(raw);
  if (!checked.ok) {
    console.error(`${file} has ${checked.problems.length} problem${checked.problems.length === 1 ? '' : 's'}:`);
    for (const p of checked.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  return checked.spec;
}

if (command === 'validate') {
  const spec = load();
  console.log(`OK: ${spec.name} (${spec.id}) over ${spec.transport.type.toUpperCase()}, ${Object.keys(spec.commands).length} commands`);
} else if (command === 'render') {
  const spec = load();
  const settings = resolveSettings(spec, { host: '10.0.0.5', password: 'secret', token: 'token' }).values;
  const values = commandValues(spec, settings, {
    level: flags.level === undefined ? 50 : Number(flags.level),
    input: flags.input ?? 'in2',
    output: flags.output ?? 'out1',
    name: flags.name ?? 'Example',
  });
  for (const [key, a] of Object.entries(spec.commands))
    console.log(
      `${key.padEnd(16)} ${
        spec.transport.type === 'tcp'
          ? JSON.stringify(renderTemplate(a.send ?? '', values, escapeLine) + spec.transport.terminator)
          : `${a.method ?? (a.body ? 'POST' : 'GET')} ${renderTemplate(a.path ?? '', values, escapePath)} ${a.body ?? ''}`.trim()
      }`,
    );
} else {
  console.error('Usage: driver <validate|render> <file.json>');
  process.exit(2);
}
