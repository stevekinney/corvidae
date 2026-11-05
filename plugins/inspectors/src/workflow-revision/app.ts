import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';

type Definition = {
  readonly [key: string]: unknown;
  readonly title?: string;
  readonly description?: string;
  readonly agent?: string;
  readonly paused?: boolean;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly trigger: Record<string, unknown>;
  readonly steps: readonly Record<string, unknown>[];
};

type Workflow = { readonly id: string; readonly hash: string; readonly text: string };
type RevisionState =
  | 'loading'
  | 'changed'
  | 'no-changes'
  | 'applying'
  | 'applied'
  | 'conflict'
  | 'denied'
  | 'offline'
  | 'unknown'
  | 'retryable';

type ProposalResult = {
  readonly status: 'ok';
  readonly id: string;
  readonly baseHash: string;
  readonly proposedText: string;
};

function structured<T>(
  result: { structuredContent?: unknown; isError?: boolean | undefined },
  guard: (value: unknown) => value is T,
): T | undefined {
  return result.isError !== true && guard(result.structuredContent)
    ? result.structuredContent
    : undefined;
}

function structuredResult(value: { structuredContent?: unknown; content?: unknown }): unknown {
  if (typeof value.structuredContent === 'string') {
    try {
      return JSON.parse(value.structuredContent) as unknown;
    } catch {
      return undefined;
    }
  }
  if (value.structuredContent !== undefined) return value.structuredContent;
  if (!Array.isArray(value.content)) return undefined;
  const textBlock = value.content.find(
    (block): block is { readonly text: string } =>
      isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string',
  );
  if (textBlock === undefined) return undefined;
  try {
    return JSON.parse(textBlock.text) as unknown;
  } catch {
    return undefined;
  }
}

function isWorkflow(value: unknown): value is Workflow {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'id') === 'string' &&
    typeof Reflect.get(value, 'hash') === 'string' &&
    typeof Reflect.get(value, 'text') === 'string'
  );
}

function isResult(
  value: unknown,
): value is { readonly status: string; readonly currentHash?: string; readonly id?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (typeof Reflect.get(value, 'status') === 'string' ||
      typeof Reflect.get(value, 'hash') === 'string')
  );
}

function isProposalResult(value: unknown): value is ProposalResult {
  return (
    isRecord(value) &&
    value['status'] === 'ok' &&
    typeof value['id'] === 'string' &&
    typeof value['baseHash'] === 'string' &&
    typeof value['proposedText'] === 'string'
  );
}

function text(value: unknown): string {
  if (value === undefined) return 'Not present';
  if (value === null) return 'None';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function definitionFromCanonicalText(value: string): Definition | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || !isRecord(parsed['trigger']) || !Array.isArray(parsed['steps']))
      return undefined;
    if (!parsed['steps'].every(isRecord)) return undefined;
    const { name: _name, ...definition } = parsed;
    return definition as Definition;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function changedRows(current: Definition, proposed: Definition): HTMLElement[] {
  const rows: HTMLElement[] = [];
  const add = (label: string, oldValue: unknown, newValue: unknown): void => {
    const row = document.createElement('div');
    row.className = 'revision-row';
    const state = same(oldValue, newValue)
      ? 'unchanged'
      : oldValue === undefined || oldValue === null
        ? 'added'
        : newValue === undefined || newValue === null
          ? 'removed'
          : 'changed';
    row.dataset['state'] = state;
    const name = document.createElement('strong');
    name.textContent = label;
    const marker = document.createElement('span');
    marker.className = 'revision-row__marker';
    marker.textContent = `${state.at(0)?.toUpperCase() ?? ''}${state.slice(1)}`;
    const currentValue = document.createElement('pre');
    currentValue.textContent = text(oldValue);
    const proposedValue = document.createElement('pre');
    proposedValue.textContent = text(newValue);
    const currentBlock = document.createElement('div');
    currentBlock.className = 'revision-value revision-value--current';
    const currentLabel = document.createElement('span');
    currentLabel.className = 'revision-value__label';
    currentLabel.textContent = 'Current definition';
    currentBlock.append(currentLabel, currentValue);
    const proposedBlock = document.createElement('div');
    proposedBlock.className = 'revision-value revision-value--proposed';
    const proposedLabel = document.createElement('span');
    proposedLabel.className = 'revision-value__label';
    proposedLabel.textContent = 'Proposed definition';
    proposedBlock.append(proposedLabel, proposedValue);
    row.append(name, marker, currentBlock, proposedBlock);
    rows.push(row);
  };
  for (const key of [
    'title',
    'description',
    'agent',
    'paused',
    'inputSchema',
    'outputSchema',
  ] as const) {
    add(key, current[key] ?? null, proposed[key] ?? null);
  }
  add('Trigger', current.trigger, proposed.trigger);
  const length = Math.max(current.steps.length, proposed.steps.length);
  for (let index = 0; index < length; index += 1) {
    add(`Step ${String(index + 1)}`, current.steps[index] ?? null, proposed.steps[index] ?? null);
  }
  return rows;
}

