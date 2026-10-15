import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';

import { throwingRejectionOf } from '../promise-outcome.test-support.ts';
import {
  createGitHubApi,
  GitHubApiError,
  installationTokenFromApp,
  type GitHubApi,
} from './github-api.ts';
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
    expect(await absent.api.readRepository('stevekinney/mirror-dryrun-20260919')).toBe(undefined);
    const broken = harness([{ status: 500, body: { message: 'Server Error' } }]);
    expect(
      await throwingRejectionOf(broken.api.readRepository('stevekinney/mirror-dryrun-20260919')),
    ).toThrow(GitHubApiError);
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

describe('supersession methods (COR-1433)', () => {
  test('listOpenPullRequests pages through open pull requests as the App', async () => {
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        number: start + index,
        html_url: `https://github.com/stevekinney/weft/pull/${start + index}`,
        user: { login: 'lost-gradient-mirror-sync[bot]' },
        head: { ref: `mirror-sync-${start + index}`, sha: 'a'.repeat(40) },
        base: { ref: 'main' },
      }));
    const { api, seen } = harness([
      { status: 200, body: page(1, 100) },
      { status: 200, body: page(101, 2) },
    ]);
    const pullRequests = await api.listOpenPullRequests('stevekinney/weft');
    expect(pullRequests).toHaveLength(102);
    expect(pullRequests.at(0)).toEqual({
      number: 1,
      htmlUrl: 'https://github.com/stevekinney/weft/pull/1',
      author: 'lost-gradient-mirror-sync[bot]',
      headRef: 'mirror-sync-1',
      headSha: 'a'.repeat(40),
      baseRef: 'main',
    });
    expect(seen.map(({ url }) => url)).toEqual([
      'https://api.github.com/repos/stevekinney/weft/pulls?state=open&per_page=100&page=1',
      'https://api.github.com/repos/stevekinney/weft/pulls?state=open&per_page=100&page=2',
    ]);
    expect(
      seen.every(({ authorization }) => authorization === 'Bearer installation-credential'),
    ).toBe(true);
  });

  test('getCommitMessage returns the full message of one commit', async () => {
    const { api, seen } = harness([
      { status: 200, body: { commit: { message: 'Subject\n\nBody' } } },
    ]);
    expect(await api.getCommitMessage('stevekinney/weft', 'deadbeef')).toBe('Subject\n\nBody');
    expect(seen.at(0)?.url).toBe('https://api.github.com/repos/stevekinney/weft/commits/deadbeef');
  });

  test('createIssueComment posts a comment on a pull request', async () => {
    const { api, seen } = harness([{ status: 201, body: { id: 1 } }]);
    await api.createIssueComment({
      fullName: 'stevekinney/weft',
      issueNumber: 4,
      body: 'Superseded',
    });
    expect(seen.at(0)).toMatchObject({
      url: 'https://api.github.com/repos/stevekinney/weft/issues/4/comments',
      method: 'POST',
      body: { body: 'Superseded' },
    });
  });

  test('closePullRequest closes without merging, and a refusal throws', async () => {
    const { api, seen } = harness([{ status: 200, body: {} }]);
    await api.closePullRequest('stevekinney/weft', 4);
    expect(seen.at(0)).toMatchObject({
      url: 'https://api.github.com/repos/stevekinney/weft/pulls/4',
      method: 'PATCH',
      body: { state: 'closed' },
    });
    const refusing = harness([{ status: 403, body: { message: 'no' } }]);
    expect(await throwingRejectionOf(refusing.api.closePullRequest('stevekinney/weft', 4))).toThrow(
      GitHubApiError,
    );
  });
});

