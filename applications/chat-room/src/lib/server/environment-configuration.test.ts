import { expect, test } from 'bun:test';

// Isolate the SvelteKit virtual-module mock from the rest of the application tests.
test('both chat routes preserve missing-key responses and private configuration stays dynamic', () => {
  const program = `
    import { mock } from 'bun:test';
    import { strict as assert } from 'node:assert';
    const privateEnvironment = {};
    mock.module('$env/dynamic/private', () => ({ env: privateEnvironment }));
    const { POST: chat } = await import('./src/routes/api/chat/+server.ts');
    const { POST: stream } = await import('./src/routes/api/server-owned/conversations/[id]/stream/+server.ts');
    const { createConversationHistory } = await import('conversationalist');
    const { createConversation } = await import('./src/lib/server-owned-conversations.ts');
    const { disposeServerOwnedRuntime } = await import('./src/lib/server-owned-runtime.ts');
    const { readEnvironmentConfiguration } = await import('./src/lib/server/environment-configuration.ts');
    const created = await createConversation('Environment regression');
    try {
      for (const key of [undefined, '']) {
        privateEnvironment.ANTHROPIC_API_KEY = key;
        const response = await chat({ request: new Request('http://localhost/api/chat', {
          method: 'POST', body: JSON.stringify({ conversation: createConversationHistory({ id: 'configuration-test' }) }),
        }) });
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: 'ANTHROPIC_API_KEY is not configured' });
        const ownedResponse = await stream({ params: { id: created.id }, request: new Request('http://localhost/api/stream', {
          method: 'POST', body: JSON.stringify({ text: 'Hello' }),
        }) });
        assert.equal(ownedResponse.status, 503);
      }
      privateEnvironment.ANTHROPIC_API_KEY = 'private-test-key';
      privateEnvironment.ANTHROPIC_BASE_URL = 'http://127.0.0.1:4598';
      const configuration = readEnvironmentConfiguration();
      assert.equal(configuration.anthropicApiKey, 'private-test-key');
      assert.equal(configuration.anthropicBaseUrl, 'http://127.0.0.1:4598');
      assert.equal(JSON.stringify(configuration).includes('private-test-key'), false);
      privateEnvironment.ANTHROPIC_BASE_URL = 'http://127.0.0.1:4597';
      assert.equal(readEnvironmentConfiguration().anthropicBaseUrl, 'http://127.0.0.1:4597');
    } finally {
      await disposeServerOwnedRuntime();
    }
  `;
  const result = Bun.spawnSync([process.execPath, '--eval', program], {
    cwd: new URL('../../..', import.meta.url).pathname,
    env: { ...process.env, CHAT_ROOM_SERVER_OWNED_DATABASE: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
});
