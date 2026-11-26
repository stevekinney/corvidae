import { createBureauCatalogSnapshot, HOST_PANEL_OPERATIONS } from '@lostgradient/bureau';
import { createReviewsClientWithTransport } from '@lostgradient/bureau-client/reviews';
import { createPluginTestHost } from '@lostgradient/bureau/testing';
import { pluginContract } from '@lostgradient/interborough-plugin/testing';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import inspectors, {
  failureExplanation,
  pendingReview,
  runComparison,
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
        { plugin: 'inspectors', version: '1.0.1', app: failureExplanation },
        { plugin: 'inspectors', version: '1.0.1', app: runComparison },
      ]);
    } finally {
      await host.dispose();
    }
    expect(runInspector.uri).toBe('ui://inspectors/run-inspector/v1');
    expect(pendingReview.uri).toBe('ui://inspectors/pending-review/v1');
    expect(workflowRevisionReview.uri).toBe('ui://inspectors/workflow-revision-review/v1');
    expect(scheduleEditor.uri).toBe('ui://inspectors/schedule-editor/v1');
    expect(runTimeline.uri).toBe('ui://inspectors/run-timeline/v1');
    expect(runComparison.uri).toBe('ui://inspectors/run-comparison/v1');
  });

  it('declares the run comparison’s run-page placement and opens it from the compare tool (COR-2544)', () => {
    expect(runComparison.placements).toEqual([{ kind: 'run' }]);
    expect(runComparison.opensFromTool).toBe('bureau.runs.compare');
    expect(runComparison.allowedTools).toEqual(['bureau.runs.compare']);
    expect(runComparison.hostOnlyTools).toBeUndefined();
  });

  it('keeps the failure explanation’s URI (COR-2543)', () => {
    // The URI is a one-way door (COR-2543): clients that opened the panel by it keep opening it.
    expect(failureExplanation.uri).toBe('ui://inspectors/failure-explanation/v1');
  });

  it('opens the failure explanation from the explain tool and places it on a run’s page, calling no other tool (COR-2543)', () => {
    expect(failureExplanation.opensFromTool).toBe('bureau.tasks.explain');
    // Coordinator, 2026-11-22: shown only for failed runs, and opened in Chat by the agent tool that
    // explains a run.
    expect(failureExplanation.placements).toEqual([
      { kind: 'run', when: 'failed' },
      { kind: 'chat-tool', agentTool: 'bureau:tasks-explain' },
    ]);
    // AC4: the one tool it calls is the explain read, and it is no write: nothing is host-only.
    expect(failureExplanation.allowedTools).toEqual(['bureau.tasks.explain']);
    expect(failureExplanation.hostOnlyTools).toBeUndefined();
    // No other panel claims the tool, so the Bureau links it to this page alone.
    for (const other of [runInspector, pendingReview, workflowRevisionReview, scheduleEditor]) {
      expect(other.opensFromTool).not.toBe('bureau.tasks.explain');
    }
  });

  it('keeps the explain read a read, so the panel adds no write (COR-2543)', () => {
    const explain = createBureauCatalogSnapshot().operations.find(
      (operation) => operation.name === 'bureau.tasks.explain',
    );
    expect(explain).toMatchObject({ destructive: false });
    expect(failureExplanation.allowedTools.every((tool) => tool === explain?.name)).toBe(true);
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
      [workflowRevisionReview, 'workflow-revision'],
      [scheduleEditor, 'schedule-editor'],
      [runTimeline, 'run-timeline'],
      [failureExplanation, 'failure-explanation'],
      [runComparison, 'run-comparison'],
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

  it('declares exactly the generated Reviews operations for the pending-review panel', () => {
    const client = createReviewsClientWithTransport(async () => undefined);
    expect(Object.keys(client).toSorted()).toEqual(pendingReview.allowedTools.toSorted());
    expect(pendingReview.allowedTools).not.toContain('demo.refunds.request');
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

  it('holds a row for the schedule editor and the failure explanation in the panel tables of both READMEs (COR-2545, COR-2543)', async () => {
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
    for (const readme of ['plugins/inspectors/README.md', 'packages/bureau/README.md']) {
      const text = await Bun.file(join(root, readme)).text();
      for (const panel of [scheduleEditor, failureExplanation]) {
        const rows = text
          .split('\n')
          .filter((line) => line.startsWith('|') && line.includes(panel.uri));
        expect([readme, panel.name, rows.length]).toEqual([readme, panel.name, 1]);
      }
    }
  });

  it('points every panel at an entry module that exists', async () => {
    for (const app of [
      runInspector,
      pendingReview,
      workflowRevisionReview,
      scheduleEditor,
      runTimeline,
      failureExplanation,
      runComparison,
    ]) {
      expect(await Bun.file(app.entry).exists()).toBe(true);
    }
  });
});
