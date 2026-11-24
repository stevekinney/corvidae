import process from 'node:process';

export function ownedCommand(permission: unknown): string[] | undefined {
  if (
    typeof permission !== 'object' ||
    permission === null ||
    !Object.hasOwn(permission, 'command')
  )
    return undefined;
  const command: unknown = Reflect.get(permission, 'command');
  return Array.isArray(command) &&
    command.length > 0 &&
    command.every((entry: unknown) => typeof entry === 'string')
    ? command
    : undefined;
}

if (import.meta.main) {
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
  const command = ownedCommand(permission);
  if (command === undefined) {
    process.exitCode = 125;
  } else {
    // The group receives the signal as a whole; keep its identifiable leader until the command exits.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => {});
    const child = Bun.spawn(command, {
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    process.exitCode = await child.exited;
  }
}