describe('dispatchWorkflow', () => {
  test('dispatches through the App installation with the exact ref and inputs', async () => {
    const { api, seen } = harness([{ status: 204 }]);
    const dispatchWorkflow = api.dispatchWorkflow;
    expect(dispatchWorkflow).toBeDefined();
    await dispatchWorkflow!({
      fullName: 'stevekinney/weft',
      workflowFile: 'release.yaml',
      ref: 'mirror-sync-deadbeef',
      inputs: { snapshot: 'true', expected_sha: 'deadbeef' },
    });
    expect(seen.at(0)).toMatchObject({
      url: 'https://api.github.com/repos/stevekinney/weft/actions/workflows/release.yaml/dispatches',
      method: 'POST',
      authorization: 'Bearer installation-credential',
      body: { ref: 'mirror-sync-deadbeef', inputs: { snapshot: 'true', expected_sha: 'deadbeef' } },
    });
  });

  test('requires GitHub’s workflow dispatch response to be 204', async () => {
    const { api } = harness([{ status: 202 }]);
    const dispatchWorkflow = api.dispatchWorkflow;
    expect(dispatchWorkflow).toBeDefined();
    expect(
      await throwingRejectionOf(
        dispatchWorkflow!({
          fullName: 'stevekinney/weft',
          workflowFile: 'release.yaml',
          ref: 'main',
          inputs: { snapshot: 'true', expected_sha: 'deadbeef' },
        }),
      ),
    ).toThrow(/HTTP 202/);
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
    expect(await throwingRejectionOf(api.deleteRepository('stevekinney/weft'))).toThrow(
      ScratchGuardError,
    );
    expect(await throwingRejectionOf(api.deleteRepository(''))).toThrow(ScratchGuardError);
    expect(
      await throwingRejectionOf(api.deleteRepository('stevekinney/mirror-dryrun-20260919 ')),
    ).toThrow(ScratchGuardError);
    expect(seen).toEqual([]);
  });

  test('fails loudly when GitHub refuses the delete', async () => {
    const { api } = harness([{ status: 403, body: { message: 'Must have admin rights' } }]);
    expect(
      await throwingRejectionOf(api.deleteRepository('stevekinney/mirror-dryrun-20260919')),
    ).toThrow(/HTTP 403/);
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

describe('installation token lifecycle', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const environment = { MIRROR_APP_PRIVATE_KEY: privateKey };

  test('mints lazily, shares concurrent requests, and refreshes before expiry', async () => {
    let now = new Date('2026-09-28T00:00:00Z');
    let minted = 0;
    const token = installationTokenFromApp(
      {
        now: () => now,
        fetchImplementation: async () => {
          minted += 1;
          const current = minted;
          return {
            status: 201,
            text: async () =>
              JSON.stringify({
                token: `test-installation-${current}`,
                expires_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
              }),
          };
        },
      },
      environment,
    );
    expect(minted).toBe(0);
    expect(await Promise.all([token(), token(), token()])).toEqual([
      'test-installation-1',
      'test-installation-1',
      'test-installation-1',
    ]);
    expect(minted).toBe(1);
    now = new Date('2026-09-28T00:54:00Z');
    expect(await token()).toBe('test-installation-1');
    expect(minted).toBe(1);
    now = new Date('2026-09-28T00:56:00Z');
    expect(await Promise.all([token(), token()])).toEqual([
      'test-installation-2',
      'test-installation-2',
    ]);
    expect(minted).toBe(2);
  });

  test('does not cache failed exchanges or invalid expiry responses', async () => {
    let minted = 0;
    const token = installationTokenFromApp(
      {
        now: () => new Date('2026-09-28T00:00:00Z'),
        fetchImplementation: async () => {
          minted += 1;
          if (minted === 1) return { status: 503, text: async () => 'Unavailable' };
          return {
            status: 201,
            text: async () =>
              JSON.stringify({
                token: 'test-installation-recovered',
                expires_at: minted === 2 ? 'invalid' : '2026-09-28T01:00:00Z',
              }),
          };
        },
      },
      environment,
    );
    expect(await throwingRejectionOf(token())).toThrow('HTTP 503');
    expect(await throwingRejectionOf(token())).toThrow('valid expiry');
    expect(await token()).toBe('test-installation-recovered');
    expect(minted).toBe(3);
  });
});
