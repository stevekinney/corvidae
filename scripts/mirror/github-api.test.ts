import { describe, expect, test } from 'bun:test';

import { createGitHubApi, GitHubApiError, type GitHubApi } from './github-api.ts';
import type { FetchImplementation } from './github-app.ts';
import { ScratchGuardError } from './scratch-repository.ts';

/**
 * The live GitHub implementation, driven against a `fetch` that answers from memory.
 *
 * This is the same code path the live run takes — the same request shapes, the same status
 * handling, the same choice of credential per route — with only the transport replaced, so no
 * test here can reach GitHub, let alone mutate it.
 */

interface SeenRequest {
  url: string;
  method: string;
  authorization: string;
  body: unknown;
}

interface Answer {
  status: number;
  body?: unknown;
}

function harness(answers: readonly Answer[]): { api: GitHubApi; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  let index = 0;
  const fetchImplementation: FetchImplementation = async (url, init) => {
    const answer = answers[Math.min(index, answers.length - 1)] ?? { status: 200 };
    index += 1;
    seen.push({
      url,
      method: init?.method ?? 'GET',
      authorization: init?.headers?.['authorization'] ?? '',
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    });
    return {
      status: answer.status,
      text: async () => (answer.body === undefined ? '' : JSON.stringify(answer.body)),
    };
  };
  const api = createGitHubApi({
    fetchImplementation,
    userToken: async () => 'user-credential',
    installationToken: async () => 'installation-credential',
  });
  return { api, seen };
}

describe('readRepository', () => {
  test('maps the fields the guard reads, using the account credential', async () => {
    const { api, seen } = harness([
      {
        status: 200,
        body: {
          full_name: 'stevekinney/mirror-dryrun-20260919',
          description: 'mirror dry run, safe to delete',
          private: false,
          html_url: 'https://github.com/stevekinney/mirror-dryrun-20260919',
          default_branch: 'main',
        },
      },
    ]);
    const repository = await api.readRepository('stevekinney/mirror-dryrun-20260919');
    expect(repository).toEqual({
      fullName: 'stevekinney/mirror-dryrun-20260919',
      description: 'mirror dry run, safe to delete',
      private: false,
      htmlUrl: 'https://github.com/stevekinney/mirror-dryrun-20260919',
      defaultBranch: 'main',
    });
    expect(seen.at(0)).toMatchObject({
      url: 'https://api.github.com/repos/stevekinney/mirror-dryrun-20260919',
      method: 'GET',
      authorization: 'Bearer user-credential',
    });
  });

  test('reports an absent repository as undefined and any other status as a failure', async () => {
    const absent = harness([{ status: 404, body: { message: 'Not Found' } }]);
    await expect(absent.api.readRepository('stevekinney/mirror-dryrun-20260919')).resolves.toBe(
      undefined,
    );
    const broken = harness([{ status: 500, body: { message: 'Server Error' } }]);
    await expect(broken.api.readRepository('stevekinney/mirror-dryrun-20260919')).rejects.toThrow(
      GitHubApiError,
    );
  });

  test('treats a missing description as null rather than as the sentinel', async () => {
    const { api } = harness([
      { status: 200, body: { full_name: 'stevekinney/x', description: null, private: false } },
    ]);
    const repository = await api.readRepository('stevekinney/x');
    expect(repository?.description).toBe(null);
  });
});

describe('createRepository', () => {
  test('creates a public repository without an initial commit', async () => {
    const { api, seen } = harness([
      {
        status: 201,
        body: { full_name: 'stevekinney/mirror-dryrun-20260919', description: 'sentinel' },
      },
    ]);
    await api.createRepository({
      fullName: 'stevekinney/mirror-dryrun-20260919',
      description: 'sentinel',
    });
    expect(seen.at(0)).toMatchObject({
      url: 'https://api.github.com/user/repos',
      method: 'POST',
      authorization: 'Bearer user-credential',
    });
    expect(seen.at(0)?.body).toEqual({
      name: 'mirror-dryrun-20260919',
      description: 'sentinel',
      private: false,
      auto_init: false,
      has_issues: false,
    });
  });
});

