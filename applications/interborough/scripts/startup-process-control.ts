/** Check the qualification driver's owned Bun-filter process group on this runner. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { processEnvironment } from '../src/host/environment-configuration.ts';

const directoryArgument = process.argv[2];
if (!directoryArgument)
  throw new Error('Usage: bun startup-process-control.ts <empty scratch directory>');
const directory = resolve(directoryArgument);
const application = join(directory, 'applications/interborough');
await mkdir(application, { recursive: true });
await writeFile(
  join(directory, 'package.json'),
  JSON.stringify({ private: true, workspaces: ['applications/*'] }),
);
await writeFile(
  join(application, 'package.json'),
  JSON.stringify({ name: '@lostgradient/interborough', scripts: { dev: 'bun fake.ts' } }),
);
await writeFile(
  join(application, 'fake.ts'),
  `const child = Bun.spawn(['bun', '-e', 'setInterval(() => {}, 1000)']);\nconsole.log('CONTROL_CHILD ' + child.pid);\nif (process.env.STARTUP_CONTROL_EARLY === '1') { child.unref(); process.exit(1); }\nsetInterval(() => {}, 1000);\n`,
);

const driver = join(import.meta.dir, 'qualify-startup.ts');
const results: unknown[] = [];
for (const early of [false, true]) {
  const wrapper = Bun.spawn(['bun', driver, '--supervise', directory, 'dev'], {
    env: { ...processEnvironment(), STARTUP_CONTROL_EARLY: early ? '1' : '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  let group: number | undefined;
  let child: number | undefined;
  let signaled = false;
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += chunk.value;
      group ??= Number(/STARTUP_GROUP (\d+)/.exec(output)?.[1]) || undefined;
      child ??= Number(/CONTROL_CHILD (\d+)/.exec(output)?.[1]) || undefined;
      if (!early && child !== undefined && !signaled) {
        signaled = true;
        wrapper.kill('SIGTERM');
      }
    }
  };
  const streams = Promise.all([collect(wrapper.stdout), collect(wrapper.stderr)]);
  const exit = await wrapper.exited;
  await streams;
  const table = Bun.spawnSync(['ps', '-eo', 'pid=,pgid=,uid=,stat='], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const members = new TextDecoder()
    .decode(table.stdout)
    .split('\n')
    .filter((line) => {
      const [pid, processGroup] = line.trim().split(/\s+/).map(Number);
      return processGroup === group || pid === child;
    });
  const passed =
    group !== undefined &&
    child !== undefined &&
    table.exitCode === 0 &&
    members.length === 0 &&
    !output.includes('Error:') &&
    (early ? exit === 1 : exit === 143 || exit === 0);
  results.push({ early, wrapper: wrapper.pid, group, child, exit, members, output, passed });
  if (!passed) break;
}
await writeFile(join(directory, 'process-control.json'), `${JSON.stringify(results, null, 2)}\n`);
if (results.length !== 2 || results.some((result) => !(result as { passed: boolean }).passed))
  process.exitCode = 1;
