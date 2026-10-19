import type { HttpClient } from '@lostgradient/weft';

import { callBureau } from '../lib/bureau-client.ts';
import type { ViewName } from './views.ts';

/** What a view's probe learned: whether the thing the view lists has nothing in it. */
export type ViewProbeResult = { readonly empty: boolean };

/** A failure with an HTTP status, for a probe that does not go through Weft's client. */
export class ViewProbeFault extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ViewProbeFault';
    this.status = status;
  }
}

/** The route parameters a probe may depend on. */
export type ViewProbeParameters = Readonly<Record<string, string>>;

/**
 * The one request a view makes before it shows its content, to learn whether the view is loading,
 * empty, failing, or forbidden. A probe asks for the least that settles the question.
 */
export type ViewProbe = (client: HttpClient) => Promise<ViewProbeResult>;

/** The Bureau's health route, mounted beside the engine API (`src/host/host.ts`). */
const BUREAU_HEALTH_PATH = '/bureau/v1/health';

/** Ask the Bureau whether it is up. A view that has nothing built yet is empty when it is. */
async function probeBureau(): Promise<ViewProbeResult> {
  const response = await fetch(BUREAU_HEALTH_PATH);
  if (!response.ok) {
    throw new ViewProbeFault(`The Bureau answered ${response.status}.`, response.status);
  }
  return { empty: true };
}

/**
 * The probe for a view, or `undefined` when the view needs none because the route itself says
 * what it is showing: one run's detail page handles a run that is missing in its own words.
 */
export function probeFor(view: ViewName, parameters: ViewProbeParameters): ViewProbe | undefined {
  switch (view) {
    case 'chat':
      // One session's page asks for that session, which settles whether it exists and may be seen.
      if (parameters['sessionId'] !== undefined) {
        const sessionId = parameters['sessionId'];
        return async () => {
          // Only whether it exists and may be seen matters here; the page reads what it shows.
          await callBureau('bureau.contexts.get', { contextId: sessionId });
          return { empty: false };
        };
      }
      return probeBureau;
    case 'agents':
    case 'audit':
      return probeBureau;
    case 'workflows':
      return async (client) => {
        await client.operations['weft.workflows.definitions.list']({});
        return { empty: true };
      };
    case 'runs':
      if (parameters['id'] !== undefined) return undefined;
      return async (client) => {
        const page = await client.list({ limit: 1 });
        return { empty: page.items.length === 0 };
      };
    case 'schedules':
      return async (client) => {
        const page = await client.listSchedules({});
        return { empty: page.items.length === 0 };
      };
    case 'inbox':
      return async (client) => {
        const [pending, completed] = await Promise.all([
          client.listReviews({ status: 'pending' }),
          client.listReviews({ status: 'completed' }),
        ]);
        return { empty: pending.length === 0 && completed.length === 0 };
      };
    case 'workers':
      return async (client) => {
        await client.operations['weft.workers.list']({});
        return { empty: false };
      };
    case 'storage':
      return async (client) => {
        await client.operations['weft.storage.capabilities']({});
        return { empty: false };
      };
    case 'system':
    case 'engine':
      return async (client) => {
        await client.operations['weft.system.registry']({});
        return { empty: false };
      };
  }
}
