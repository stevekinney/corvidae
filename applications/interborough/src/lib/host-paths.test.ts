/** Where the host keeps what a person edits by hand: the request, and the path of an agent's file. */
import { describe, expect, test } from 'bun:test';

import { urlOf } from './bureau-stub.test-support.ts';
import { agentFilePath, getHostPaths, HOST_PATHS_ROUTE, workflowFilePath } from './host-paths.ts';
import { installFetchImplementation } from './live-source/fetch.test-support.ts';

describe('getHostPaths', () => {
  test('asks the host and parses the directory it names', async () => {
    const seen: string[] = [];
    const paths = await getHostPaths({
      fetch: async (input) => {
        seen.push(urlOf(input));
        return Response.json({
          agentDirectory: '/home/me/.interborough/agents',
          workflowDirectory: '/home/me/.interborough/workflows',
        });
      },
    });
    expect(seen).toEqual([HOST_PATHS_ROUTE]);
    expect(paths.agentDirectory).toBe('/home/me/.interborough/agents');
    expect(paths.workflowDirectory).toBe('/home/me/.interborough/workflows');
  });

  test('passes an abort signal through, and uses the global fetch by default', async () => {
    const controller = new AbortController();
    const signals: (AbortSignal | null | undefined)[] = [];
    const restore = installFetchImplementation(async (_input, init) => {
      signals.push(init?.signal);
      return Response.json({ agentDirectory: '/agents', workflowDirectory: '/workflows' });
    });
    try {
      await getHostPaths({ signal: controller.signal });
      await getHostPaths();
    } finally {
      restore();
    }
    expect(signals[0]).toBe(controller.signal);
    expect(signals[1]).toBeUndefined();
  });

  test('throws when the host does not answer with a directory', async () => {
    const refused = await getHostPaths({
      fetch: async () => new Response('no', { status: 404 }),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(String(refused)).toContain('404');
    const wrong = await getHostPaths({ fetch: async () => Response.json({ elsewhere: 1 }) }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(wrong).toBeInstanceOf(Error);
    // A host that names only the agent directory is not one this application can read.
    const partial = await getHostPaths({
      fetch: async () => Response.json({ agentDirectory: '/agents' }),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(partial).toBeInstanceOf(Error);
  });
});

describe('agentFilePath', () => {
  test('is the identifier, with .md, under the directory', () => {
    expect(agentFilePath('/home/me/agents', 'researcher')).toBe('/home/me/agents/researcher.md');
  });

  test('does not double a trailing slash', () => {
    expect(agentFilePath('/home/me/agents/', 'researcher')).toBe('/home/me/agents/researcher.md');
  });
});

describe('workflowFilePath', () => {
  test('is the identifier, with .json, under the directory', () => {
    expect(workflowFilePath('/home/me/workflows', 'digest')).toBe('/home/me/workflows/digest.json');
  });

  test('does not double a trailing slash', () => {
    expect(workflowFilePath('/home/me/workflows/', 'digest')).toBe(
      '/home/me/workflows/digest.json',
    );
  });
});
