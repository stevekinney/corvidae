/**
 * The failure explanation page's script (COR-2543), bundled into the `ui://` resource. It talks only
 * to its host over the MCP Apps bridge and calls one tool, `bureau.tasks.explain`, which is a read:
 * the Bureau's answer to why one run failed, from what it stored and nothing else. It holds no
 * credential, reaches no origin, and writes nothing, so the host's authorization decides the one
 * call it makes.
 *
 * The page opens one of two ways. A client that ran the explain tool hands it the result, which is
 * drawn at once, and a run's page hands it the run's `taskId`, which the page reads through the same
 * tool. Either way the run is settled when it is explained, so the page reads once and never polls:
 * a run that failed again after a retry is read by opening the page again.
 */
import { mountPanel } from '@lostgradient/cinder/panel';
import { App } from '@modelcontextprotocol/ext-apps';
import { unmount } from 'svelte';

import {
  buildExplanationModel,
  FAILURE_EXPLANATION_LABELS,
} from '@lostgradient/interborough-plugin/failure-explanation';
import { followHostTheme } from '../host-theme.ts';
import Explanation from './explanation.svelte';

import { explanationOfResult, refusalOf, runIdOf } from './model.ts';
import { createExplanationView, type ExplanationState } from './view.svelte.ts';

async function start(): Promise<void> {
  const root = document.getElementById('root');
  if (root === null) return;
  const app = new App({ name: 'bureau-failure-explanation', version: '1.0.0' });
  let runId: string | undefined;
  // Bumped whenever the page takes a new answer or a new run: a read that started under an older one is dropped.
  let generation = 0;
  let torndown = false;

  // The page is a Svelte component over this view: what the page learns goes into it, and the
  // component redraws in place.
  const view = createExplanationView();
  const mounted = mountPanel(Explanation, { target: root, props: { view } });
  const applyHostTheme = followHostTheme(app);
  const canCallServer = (): boolean => app.getHostCapabilities()?.serverTools !== undefined;

  const show = (state: ExplanationState, announcement: string): void => {
    if (torndown) return;
    view.state = state;
    view.announcement = announcement;
  };

  const adopt = (result: {
    structuredContent?: unknown;
    content?: unknown;
    isError?: boolean | undefined;
  }): boolean => {
    const explanation = explanationOfResult(result);
    if (explanation !== undefined) {
      show({ kind: 'explained', model: buildExplanationModel(explanation) }, 'Explanation loaded.');
      return true;
    }
    const refusal = refusalOf(result);
    if (refusal !== undefined) {
      // The heading, not the message the page already shows under it.
      show({ kind: 'refused', refusal }, FAILURE_EXPLANATION_LABELS.region);
      return true;
    }
    return false;
  };

  const read = async (id: string): Promise<void> => {
    generation += 1;
    const started = generation;
    if (!canCallServer()) {
      show({ kind: 'unreadable', reason: 'no-server-tools' }, '');
      return;
    }
    show({ kind: 'reading', runId: id }, '');
    try {
      const result = await app.callServerTool({
        name: 'bureau.tasks.explain',
        arguments: { runId: id },
      });
      if (started !== generation) return;
      if (!adopt(result))
        show({ kind: 'unreadable', reason: 'no-answer' }, 'The run could not be explained.');
    } catch {
      // A transport failure is the same as a host that did not answer.
      if (started === generation) {
        show({ kind: 'unreadable', reason: 'no-answer' }, 'The run could not be explained.');
      }
    }
  };

  app.ontoolinput = (params) => {
    const id = runIdOf(params.arguments);
    if (id === undefined || id === runId) return;
    runId = id;
    void read(id);
  };
  // The result that opened the page is its first render: it is the answer for the run it was given,
  // so a read of that run still in flight is dropped for it. A result the page cannot read is no
  // answer, and leaves the read it is waiting on to say what it says.
  app.ontoolresult = (result) => {
    if (adopt(result)) generation += 1;
  };
  // Closing the page drops what is in flight: nothing was written, so nothing is left behind.
  app.onteardown = async () => {
    torndown = true;
    generation += 1;
    void unmount(mounted);
    root.replaceChildren();
    return {};
  };
  await app.connect();
  applyHostTheme();
}

void start();
