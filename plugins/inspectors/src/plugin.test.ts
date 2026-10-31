import { createPluginTestHost } from '@lostgradient/bureau/testing';
import { pluginContract } from '@lostgradient/interborough-plugin/testing';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import inspectors, { pendingReview, runInspector } from './plugin.ts';

pluginContract(inspectors, { createHost: createPluginTestHost });

describe('the inspectors plugin', () => {
  it('contributes the two panels at the URIs a client already opens', async () => {
    const host = await createPluginTestHost(inspectors);
    try {
      expect(host.plugins.mcpApps()).toEqual([
        { plugin: 'inspectors', version: '1.0.0', app: runInspector },
        { plugin: 'inspectors', version: '1.0.0', app: pendingReview },
      ]);
    } finally {
      await host.dispose();
    }
    expect(runInspector.uri).toBe('ui://bureau/run-inspector/v1');
    expect(pendingReview.uri).toBe('ui://bureau/pending-review/v1');
  });

  it('links each panel to the tool a client runs to open it, one it may call', () => {
    expect(runInspector.opensFromTool).toBe('bureau.tasks.inspect');
    expect(pendingReview.opensFromTool).toBe('bureau.reviews.list');
    expect(runInspector.allowedTools).toContain(runInspector.opensFromTool);
    expect(pendingReview.allowedTools).toContain(pendingReview.opensFromTool);
  });

  it('lists every Bureau tool a page names in its source, so the list cannot drift', async () => {
    const directory = fileURLToPath(new URL('.', import.meta.url));
    for (const [app, folder] of [
      [runInspector, 'run-inspector'],
      [pendingReview, 'pending-review'],
    ] as const) {
      const named = new Set<string>();
      for await (const file of new Bun.Glob(`${folder}/*.ts`).scan(directory)) {
        if (file.endsWith('.test.ts')) continue;
        const source = await Bun.file(join(directory, file)).text();
        for (const [tool] of source.matchAll(/\bbureau\.[a-z]+\.[a-z]+\b/g)) named.add(tool);
      }
      expect(named.size, folder).toBeGreaterThan(0);
      expect([...named].toSorted(), folder).toEqual(app.allowedTools.toSorted());
    }
  });

  it('points every panel at an entry module that exists', async () => {
    for (const app of [runInspector, pendingReview]) {
      expect(await Bun.file(app.entry).exists()).toBe(true);
    }
  });
});
