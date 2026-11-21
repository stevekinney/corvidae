/**
 * The run timeline's page script (COR-2542), bundled into the `ui://` resource. It talks only to
 * its host over the MCP Apps bridge, and calls one tool: `bureau.runs.timeline`, which it reads
 * every few seconds while the page is open. It holds no credential, reaches no origin, and has no
 * control that changes a run, so closing it affects nothing.
 */
import { mountPanel } from '@lostgradient/cinder/panel';
import { App } from '@modelcontextprotocol/ext-apps';
import { unmount } from 'svelte';

import { followHostTheme } from '../host-theme.ts';
import {
  buildTimelineModel,
  describeChange,
  runIdOf,
  timelineOfResult,
  type Timeline,
  type TimelineModel,
} from './model.ts';
import TimelinePage from './timeline.svelte';
import { createTimelineView } from './view.svelte.ts';

const REFRESH_MILLISECONDS = 3000;

async function start(): Promise<void> {
  const root = document.getElementById('root');
  if (root === null) return;
  const app = new App({ name: 'bureau-run-timeline', version: '1.0.0' });
  let runId: string | undefined;
  // Bumped whenever the page switches run: a response that started under an older one is dropped.
  let generation = 0;
  // Each read takes a number when it starts; one that finishes after a later read has applied is stale.
  let started = 0;
  let applied = 0;
  let model: TimelineModel | undefined;
  let connected = true;
  let timer: ReturnType<typeof setInterval> | undefined;

  // Without the host's `serverTools` capability the page cannot call the server: it shows the
  // result that opened it, if one did.
  const canCallServer = (): boolean => app.getHostCapabilities()?.serverTools !== undefined;
  const view = createTimelineView();
  const mounted = mountPanel(TimelinePage, { target: root, props: { view } });
  const applyHostTheme = followHostTheme(app);

  const show = (timeline: Timeline, announceReconnect: boolean): void => {
    const next = buildTimelineModel(timeline, Date.now());
    const announcement = announceReconnect ? 'Reconnected.' : describeChange(model, next);
    model = next;
    view.model = next;
    view.phase = 'ready';
    if (announcement !== null) view.announcement = announcement;
  };

  const connectionLost = (): void => {
    if (connected && model !== undefined) {
      connected = false;
      view.announcement = 'Connection lost. Retrying.';
    }
  };

  // A read that did not give a timeline: the page says so when it has nothing to show, and keeps
  // what it shows, saying the connection is lost until a read gives one again, when it has.
  const unreadable = (): void => {
    if (model === undefined) view.phase = 'unreadable';
    else connectionLost();
  };

  const refresh = async (): Promise<void> => {
    const id = runId;
    const generationAtStart = generation;
    if (id === undefined) return;
    if (!canCallServer()) {
      if (model === undefined) view.phase = 'offline';
      return;
    }
    started += 1;
    const mine = started;
    try {
      const result = await app.callServerTool({
        name: 'bureau.runs.timeline',
        arguments: { runId: id },
      });
      if (generationAtStart !== generation || mine < applied) return;
      applied = mine;
      const timeline = timelineOfResult(result);
      if (timeline === undefined) return unreadable();
      const wasConnected = connected;
      connected = true;
      show(timeline, !wasConnected);
    } catch {
      // A transport failure is the same as a host that did not answer.
      if (generationAtStart === generation) unreadable();
    }
  };

  const watch = (id: string): void => {
    runId = id;
    generation += 1;
    model = undefined;
    connected = true;
    view.model = undefined;
    view.phase = 'loading';
    void refresh();
  };

  app.ontoolinput = (params) => {
    const id = runIdOf(params.arguments);
    if (id !== undefined && id !== runId) watch(id);
  };
  // The result that opened the page is its first render, whether or not the host lets it call back.
  app.ontoolresult = (result) => {
    const timeline = timelineOfResult(result);
    if (timeline === undefined) return;
    if (timeline.runId !== runId) {
      runId = timeline.runId;
      generation += 1;
      model = undefined;
    }
    show(timeline, false);
  };
  // Closing the page releases only this page's reads: the run goes on.
  app.onteardown = async () => {
    if (timer !== undefined) clearInterval(timer);
    generation += 1;
    void unmount(mounted);
    root.replaceChildren();
    return {};
  };
  await app.connect();
  applyHostTheme();
  // poll-reason: mcp-transport
  timer = setInterval(() => void refresh(), REFRESH_MILLISECONDS);
}

void start();
