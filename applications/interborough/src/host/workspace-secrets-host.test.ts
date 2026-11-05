import { definePlugin } from '@lostgradient/interborough-plugin';
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';
import { secretService } from './workspace-secret-service.test-support.ts';

test('a replacement application host resolves its generated secret from the external provider', async () => {
  await using service = await secretService();
  const client = service.client();
  const directory = await mkdtemp(join(tmpdir(), 'host-secret-provider-'));
  const values: string[] = [];
  const hosts: Host[] = [];
  try {
    // The fixture represents a provisioned workspace identity, shared with the external service.
    await writeFile(join(directory, 'deployment-id'), `${client.workspaceId}\n`, { mode: 0o600 });
    const options = {
      environment: { INTERBOROUGH_HOME: directory },
      port: 0,
      log: () => undefined,
      secretProvider: () => service.client().secretProvider,
      plugins: [
        {
          source: 'package' as const,
          location: '@fixture/host-secret',
          descriptor: definePlugin({
            name: 'host-secret',
            version: '1.0.0',
            description: 'External secret conformance fixture.',
            secrets: [{ key: 'generated-key', generated: true }],
            async setup(context) {
              const value = await context.secrets.get('generated-key');
              if (value === undefined) throw new Error('The generated secret is missing.');
              values.push(value);
              return {};
            },
          }),
        },
      ],
    };
    const first = await startHost(options);
    hosts.push(first);
    expect(values).toHaveLength(1);
    const approval = await readFile(join(directory, 'secrets', 'approval-secret'), 'utf8');
    const encryption = await readFile(join(directory, 'secrets', 'answer-encryption-key'), 'utf8');
    await first.close();
    hosts.pop();
    const replacement = await startHost(options);
    hosts.push(replacement);
    expect(values).toEqual([values[0]!, values[0]!]);
    expect(await readFile(join(directory, 'secrets', 'approval-secret'), 'utf8')).toBe(approval);
    expect(await readFile(join(directory, 'secrets', 'answer-encryption-key'), 'utf8')).toBe(
      encryption,
    );
    expect(
      await readFile(join(directory, 'secrets', 'generated-key')).then(
        () => undefined,
        (error: unknown) => error,
      ),
    ).toBeInstanceOf(Error);
    expect(await client.secretProvider.listOperations()).toHaveLength(1);
    expect(JSON.stringify(replacement.diagnostics())).not.toContain(values[0]!);
  } finally {
    for (const host of hosts) await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('management reports typed provider failures without their values or causes', async () => {
  await using service = await secretService();
  const { SecretProviderError } = await import('@lostgradient/bungalow');
  const client = service.client();
  const directory = await mkdtemp(join(tmpdir(), 'host-secret-error-'));
  let host: Host | undefined;
  let code: 'rejected' | 'read-only' | 'conflict' | 'missing' | 'unavailable' = 'unavailable';
  try {
    await writeFile(join(directory, 'deployment-id'), `${client.workspaceId}\n`, { mode: 0o600 });
    host = await startHost({
      environment: { INTERBOROUGH_HOME: directory },
      port: 0,
      log: () => undefined,
      secretProvider: () => ({
        ...service.client().secretProvider,
        async prepare() {
          throw new SecretProviderError(code, 'must-not-leak-value', {
            cause: 'must-not-leak-cause',
          });
        },
      }),
      plugins: [
        {
          source: 'package',
          location: '@fixture/provider-error',
          descriptor: definePlugin({
            name: 'provider-error',
            version: '1.0.0',
            description: 'Provider error fixture.',
            secrets: ['api-key'],
          }),
        },
      ],
    });
    for (const [next, status] of [
      ['rejected', 400],
      ['read-only', 403],
      ['conflict', 409],
      ['missing', 503],
      ['unavailable', 503],
    ] as const) {
      code = next;
      const response = await fetch(
        new URL('/host/plugins/provider-error/secrets/api-key', host.url),
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json', origin: host.url.origin },
          body: JSON.stringify({ value: 'candidate-value' }),
        },
      );
      expect(response.status).toBe(status);
      const body = await response.text();
      expect(body).toContain(`"reason":"${next}"`);
      expect(body).not.toContain('must-not-leak');
      expect(body).not.toContain('candidate-value');
    }
  } finally {
    await host?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
