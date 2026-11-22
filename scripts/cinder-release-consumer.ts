import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const name = process.argv[2];
const packageName = '@lostgradient/' + name;
const require = createRequire(import.meta.url);
const manifestPath = require.resolve(packageName + '/package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  exports: Record<string, string | { default?: string; import?: string }>;
};

for (const [entry, target] of Object.entries(manifest.exports)) {
  const specifier = packageName + entry.slice(1);
  const runtime = typeof target === 'string' ? target : (target.default ?? target.import);
  assert.ok(runtime, specifier);
  require.resolve(
    typeof target === 'object' && !target.default ? packageName + '/package.json' : specifier,
  );
  if (runtime.endsWith('.js')) await import(specifier);
}

if (name === 'markdown') {
  const markdown = await import(packageName);
  const asyncSpecifier = packageName + '/rendering/async';
  const { renderMarkdownAsync } = await import(asyncSpecifier);
  assert.equal(markdown.parse('# Hello').success, true);
  const rendered = await renderMarkdownAsync('# Hello');
  assert.match(rendered.html, /<h1[^>]*>Hello<\/h1>/);
  const renderer = new URL('./render-async.js', import.meta.resolve(asyncSpecifier));
  assert.match(readFileSync(renderer, 'utf8'), /render-worker\.js/);
  assert.ok(readFileSync(new URL('./render-worker.js', renderer)).length > 0);
}
if (name === 'cinder' || name === 'editor') {
  const svelteServer = 'svelte/server';
  const { render } = await import(svelteServer);
  const components = await import(packageName);
  const entry = packageName + (name === 'cinder' ? '/button' : '/markdown-editor');
  const subpath = await import(entry);
  if (name === 'cinder') {
    assert.equal(components.Button, subpath.default);
    assert.match(render(components.Button, { props: {} }).body, /<button/);
  } else {
    assert.equal(components.MarkdownEditor, subpath.default);
    assert.match(
      render(components.MarkdownEditor, { props: { value: '# Hello' } }).body,
      /textarea|editor/,
    );
  }
}
if (name === 'cinder-mcp') {
  const child = spawn(join(process.cwd(), 'node_modules/.bin/cinder-mcp'), [], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const replies = createInterface({ input: child.stdout });
  const messages = replies[Symbol.asyncIterator]();
  const send = (payload: object) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
  try {
    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'release-check', version: '1.0.0' },
      },
    });
    const initialization = await messages.next();
    assert.equal(initialization.done, false);
    assert.equal(JSON.parse(initialization.value).result.serverInfo.name, 'cinder');
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'resources/read', params: { uri: 'cinder://component/button' } });
    const resource = await messages.next();
    assert.equal(resource.done, false);
    const button = JSON.parse(JSON.parse(resource.value).result.contents[0].text);
    assert.equal(button.component.id, 'button');
    assert.ok(button.schema);
    assert.ok(button.constraints);
  } finally {
    child.stdin.end();
    replies.close();
    child.kill();
  }
}
console.log(`Verified installed ${packageName}`);
