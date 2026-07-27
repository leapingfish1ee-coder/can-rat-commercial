import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

await mkdir('screenshots', { recursive: true });
const result = spawnSync(
  'npm',
  ['run', 'build:workspaces'],
  { encoding: 'utf8', env: process.env },
);
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
process.stdout.write(output);
await writeFile('screenshots/build.log', output || 'Build produced no output.\n');
process.exitCode = result.status ?? 1;
