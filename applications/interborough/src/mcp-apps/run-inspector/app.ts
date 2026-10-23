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
  result: { structuredContent?: unknown; isError?: boolean },
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
  let cursor: string | undefined;
  let events: TaskEventElement[] = [];
  let model: InspectorModel | undefined;
  let shown: Inspection | undefined;
  let connected = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  let announcement: string | null = null;

  const refresh = async (): Promise<void> => {
    if (taskId === undefined) return;
    const inspected = structured(
      await app.callServerTool({ name: 'bureau.tasks.inspect', arguments: { taskId } }),
      isInspection,
    );
    if (inspected === undefined) {
      // The host did not answer: say so, keep what is shown, and try again on the next tick.
      if (connected && model !== undefined) {
        connected = false;
        renderInspector(root, model, { onAbort: () => void abort() }, 'Connection lost. Retrying.');
      }
      return;
    }
    if (isStaleInspection(shown, inspected)) return;
    const wasConnected = connected;
    connected = true;
    shown = inspected;
    const page = structured(
      await app.callServerTool({
        name: 'bureau.tasks.events',
        arguments: { taskId, ...(cursor === undefined ? {} : { fromCursor: cursor }) },
      }),
      isEventPage,
    );
    if (page !== undefined) {
      events = [...events, ...page.events];
      cursor = page.nextCursor ?? cursor;
    }
    const next = buildInspectorModel(inspected, events);
    announcement = wasConnected ? describeChange(model, next) : 'Reconnected.';
    model = next;
    renderInspector(root, next, { onAbort: () => void abort() }, announcement);
  };

  const abort = async (): Promise<void> => {
    if (taskId === undefined) return;
    await app.callServerTool({
      name: 'bureau.tasks.cancel',
      arguments: { taskId, waitMilliseconds: ABORT_WAIT_MILLISECONDS },
    });
    await refresh();
  };

  app.ontoolinput = (params) => {
    const id = params.arguments?.['taskId'];
    if (typeof id === 'string' && id !== taskId) {
      taskId = id;
      cursor = undefined;
      events = [];
      model = undefined;
      shown = undefined;
      void refresh();
    }
  };
  // Closing the page releases only this page's observation: the run keeps going.
  app.onteardown = async () => {
    if (timer !== undefined) clearInterval(timer);
    root.replaceChildren();
    return {};
  };
  await app.connect();
  timer = setInterval(() => void refresh(), REFRESH_MILLISECONDS);
}

void start();
