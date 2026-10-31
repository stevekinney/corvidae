import { createPluginTestHost } from '@lostgradient/bureau/testing';
import { pluginContract } from '@lostgradient/interborough-plugin/testing';
import { describe, expect, it } from 'bun:test';

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

  it('links each panel to the tool a client runs to open it', () => {
    expect(runInspector.allowedTools).toEqual(['bureau.tasks.inspect']);
    expect(pendingReview.allowedTools).toEqual(['bureau.reviews.list']);
  });

  it('points every panel at an entry module that exists', async () => {
    for (const app of [runInspector, pendingReview]) {
      expect(await Bun.file(app.entry).exists()).toBe(true);
    }
  });
});
