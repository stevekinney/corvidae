/**
 * The run comparison's page script (COR-2544), bundled into the `ui://` resource. It talks only to
 * its host over the MCP Apps bridge: it reads the fork and its source through `bureau.runs.compare`,
 * so the host's authorization decides every call. It holds no credential and reaches no origin.
 *
 * The run to compare comes from the tool input: `runId` when a client opens the page from the compare
 * tool, `taskId` when a run's page mounts it, which names every run panel's run the same way. The
 * server pages the comparison by step, so the page follows `nextCursor` until the last page and
 * shows one whole comparison. A refusal (a run that is not a fork, a source the caller may not
 * read) is the server's message, shown as it was written.
 */
import { mountPanel } from '@lostgradient/cinder/panel';
import { App } from '@modelcontextprotocol/ext-apps';
import { unmount } from 'svelte';

import { followHostTheme } from '../host-theme.ts';
import Comparison from './comparison.svelte';
import {
  buildComparisonModel,
  isComparison,
  isRecord,
  resultMessage,
  type Comparison as ComparisonData,
} from './model.ts';
import { createComparisonView } from './view.svelte.ts';

/** The steps one page asks for: the most the server allows. */
const PAGE_LIMIT = 1000;

type ToolResult = Awaited<ReturnType<App['callServerTool']>>;

async function start(): Promise<void> {
  const root = document.getElementById('root');
  if (root === null) return;
  const app = new App({ name: 'bureau-run-comparison', version: '1.0.0' });
  // Bumped whenever the page switches run: a response that started under an older one is dropped.
  let generation = 0;
  let runId: string | undefined;
  let tornDown = false;

  // Without the host's `serverTools` capability the page cannot call the server: it shows the
  // result that opened it, if any.
  const canCallServer = (): boolean => app.getHostCapabilities()?.serverTools !== undefined;
  const view = createComparisonView();
  const mounted = mountPanel(Comparison, { target: root, props: { view } });
  const applyHostTheme = followHostTheme(app);

  const showComparison = (comparison: ComparisonData): void => {
    view.model = buildComparisonModel(comparison);
    view.message = undefined;
    view.phase = 'ready';
    // A step the new comparison no longer holds is not open.
    const open = view.selectedIndex;
    if (
      open !== undefined &&
      !comparison.steps.some((step) => step.index === open && !step.shared)
    ) {
      view.selectedIndex = undefined;
    }
  };

  const showMessage = (message: string): void => {
    view.model = undefined;
    view.message = message;
    view.phase = 'message';
  };

  /** The comparison's pages from `first` on, joined; the server's message when it refuses one. */
  const readAll = async (
    id: string,
    first: ComparisonData | undefined,
    started: number,
  ): Promise<void> => {
    const steps = first === undefined ? [] : [...first.steps];
    let head = first;
    let cursor = first?.nextCursor;
    // The first page is asked for when no page is in hand; every later one when the last named a next.
    while (head === undefined || cursor !== undefined) {
      const result: ToolResult = await app.callServerTool({
        name: 'bureau.runs.compare',
        arguments: { runId: id, limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
      });
      if (started !== generation || tornDown) return;
      if (result.isError === true) {
        showMessage(resultMessage(result) ?? 'The server could not compare this run.');
        return;
      }
      const page: unknown = result.structuredContent;
      if (!isComparison(page)) {
        view.phase = 'failed';
        return;
      }
      head ??= page;
      steps.push(...page.steps);
      cursor = page.nextCursor;
    }
    showComparison({ ...head, steps, nextCursor: undefined });
  };

  const watch = (id: string): void => {
    runId = id;
    generation += 1;
    const started = generation;
    view.phase = 'loading';
    view.model = undefined;
    view.message = undefined;
    view.selectedIndex = undefined;
    if (!canCallServer()) return;
    readAll(id, undefined, started).catch(() => {
      // A transport failure is the same as a host that did not answer.
      if (started === generation && !tornDown) view.phase = 'failed';
    });
  };

  app.ontoolinput = (params) => {
    const arguments_ = isRecord(params.arguments) ? params.arguments : {};
    const id = arguments_['runId'] ?? arguments_['taskId'];
    if (typeof id === 'string' && id !== runId) watch(id);
  };
  // The result that opened the page is its first render, whether or not the host lets it call back.
  app.ontoolresult = (result) => {
    // A page that is already showing a comparison, or reading one, is not rewritten by the same call's result.
    if (view.phase !== 'loading') return;
    if (result.isError === true) {
      showMessage(resultMessage(result) ?? 'The server could not compare this run.');
      return;
    }
    if (!isComparison(result.structuredContent)) return;
    const opened = result.structuredContent;
    runId = opened.runId;
    if (opened.nextCursor === undefined || !canCallServer()) {
      showComparison(opened);
      return;
    }
    generation += 1;
    const started = generation;
    readAll(opened.runId, opened, started).catch(() => {
      if (started === generation && !tornDown) view.phase = 'failed';
    });
  };
  // Closing the page releases only this page's observation: both runs are untouched.
  app.onteardown = async () => {
    tornDown = true;
    generation += 1;
    void unmount(mounted);
    root.replaceChildren();
    return {};
  };
  await app.connect();
  applyHostTheme();
}

void start();
