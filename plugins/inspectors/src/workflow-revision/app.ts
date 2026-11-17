/**
 * The workflow revision review's page script (COR-2218), bundled into the `ui://` resource. It
 * talks only to its host over the MCP Apps bridge: it reads the workflow through
 * `bureau.workflows.get` and applies the approved revision through `bureau.workflows.update`, so
 * the host's authorization decides every call. It holds no credential and reaches no origin.
 */
import { mountPanel } from '@lostgradient/cinder/panel';
import { App } from '@modelcontextprotocol/ext-apps';
import { unmount } from 'svelte';

import { followHostTheme } from '../host-theme.ts';
import {
  changedCount,
  definitionFromCanonicalText,
  isProposalResult,
  isRecord,
  isResult,
  isWorkflow,
  revisionRows,
  sameValue,
  structured,
  structuredResult,
  type Definition,
  type ProposalResult,
  type RevisionState,
  type Workflow,
} from './model.ts';
import RevisionReview from './revision-review.svelte';
import { createRevisionView } from './view.svelte.ts';

async function start(): Promise<void> {
  const root = document.getElementById('root');
  if (root === null) return;
  const app = new App({ name: 'bureau-workflow-revision-review', version: '1.0.0' });
  const applyHostTheme = followHostTheme(app);
  let argumentsOfCall: Record<string, unknown> = {};
  let baseHash = '';
  let current: Workflow | undefined;
  let proposed: Definition | undefined;
  let applying = false;
  let tornDown = false;

  // The page is a Svelte component over this view: the script sets what the review says, and the
  // component redraws in place.
  const view = createRevisionView();
  const mounted = mountPanel(RevisionReview, {
    target: root,
    props: { view, onApply: () => void apply(), onCheckHash: () => void checkHash() },
  });

  const show = (state: RevisionState, message?: string): void => {
    if (tornDown || current === undefined || proposed === undefined) return;
    const currentDefinition = definitionFromCanonicalText(current.text);
    if (currentDefinition === undefined) return;
    const rows = revisionRows(currentDefinition, proposed);
    view.rows = rows;
    view.changeCount = changedCount(rows);
    view.state = state;
    view.message = message;
    view.phase = 'ready';
  };
  const inspect = async (): Promise<void> => {
    const id = argumentsOfCall['id'];
    if (typeof id !== 'string' || proposal === undefined || proposal.id !== id) {
      return;
    }
    const nextProposed = definitionFromCanonicalText(proposal.proposedText);
    if (nextProposed === undefined) return;
    proposed = nextProposed;
    baseHash = proposal.baseHash;
    try {
      const result = await app.callServerTool({ name: 'bureau.workflows.get', arguments: { id } });
      current = structured(result, isWorkflow);
      if (current === undefined) return;
      const currentDefinition = definitionFromCanonicalText(current.text);
      if (currentDefinition === undefined) return;
      const state = sameValue(currentDefinition, proposed) ? 'no-changes' : 'changed';
      show(state);
    } catch {
      if (!tornDown) view.phase = 'failed';
    }
  };
  const checkHash = async (): Promise<void> => {
    if (typeof argumentsOfCall['id'] !== 'string' || proposed === undefined) return;
    try {
      const result = await app.callServerTool({
        name: 'bureau.workflows.get',
        arguments: { id: argumentsOfCall['id'] },
      });
      const checked = structured(result, isWorkflow);
      if (checked === undefined) return show('offline');
      current = checked;
      if (checked.hash === baseHash) show('retryable');
      else show('conflict');
    } catch {
      show('offline');
    }
  };
  const apply = async (): Promise<void> => {
    if (applying || proposed === undefined || typeof argumentsOfCall['id'] !== 'string') return;
    applying = true;
    show('applying');
    try {
      const result = await app.callServerTool({
        name: 'bureau.workflows.update',
        arguments: { id: argumentsOfCall['id'], expectedHash: baseHash, definition: proposed },
      });
      const outcomeValue = structuredResult(result);
      const outcome = isResult(outcomeValue) ? outcomeValue : undefined;
      const resultText = JSON.stringify(outcomeValue ?? result.content ?? '').toLowerCase();
      if (
        outcome !== undefined &&
        (outcome.status === 'ok' || typeof Reflect.get(outcome, 'hash') === 'string')
      )
        show('applied', `Applied. New hash: ${String(Reflect.get(outcome, 'hash') ?? '')}`);
      else if (
        outcome?.status === 'conflict' ||
        resultText.includes('stale') ||
        resultText.includes('changed')
      )
        show('conflict');
      else if (
        resultText.includes('forbidden') ||
        resultText.includes('unauthorized') ||
        resultText.includes('access')
      )
        show('denied');
      else if (result.isError === true) show('offline');
      else show('unknown');
    } catch {
      show('offline');
    } finally {
      applying = false;
    }
  };
  app.ontoolinput = (params) => {
    argumentsOfCall = isRecord(params.arguments) ? params.arguments : {};
    if (proposal !== undefined) void inspect();
  };
  let proposal: ProposalResult | undefined;
  app.ontoolresult = (result) => {
    const value = structuredResult(result);
    proposal = isProposalResult(value) ? value : undefined;
    if (proposal !== undefined) void inspect();
  };
  app.onteardown = async () => {
    tornDown = true;
    void unmount(mounted);
    root.replaceChildren();
    return {};
  };
  await app.connect();
  applyHostTheme();
}

void start();
