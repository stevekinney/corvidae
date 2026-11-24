import process from 'node:process';

const [token] = process.argv.slice(2);
if (token === undefined || !token.startsWith('--owned-token='))
  throw new Error('The owned process gate needs a token.');
const input = await new Response(Bun.stdin.stream()).text();
let permission: unknown;
try {
  permission = JSON.parse(input);
} catch {
  permission = undefined;
}
if (
  typeof permission !== 'object' ||
  permission === null ||
  !('command' in permission) ||
  !Array.isArray(permission.command) ||
  permission.command.length === 0 ||
  !permission.command.every((entry: unknown) => typeof entry === 'string')
) {
  process.exitCode = 125;
} else {
  // The group receives the signal as a whole; keep its identifiable leader until the command exits.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => {});
  const child = Bun.spawn(permission.command, {
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exitCode = await child.exited;
}
