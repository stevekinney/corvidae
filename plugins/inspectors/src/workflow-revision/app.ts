import { App } from '@modelcontextprotocol/ext-apps';

type Definition = {
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

function structured<T>(
  result: { structuredContent?: unknown; isError?: boolean | undefined },
  guard: (value: unknown) => value is T,
): T | undefined {
  return result.isError !== true && guard(result.structuredContent)
    ? result.structuredContent
    : undefined;
}

function structuredResult(value: { structuredContent?: unknown; content?: unknown }): unknown {
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

function text(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function definitionFrom(args: Record<string, unknown>): Definition | undefined {
  if (!isRecord(args['trigger']) || !Array.isArray(args['steps'])) return undefined;
  return {
    ...(typeof args['title'] === 'string' ? { title: args['title'] } : {}),
    ...(typeof args['description'] === 'string' ? { description: args['description'] } : {}),
    ...(typeof args['agent'] === 'string' ? { agent: args['agent'] } : {}),
    ...(typeof args['paused'] === 'boolean' ? { paused: args['paused'] } : {}),
    ...(args['inputSchema'] === undefined ? {} : { inputSchema: args['inputSchema'] }),
    ...(args['outputSchema'] === undefined ? {} : { outputSchema: args['outputSchema'] }),
    trigger: args['trigger'],
    steps: args['steps'].filter(isRecord),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function changedRows(current: Definition, proposed: Definition): HTMLElement[] {
  const rows: HTMLElement[] = [];
  const add = (label: string, oldValue: unknown, newValue: unknown): void => {
    const row = document.createElement('div');
    row.className = 'revision-row';
    const state = same(oldValue, newValue) ? 'unchanged' : 'changed';
    row.dataset['state'] = state;
    row.innerHTML = `<strong>${label}</strong><span>${state === 'unchanged' ? 'Unchanged' : 'Changed'}</span><pre>${text(oldValue)}</pre><pre>${text(newValue)}</pre>`;
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

function render(
  root: HTMLElement,
  current: Definition,
  proposed: Definition,
  state: string,
  message: string | undefined,
  onApply: () => void,
  disabled: boolean,
): void {
  root.replaceChildren();
  const title = document.createElement('h1');
  title.textContent = 'Review workflow revision';
  root.append(title);
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent =
    message ??
    (state === 'no-changes'
      ? 'No changes in this proposal.'
      : state === 'applied'
        ? 'Applied.'
        : 'Review the four visible changes before applying.');
  root.append(status);
  const comparison = document.createElement('div');
  comparison.className = 'revision-comparison';
  const heading = document.createElement('h2');
  heading.textContent = 'Current and proposed';
  comparison.append(heading, ...changedRows(current, proposed));
  root.append(comparison);
  const footer = document.createElement('footer');
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.textContent = 'Apply';
  apply.disabled = disabled || state !== 'changed';
  apply.addEventListener('click', onApply);
  footer.append(apply);
  root.append(footer);
}

async function start(): Promise<void> {
  const root = document.getElementById('root');
  if (root === null) return;
  const app = new App({ name: 'bureau-workflow-revision-review', version: '1.0.0' });
  let argumentsOfCall: Record<string, unknown> = {};
  let baseHash = '';
  let current: Workflow | undefined;
  let proposed: Definition | undefined;
  let tornDown = false;
  const loading = document.createElement('p');
  loading.setAttribute('role', 'status');
  loading.setAttribute('aria-live', 'polite');
  loading.textContent = 'Loading workflow revision…';
  root.append(loading);

  const show = (state: string, message?: string): void => {
    if (tornDown || current === undefined || proposed === undefined) return;
    render(
      root,
      JSON.parse(current.text) as Definition,
      proposed,
      state,
      message,
      () => void apply(),
      false,
    );
  };
  const inspect = async (): Promise<void> => {
    const id = argumentsOfCall['id'];
    const expectedHash = argumentsOfCall['expectedHash'];
    proposed = definitionFrom(argumentsOfCall);
    if (typeof id !== 'string' || typeof expectedHash !== 'string' || proposed === undefined)
      return;
    baseHash = expectedHash;
    try {
      const result = await app.callServerTool({ name: 'bureau.workflows.get', arguments: { id } });
      current = structured(result, isWorkflow);
      if (current === undefined) return;
      const state = same(JSON.parse(current.text), proposed) ? 'no-changes' : 'changed';
      show(state);
    } catch {
      if (!tornDown) root.textContent = 'The current workflow could not be read.';
    }
  };
  const apply = async (): Promise<void> => {
    if (proposed === undefined || typeof argumentsOfCall['id'] !== 'string') return;
    const result = await app.callServerTool({
      name: 'bureau.workflows.update',
      arguments: { id: argumentsOfCall['id'], expectedHash: baseHash, definition: proposed },
    });
    const outcomeValue = structuredResult(result);
    const outcome = isResult(outcomeValue) ? outcomeValue : undefined;
    if (
      outcome !== undefined &&
      (outcome.status === 'ok' || typeof Reflect.get(outcome, 'hash') === 'string')
    )
      show('applied', `Applied. New hash: ${String(Reflect.get(outcome, 'hash') ?? '')}`);
    else if (outcome?.status === 'conflict' || result.isError === true)
      show(
        'conflict',
        'The file changed since the proposal. Check the current definition before retrying.',
      );
    else
      show(
        'conflict',
        'The revision was not applied. Check the current definition before retrying.',
      );
  };
  app.ontoolinput = (params) => {
    argumentsOfCall = isRecord(params.arguments) ? params.arguments : {};
    void inspect();
  };
  app.onteardown = async () => {
    tornDown = true;
    root.replaceChildren();
    return {};
  };
  await app.connect();
}

void start();
