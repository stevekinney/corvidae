import { expect, test } from 'bun:test';
import { browserPorts } from './browser-ports.ts';

test('allocates distinct ports and propagates them into the environment', () => {
  const environment: NodeJS.ProcessEnv = {};
  const ports = browserPorts(
    ['BROWSER_FIXTURE_PORT', 'BROWSER_PREVIEW_PORT'] as const,
    environment,
  );

  expect(ports.BROWSER_FIXTURE_PORT).toBeInteger();
  expect(ports.BROWSER_PREVIEW_PORT).toBeInteger();
  expect(ports.BROWSER_FIXTURE_PORT).toBeGreaterThan(0);
  expect(ports.BROWSER_PREVIEW_PORT).toBeGreaterThan(0);
  expect(ports.BROWSER_FIXTURE_PORT).not.toBe(ports.BROWSER_PREVIEW_PORT);
  expect(environment).toMatchObject({
    BROWSER_FIXTURE_PORT: String(ports.BROWSER_FIXTURE_PORT),
    BROWSER_PREVIEW_PORT: String(ports.BROWSER_PREVIEW_PORT),
  });
});

test('preserves valid inherited ports', () => {
  const environment: NodeJS.ProcessEnv = {
    BROWSER_FIXTURE_PORT: '43101',
    BROWSER_PREVIEW_PORT: '43102',
  };

  expect(
    browserPorts(['BROWSER_FIXTURE_PORT', 'BROWSER_PREVIEW_PORT'] as const, environment),
  ).toEqual({
    BROWSER_FIXTURE_PORT: 43101,
    BROWSER_PREVIEW_PORT: 43102,
  });
});

test('rejects invalid inherited ports', () => {
  for (const value of ['', '0', '-1', '1.5', '65536', 'port', ' 43101']) {
    expect(() =>
      browserPorts(['BROWSER_FIXTURE_PORT'] as const, { BROWSER_FIXTURE_PORT: value }),
    ).toThrow(`Invalid browser port BROWSER_FIXTURE_PORT: ${value}`);
  }
});

test('rejects duplicate inherited ports', () => {
  expect(() =>
    browserPorts(['BROWSER_FIXTURE_PORT', 'BROWSER_PREVIEW_PORT'] as const, {
      BROWSER_FIXTURE_PORT: '43103',
      BROWSER_PREVIEW_PORT: '43103',
    }),
  ).toThrow('Browser server ports must be distinct.');
});

test('keeps an inherited port selected while another process holds it', () => {
  const holder = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data() {} },
  });
  try {
    const environment = { BROWSER_FIXTURE_PORT: String(holder.port) };
    expect(browserPorts(['BROWSER_FIXTURE_PORT'] as const, environment)).toEqual({
      BROWSER_FIXTURE_PORT: holder.port,
    });
  } finally {
    holder.stop();
  }
});

/**
 * Starts four processes that each allocate a port and hold it, then releases them. The
 * concurrency across real processes is the behavior under test, so the children run here at
 * module scope, off Bun's five-second per-test clock; the test below asserts on the results.
 */
async function allocateFromConcurrentProcesses() {
  const helperPath = `${import.meta.dir}/browser-ports.ts`;
  const childSource = `
    const { browserPorts } = await import(${JSON.stringify(helperPath)});
    const environment = {};
    const { PORT } = browserPorts(['PORT'], environment);
    const listener = Bun.listen({ hostname: '127.0.0.1', port: PORT, socket: { data() {} } });
    // Not console.log(PORT): an inherited FORCE_COLOR wraps a logged number in
    // ANSI escapes, which Number() then parses as NaN in the parent.
    process.stdout.write(PORT + '\\n');
    await Bun.stdin.text();
    listener.stop();
  `;
  const children = Array.from({ length: 4 }, () =>
    Bun.spawn([process.execPath, '-e', childSource], {
      timeout: 120_000,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  try {
    const ports = await Promise.all(
      children.map(async (child) => {
        if (child.stdout === undefined || typeof child.stdout === 'number') {
          throw new Error('Concurrent browser-port child stdout was not piped.');
        }
        const reader = child.stdout.getReader();
        let output = '';
        while (!output.includes('\n')) {
          const chunk = await reader.read();
          if (chunk.done)
            throw new Error(`Concurrent child exited before selecting a port: ${output}`);
          output += new TextDecoder().decode(chunk.value);
        }
        reader.releaseLock();
        return Number(output.slice(0, output.indexOf('\n')).trim());
      }),
    );
    return { ports, results: await stopChildren() };
  } catch (error) {
    await stopChildren();
    throw error;
  }

  async function stopChildren() {
    for (const child of children) child.stdin?.end();
    const results = await Promise.all(
      children.map(async (child) => {
        const [stderr, exitCode] = await Promise.all([
          child.stderr === undefined || typeof child.stderr === 'number'
            ? Promise.resolve('')
            : new Response(child.stderr).text(),
          child.exited,
        ]);
        return { stderr, exitCode };
      }),
    );
    return results;
  }
}
const concurrentAllocation = await allocateFromConcurrentProcesses();

test('allocates usable ports from concurrent processes', () => {
  const { ports, results } = concurrentAllocation;
  expect(new Set(ports).size).toBe(ports.length);
  for (const port of ports) expect(port).toBeInteger();
  for (const result of results) {
    expect(result.exitCode, result.stderr).toBe(0);
  }
});
