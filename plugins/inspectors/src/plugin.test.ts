import { HOST_PANEL_OPERATIONS } from '@lostgradient/bureau';
import { createPluginTestHost } from '@lostgradient/bureau/testing';
import { pluginContract } from '@lostgradient/interborough-plugin/testing';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import inspectors, {
  pendingReview,
  runInspector,
  runTimeline,
  scheduleEditor,
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
        { plugin: 'inspectors', version: '1.0.1', app: scheduleEditor },
        { plugin: 'inspectors', version: '1.0.1', app: runTimeline },
      ]);
    } finally {
      await host.dispose();
    }
    expect(runInspector.uri).toBe('ui://inspectors/run-inspector/v1');
    expect(pendingReview.uri).toBe('ui://inspectors/pending-review/v1');
    expect(workflowRevisionReview.uri).toBe('ui://inspectors/workflow-revision-review/v1');
    expect(scheduleEditor.uri).toBe('ui://inspectors/schedule-editor/v1');
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

  it('places the schedule editor on a page of its own and on a run’s page, and nowhere else (COR-2545)', () => {
    expect(scheduleEditor.placements).toEqual([
      { kind: 'page', path: 'schedules' },
      { kind: 'run' },
    ]);
    // No tool opens it: a page panel needs no MCP opener, and a model has no way to open an editor
    // whose writes it may not make.
    expect(scheduleEditor.opensFromTool).toBeUndefined();
  });

  it('declares the four schedule writes host-only, each one the Bureau opens to a panel (COR-2545)', () => {
    expect(scheduleEditor.hostOnlyTools?.toSorted()).toEqual([
      'bureau.schedules.create',
      'bureau.schedules.pause',
      'bureau.schedules.resume',
      'bureau.schedules.update',
    ]);
    for (const tool of scheduleEditor.hostOnlyTools ?? []) {
      expect(scheduleEditor.allowedTools, tool).toContain(tool);
      expect(HOST_PANEL_OPERATIONS.has(tool), tool).toBe(true);
    }
    // No other panel opens a schedule write.
    for (const other of [runInspector, pendingReview, workflowRevisionReview]) {
      expect(other.allowedTools.filter((tool) => tool.startsWith('bureau.schedules.'))).toEqual([]);
    }
  });

  it('lists every Bureau tool a page names in its source, so the list cannot drift', async () => {
    const directory = fileURLToPath(new URL('.', import.meta.url));
    for (const [app, folder] of [
      [runInspector, 'run-inspector'],
      [pendingReview, 'pending-review'],
      [workflowRevisionReview, 'workflow-revision'],
      [scheduleEditor, 'schedule-editor'],
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

  it('imports the one schedule form state the application’s schedule form imports, and defines none of its own (COR-2545)', async () => {
    const directory = fileURLToPath(new URL('.', import.meta.url));
    const specifier = '@lostgradient/interborough-plugin/schedule-form';
    const panel = await Bun.file(join(directory, 'schedule-editor/app.ts')).text();
    expect(panel).toContain(specifier);
    const form = await Bun.file(
      join(
        directory,
        '../../../applications/interborough/src/routes/schedules/agent-schedule-form-state.svelte.ts',
      ),
    ).text();
    expect(form).toContain(specifier);

    const offenders: string[] = [];
    for await (const file of new Bun.Glob('**/*.{ts,svelte}').scan(directory)) {
      if (file.endsWith('.test.ts')) continue;
      const source = await Bun.file(join(directory, file)).text();
      // A form state is a class or a type of a draft, or the functions that make a save's calls.
      if (
        /\bclass\s+\w*Schedule\w*Form\w*/i.test(source) ||
        /\b(type|interface)\s+Schedule(Draft|Form\w*)\s*[={<]/.test(source) ||
        /\bfunction\s+(scheduleSavePlan|scheduleDraftErrors|scheduleCreateArguments|scheduleUpdateFields)\b/.test(
          source,
        ) ||
        /schedule-form/i.test(file)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('holds a row for the schedule editor in the panel tables of both READMEs (COR-2545)', async () => {
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
    for (const readme of ['plugins/inspectors/README.md', 'packages/bureau/README.md']) {
      const text = await Bun.file(join(root, readme)).text();
      const rows = text
        .split('\n')
        .filter((line) => line.startsWith('|') && line.includes(scheduleEditor.uri));
      expect(rows, readme).toHaveLength(1);
    }
  });

  it('points every panel at an entry module that exists', async () => {
    for (const app of [
      runInspector,
      pendingReview,
      workflowRevisionReview,
      scheduleEditor,
      runTimeline,
    ]) {
      expect(await Bun.file(app.entry).exists()).toBe(true);
    }
  });
});