function changedCount(rows: readonly HTMLElement[]): number {
  return rows.filter((row) => row.dataset['state'] !== 'unchanged').length;
}

function render(
  root: HTMLElement,
  current: Definition,
  proposed: Definition,
  state: RevisionState,
  changeCount: number,
  message: string | undefined,
  onApply: () => void,
  onCheckHash: () => void,
): void {
  root.replaceChildren();
  const title = document.createElement('h1');
  title.textContent = 'Review workflow revision';
  root.append(title);
  const status = document.createElement('p');
  status.className = `revision-status revision-status--${state}`;
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent =
    message ??
    (state === 'loading'
      ? 'Loading the current workflow definition…'
      : state === 'no-changes'
        ? 'No changes in this proposal.'
        : state === 'applying'
          ? 'Applying the approved revision…'
          : state === 'applied'
            ? 'Applied. The workflow now matches the proposed definition.'
            : state === 'conflict'
              ? 'The file changed since the proposal. Check the current definition before retrying.'
              : state === 'denied'
                ? 'You do not have access to apply this revision. No changes were made.'
                : state === 'offline'
                  ? 'Could not confirm the update. Check the current definition before retrying.'
                  : state === 'unknown'
                    ? 'The update returned an unknown result. Check the current definition before retrying.'
                    : state === 'retryable'
                      ? 'The base hash is current. Retry Apply when ready.'
                      : `Review ${String(changeCount)} visible change${changeCount === 1 ? '' : 's'} before applying.`);
  root.append(status);
  const comparison = document.createElement('div');
  comparison.className = 'revision-comparison';
  comparison.setAttribute('role', 'region');
  comparison.setAttribute('aria-label', 'Workflow definition comparison');
  comparison.tabIndex = 0;
  const heading = document.createElement('h2');
  heading.textContent = 'Current and proposed';
  const columns = document.createElement('div');
  columns.className = 'revision-columns';
  const changeHeading = document.createElement('span');
  const currentHeading = document.createElement('span');
  const proposedHeading = document.createElement('span');
  columns.append(document.createElement('span'), changeHeading, currentHeading, proposedHeading);
  changeHeading.textContent = 'Change';
  currentHeading.textContent = 'Current';
  proposedHeading.textContent = 'Proposed';
  const rows = changedRows(current, proposed);
  comparison.append(heading, columns, ...rows);
  root.append(comparison);
  const footer = document.createElement('footer');
  if (state === 'offline' || state === 'unknown' || state === 'retryable') {
    const check = document.createElement('button');
    check.type = 'button';
    check.textContent = 'Check current hash';
    check.disabled = state === 'retryable';
    check.addEventListener('click', onCheckHash);
    footer.append(check);
  }
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.textContent =
    state === 'applying'
      ? 'Applying…'
      : state === 'applied'
        ? 'Applied'
        : state === 'retryable'
          ? 'Retry Apply'
          : 'Apply';
  apply.disabled = !['changed', 'retryable'].includes(state);
  apply.addEventListener('click', onApply);
  footer.append(apply);
  root.append(footer);
}

async function start(): Promise<void> {
  const root = document.getElementById('root');
  if (root === null) return;
  const app = new App({ name: 'bureau-workflow-revision-review', version: '1.0.0' });
  const applyHostContext = (context: McpUiHostContext | undefined): void => {
    if (context?.theme !== undefined) applyDocumentTheme(context.theme);
    if (context?.styles?.variables !== undefined) applyHostStyleVariables(context.styles.variables);
  };
  app.onhostcontextchanged = (context) => applyHostContext(context);
  let argumentsOfCall: Record<string, unknown> = {};
  let baseHash = '';
  let current: Workflow | undefined;
  let proposed: Definition | undefined;
  let applying = false;
  let tornDown = false;
  const loading = document.createElement('p');
  loading.setAttribute('role', 'status');
  loading.setAttribute('aria-live', 'polite');
  loading.textContent = 'Loading workflow revision…';
  root.append(loading);

  const show = (state: RevisionState, message?: string): void => {
    if (tornDown || current === undefined || proposed === undefined) return;
    const currentDefinition = definitionFromCanonicalText(current.text);
    if (currentDefinition === undefined) return;
    render(
      root,
      currentDefinition,
      proposed,
      state,
      changedCount(changedRows(currentDefinition, proposed)),
      message,
      () => void apply(),
      () => void checkHash(),
    );
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
      const state = same(currentDefinition, proposed) ? 'no-changes' : 'changed';
      show(state);
    } catch {
      if (!tornDown) root.textContent = 'The current workflow could not be read.';
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
    root.replaceChildren();
    return {};
  };
  await app.connect();
  applyHostContext(app.getHostContext());
}

void start();
