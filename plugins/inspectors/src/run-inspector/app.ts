/**
 * The run inspector's page script (COR-910), bundled into the `ui://` resource. It talks only to
 * its host over the MCP Apps bridge: it reads the task through `bureau.tasks.inspect` and
 * `bureau.tasks.events`, and aborts through `bureau.tasks.cancel`. It holds no credential and
 * reaches no origin, so the host's authorization decides every call it makes.
 */
import { App } from '@modelcontextprotocol/ext-apps';

import {
  buildInspectorModel,
  type Inspection,
  type InspectorModel,
  isStaleInspection,
  type TaskEventElement,
} from './model.ts';
import { describeChange, renderInspector } from './render.ts';

const REFRESH_MILLISECONDS = 3000;
const ABORT_WAIT_MILLISECONDS = 10_000;

/** The result's structured content, or `undefined` for an error result. The host's tool call is the authority on its shape. */
function structured<T>(
  result: { structuredContent?: unknown; isError?: boolean | undefined },
  isShape: (value: unknown) => value is T,
): T | undefined {
  return result.isError !== true && isShape(result.structuredContent)
    ? result.structuredContent
    : undefined;
}

const isInspection = (value: unknown): value is Inspection =>
  typeof value === 'object' && value !== null && 'task' in value && 'children' in value;

const isEventPage = (
  value: unknown,
): value is { events: TaskEventElement[]; nextCursor: string | null } =>
  typeof value === 'object' && value !== null && 'events' in value && Array.isArray(value.events);

async function start(): Promise<void> {
  const root = document.getElementById('root');
  if (root === null) return;
  const app = new App({ name: 'bureau-run-inspector', version: '1.0.0' });
  let taskId: string | undefined;
  // Bumped whenever the page switches task: a response that started under an older one is dropped.
  let generation = 0;
  let cursor: string | undefined;
  let events: TaskEventElement[] = [];
  let model: InspectorModel | undefined;
  let shown: Inspection | undefined;
  let connected = true;
  let timer: ReturnType<typeof setInterval> | undefined;

  // Without the host's `serverTools` capability the page cannot call the server: it shows the
  // result that opened it and offers no Abort.
  const canCallServer = (): boolean => app.getHostCapabilities()?.serverTools !== undefined;
  const handlers = { onAbort: () => void abort() };

  const show = (inspected: Inspection, announceReconnect: boolean): void => {
    if (isStaleInspection(shown, inspected)) return;
    shown = inspected;
    const next = buildInspectorModel(inspected, events, canCallServer());
    const announcement = announceReconnect ? 'Reconnected.' : describeChange(model, next);
    model = next;
    renderInspector(root, next, handlers, announcement);
  };

  const connectionLost = (): void => {
    if (connected && model !== undefined) {
      connected = false;
      renderInspector(root, model, handlers, 'Connection lost. Retrying.');
    }
  };

  const refresh = async (): Promise<void> => {
    const id = taskId;
    const started = generation;
    if (id === undefined || !canCallServer()) return;
    try {
      const inspected = structured(
        await app.callServerTool({ name: 'bureau.tasks.inspect', arguments: { taskId: id } }),
        isInspection,
      );
      if (started !== generation) return;
      if (inspected === undefined) return connectionLost();
      const page = structured(
        await app.callServerTool({
          name: 'bureau.tasks.events',
          arguments: { taskId: id, ...(cursor === undefined ? {} : { fromCursor: cursor }) },
        }),
        isEventPage,
      );
      if (started !== generation) return;
      if (page !== undefined) {
        events = [...events, ...page.events];
        cursor = page.nextCursor ?? cursor;
      }
      const wasConnected = connected;
      connected = true;
      show(inspected, !wasConnected);
    } catch {
      // A transport failure is the same as a host that did not answer.
      if (started === generation) connectionLost();
    }
  };

  const abort = async (): Promise<void> => {
    // The run the page shows, never whatever the page has since been pointed at.
    const id = model?.taskId;
    if (id === undefined || !canCallServer()) return;
    const started = generation;
    try {
      const receipt = await app.callServerTool({
        name: 'bureau.tasks.cancel',
        arguments: { taskId: id, waitMilliseconds: ABORT_WAIT_MILLISECONDS },
      });
      if (started !== generation) return;
      if (receipt.isError === true && model !== undefined) {
        renderInspector(root, model, handlers, 'Abort was refused.');
        return;
      }
    } catch {
      if (started === generation) connectionLost();
      return;
    }
    await refresh();
  };

  const watch = (id: string): void => {
    taskId = id;
    generation += 1;
    cursor = undefined;
    events = [];
    model = undefined;
    shown = undefined;
    connected = true;
    void refresh();
  };

  app.ontoolinput = (params) => {
    const id = params.arguments?.['taskId'];
    if (typeof id === 'string' && id !== taskId) watch(id);
  };
  // The result that opened the page is its first render, whether or not the host lets it call back.
  app.ontoolresult = (result) => {
    const inspected = structured(result, isInspection);
    if (inspected === undefined) return;
    if (inspected.taskId !== taskId) {
      taskId = inspected.taskId;
      generation += 1;
      cursor = undefined;
      events = [];
      shown = undefined;
      model = undefined;
    }
    show(inspected, false);
  };
  // Closing the page releases only this page's observation: the run keeps going.
  app.onteardown = async () => {
    if (timer !== undefined) clearInterval(timer);
    generation += 1;
    root.replaceChildren();
    return {};
  };
  await app.connect();
  // poll-reason: mcp-transport
  timer = setInterval(() => void refresh(), REFRESH_MILLISECONDS);
}

void start();
