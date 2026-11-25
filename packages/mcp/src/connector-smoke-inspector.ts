import { parseProbeConfiguration } from './deployed-smoke';

export function inspectorArguments(resource: string): string[] {
  return [
    '--bun',
    '@modelcontextprotocol/inspector@2.10.1',
    '--cli',
    '--transport',
    'http',
    '--server-url',
    resource,
    '--format',
    'json',
    '--stored-auth-only',
    '--method',
    'tools/list',
  ];
}

export function inspectorRefusedUnauthorized(
  exitCode: number,
  output: string,
  timedOut: boolean,
): boolean {
  if (timedOut || exitCode !== 3) return false;
  try {
    const result = JSON.parse(output) as { error?: { code?: unknown; message?: unknown } };
    return (
      result.error?.code === 'auth_required' &&
      result.error.message === 'Error POSTing to endpoint: '
    );
  } catch {
    return false;
  }
}

if (import.meta.main) {
  try {
    const configuration = parseProbeConfiguration(process.argv.slice(2));
    const resource = configuration.origin + configuration.path;
    const child = Bun.spawn(['bunx', ...inspectorArguments(resource)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 20_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    if (!inspectorRefusedUnauthorized(exitCode, stdout.trim() || stderr.trim(), timedOut))
      throw new Error(`Inspector did not establish an unauthenticated refusal (exit ${exitCode})`);
    console.info(`Inspector refused unauthenticated access to ${resource}.`);
    console.info(
      `Interactive continuation: bunx --bun @modelcontextprotocol/inspector@2.10.1 --cli --transport http --server-url ${resource} --method tools/list`,
    );
    console.info(
      'Complete browser sign-in and consent, then use Inspector to call equipment.lookup and equipment.rename with the selected test identity.',
    );
  } catch (error) {
    console.error(
      `Inspector probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
