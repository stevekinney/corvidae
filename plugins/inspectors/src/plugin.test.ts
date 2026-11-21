import { createPluginTestHost } from '@lostgradient/bureau/testing';
import { pluginContract } from '@lostgradient/interborough-plugin/testing';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import inspectors, {
  pendingReview,
  runInspector,
  runTimeline,
  workflowRevisionReview,
} from './plugin.ts';

pluginContract(inspectors, { createHost: createPluginTestHost });

describe('the inspectors plugin', () => {
  it('contributes the panels at the URIs a client already opens', async () => {
    const host = await createPluginTestHost(inspectors);
    try {
      expect(host.plugins.panels()).toEqual([
        { plugin: 'inspectors', version: '1.0.1', app: runInspector },
        { plugin: 'inspectors', version: '1.0.1', app: pendingReview },
        { plugin: 'inspectors', version: '1.0.1', app: workflowRevisionReview },
        { plugin: 'inspectors', version: '1.0.1', app: runTimeline },
      ]);
    } finally {
      await host.dispose();
    }
    expect(runInspector.uri).toBe('ui://inspectors/run-inspector/v1');
    expect(pendingReview.uri).toBe('ui://inspectors/pending-review/v1');
    expect(workflowRevisionReview.uri).toBe('ui://inspectors/workflow-revision-review/v1');
    expect(runTimeline.uri).toBe('ui://inspectors/run-timeline/v1');
  });

  it('links each panel to the tool a client runs to open it, one it may call', () => {
    expect(runInspector.opensFromTool).toBe('bureau.tasks.inspect');
    expect(pendingReview.opensFromTool).toBe('bureau.reviews.list');
    expect(runInspector.allowedTools).toContain('bureau.tasks.inspect');
    expect(pendingReview.allowedTools).toContain('bureau.reviews.list');
    expect(runInspector.placements).toEqual([{ kind: 'run' }]);
    expect(pendingReview.placements).toBeUndefined();
    expect(workflowRevisionReview.placements).toEqual([
      { kind: 'chat-tool', agentTool: 'bureau:workflows-propose-update' },
    ]);
    expect(workflowRevisionReview.opensFromTool).toBe('bureau.workflows.update');
    expect(workflowRevisionReview.allowedTools).toContain('bureau.workflows.update');
    expect(runTimeline.opensFromTool).toBe('bureau.runs.timeline');
    expect(runTimeline.placements).toEqual([
      { kind: 'run' },
      { kind: 'chat-tool', agentTool: 'bureau:runs-timeline' },
    ]);
  });

  it('lets the run timeline call the timeline read and no other tool', () => {
    expect(runTimeline.allowedTools).toEqual(['bureau.runs.timeline']);
    expect(runTimeline.hostOnlyTools).toBeUndefined();
  });

  it('lists every Bureau tool a page names in its source, so the list cannot drift', async () => {
    const directory = fileURLToPath(new URL('.', import.meta.url));
    for (const [app, folder] of [
      [runInspector, 'run-inspector'],
      [pendingReview, 'pending-review'],
      [workflowRevisionReview, 'workflow-revision'],
      [runTimeline, 'run-timeline'],
    ] as const) {
      const named = new Set<string>();
      // The page's script and its components (`.svelte`): a tool a component calls is listed too.
      for await (const file of new Bun.Glob(`${folder}/*.{ts,svelte}`).scan(directory)) {
        if (file.endsWith('.test.ts')) continue;
        const source = await Bun.file(join(directory, file)).text();
        for (const [tool] of source.matchAll(/\bbureau\.[a-z]+\.[a-z]+\b/g)) named.add(tool);
      }
      expect(named.size, folder).toBeGreaterThan(0);
      expect([...named].toSorted(), folder).toEqual(app.allowedTools.toSorted());
    }
  });

  it('points every panel at an entry module that exists', async () => {
    for (const app of [runInspector, pendingReview, workflowRevisionReview, runTimeline]) {
      expect(await Bun.file(app.entry).exists()).toBe(true);
    }
  });
});