describe('createPullRequest', () => {
  test('opens the pull request as the App, not as the account', async () => {
    const { api, seen } = harness([
      {
        status: 201,
        body: {
          number: 7,
          html_url: 'https://github.com/stevekinney/mirror-dryrun-20260919/pull/7',
          head: { sha: 'deadbeef' },
        },
      },
    ]);
    const pullRequest = await api.createPullRequest({
      fullName: 'stevekinney/mirror-dryrun-20260919',
      base: 'main',
      head: 'mirror-dry-run-20260919',
      title: 'Mirror dry run for weft',
      body: 'body',
    });
    expect(pullRequest).toEqual({
      number: 7,
      htmlUrl: 'https://github.com/stevekinney/mirror-dryrun-20260919/pull/7',
      headSha: 'deadbeef',
    });
    expect(seen.at(0)?.authorization).toBe('Bearer installation-credential');
  });
});

describe('readInstallationCoverage', () => {
  test('reports the selection and every repository across pages', async () => {
    const { api, seen } = harness([
      {
        status: 200,
        body: {
          total_count: 3,
          repository_selection: 'selected',
          repositories: [{ full_name: 'stevekinney/corvidae' }, { full_name: 'stevekinney/weft' }],
        },
      },
      {
        status: 200,
        body: {
          total_count: 3,
          repository_selection: 'selected',
          repositories: [{ full_name: 'stevekinney/cinder' }],
        },
      },
    ]);
    const coverage = await api.readInstallationCoverage();
    expect(coverage.repositorySelection).toBe('selected');
    expect(coverage.repositories).toEqual([
      'stevekinney/corvidae',
      'stevekinney/weft',
      'stevekinney/cinder',
    ]);
    expect(seen.at(0)?.authorization).toBe('Bearer installation-credential');
    expect(seen).toHaveLength(2);
  });
});

describe('deleteRepository', () => {
  test('issues the delete with the account credential and requires 204', async () => {
    const { api, seen } = harness([{ status: 204 }]);
    await api.deleteRepository('stevekinney/mirror-dryrun-20260919');
    expect(seen.at(0)).toMatchObject({
      url: 'https://api.github.com/repos/stevekinney/mirror-dryrun-20260919',
      method: 'DELETE',
      authorization: 'Bearer user-credential',
    });
  });

  test('refuses a name outside the pinned pattern before sending anything', async () => {
    // The driver's guard is the primary one, but this function is what issues the request, so it
    // carries the name check itself: no edit to a caller can aim it at a real repository.
    const { api, seen } = harness([{ status: 204 }]);
    await expect(api.deleteRepository('stevekinney/weft')).rejects.toThrow(ScratchGuardError);
    await expect(api.deleteRepository('')).rejects.toThrow(ScratchGuardError);
    await expect(api.deleteRepository('stevekinney/mirror-dryrun-20260919 ')).rejects.toThrow(
      ScratchGuardError,
    );
    expect(seen).toEqual([]);
  });

  test('fails loudly when GitHub refuses the delete', async () => {
    const { api } = harness([{ status: 403, body: { message: 'Must have admin rights' } }]);
    await expect(api.deleteRepository('stevekinney/mirror-dryrun-20260919')).rejects.toThrow(
      /HTTP 403/,
    );
  });
});

describe('pushEnvironment', () => {
  test('carries the App credential as git configuration, decodable as basic auth', async () => {
    const { api } = harness([]);
    const environment = await api.pushEnvironment();
    expect(environment['GIT_CONFIG_COUNT']).toBe('1');
    expect(environment['GIT_CONFIG_KEY_0']).toBe('http.https://github.com/.extraHeader');
    const header = environment['GIT_CONFIG_VALUE_0'] ?? '';
    const encoded = header.replace('Authorization: Basic ', '');
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(
      'x-access-token:installation-credential',
    );
  });
});
