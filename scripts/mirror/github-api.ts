import {
  githubApiRoot,
  mintInstallationToken,
  mirrorAppId,
  mirrorInstallationId,
  readAppPrivateKey,
  type FetchImplementation,
} from './github-app.ts';
import { runCommand, type CommandOptions, type CommandResult } from './packaging.ts';
import { assertScratchName, type ScratchRepositoryFacts } from './scratch-repository.ts';

/**
 * The GitHub surface the dry run is allowed to touch, as one injectable port.
 *
 * Everything the driver does to GitHub goes through this interface and nothing else, which is
 * what lets the tests drive the real driver — the same functions, the same order, the same
 * guards — against a fake that records calls instead of making them. There is no second,
 * test-only copy of the guard to drift away from the one that runs live.
 *
 * The split of credentials is deliberate and is part of what the dry run proves. Creating and
 * deleting a repository is an account-level operation no App installation can perform, so those
 * two go through the user credential. Every write *into* the scratch repository — the seed push,
 * the branch push, the pull request — goes through the App installation token, because proving
 * the App path is the point.
 */

export class GitHubApiError extends Error {}

export interface RepositoryRecord extends ScratchRepositoryFacts {
  htmlUrl: string;
  defaultBranch: string;
}

export interface InstallationCoverage {
  /** `all` or `selected`. */
  repositorySelection: string;
  /** Full names the installation can reach, empty when the selection is `all`. */
  repositories: readonly string[];
}

export interface PullRequestRecord {
  number: number;
  htmlUrl: string;
  headSha: string;
}

export interface CheckRunRecord {
  name: string;
  /** `queued`, `in_progress` or `completed`. */
  status: string;
  conclusion: string | null;
}

export interface CreateRepositoryInput {
  fullName: string;
  description: string;
}

export interface CreatePullRequestInput {
  fullName: string;
  base: string;
  head: string;
  title: string;
  body: string;
}

export interface GitHubApi {
  /** What the App installation can reach right now. */
  readInstallationCoverage(): Promise<InstallationCoverage>;
  /** The repository, or `undefined` when GitHub answers 404. */
  readRepository(fullName: string): Promise<RepositoryRecord | undefined>;
  createRepository(input: CreateRepositoryInput): Promise<RepositoryRecord>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRecord>;
  readCheckRuns(fullName: string, ref: string): Promise<readonly CheckRunRecord[]>;
  deleteRepository(fullName: string): Promise<void>;
  /**
   * Environment variables that authenticate a `git push` to a mirror as the App.
   *
   * Credentials are returned as environment rather than as a remote URL or a `-c` flag because
   * both of those end up in an argument vector, and an argument vector ends up in a log.
   */
  pushEnvironment(): Promise<Record<string, string>>;
  /**
   * The same, authenticated as the account rather than as the App.
   *
   * Seeding a scratch repository carries the target's own `.github/workflows/**`, and GitHub
   * refuses a workflow file pushed by an App without the `workflows` permission — which this
   * App deliberately does not hold, because the transform never writes `.github/` on a real
   * sync: `target-owned.json` reserves it for the target. Widening the App to get a scaffolding
   * step through would grant standing authority over three real repositories' workflows to
   * avoid a one-off. Seeding is setup, not the thing under proof, so it pushes as the account
   * and the transform branch and pull request still go through the App.
   */
  accountPushEnvironment(): Promise<Record<string, string>>;
}

interface JsonResponse {
  status: number;
  /** The raw body, kept for failure messages. */
  text: string;
  body: unknown;
}

export interface GitHubApiOptions {
  fetchImplementation?: FetchImplementation;
  /** Resolves the account credential used for repository creation and deletion. */
  userToken: () => Promise<string>;
  /** Resolves the App installation credential used for everything inside a mirror. */
  installationToken: () => Promise<string>;
}

/**
 * Git configuration carrying a bearer credential, as environment rather than as a remote URL or
 * a `-c` flag: both of those end up in an argument vector, and an argument vector ends up in a
 * log. `x-access-token` is the username GitHub expects for both an installation token and a
 * personal token, so one shape serves the App and the account alike.
 */
function gitCredentialEnvironment(token: string): Record<string, string> {
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
  };
}

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'corvidae-mirror',
  };
}

function asRepository(body: unknown): RepositoryRecord {
  const record = body as {
    full_name?: string;
    description?: string | null;
    private?: boolean;
    html_url?: string;
    default_branch?: string;
  };
  return {
    fullName: record.full_name ?? '',
    description: record.description ?? null,
    private: record.private ?? true,
    htmlUrl: record.html_url ?? '',
    defaultBranch: record.default_branch ?? '',
  };
}

/**
 * The live implementation.
 *
 * `fetch` rather than `gh api` for one reason that matters: a status code. `gh api` reports an
 * HTTP failure as exit 1 with the status in a human-readable line on stderr, so telling a 404
 * (the repository is absent, which several steps treat as ordinary) from a 403 (the credential
 * is wrong, which is never ordinary) would mean matching strings in output that carries ANSI
 * escapes. Reading `response.status` is the same check without the false green.
 */
export function createGitHubApi({
  fetchImplementation = fetch,
  userToken,
  installationToken,
}: GitHubApiOptions): GitHubApi {
  async function request(
    path: string,
    { method = 'GET', token, body }: { method?: string; token: string; body?: unknown },
  ): Promise<JsonResponse> {
    const response = await fetchImplementation(`${githubApiRoot}${path}`, {
      method,
      headers: {
        ...headers(token),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, text, body: text.length > 0 ? JSON.parse(text) : undefined };
  }

  function assertStatus(response: JsonResponse, expected: number, context: string): void {
    if (response.status === expected) return;
    throw new GitHubApiError(`${context} returned HTTP ${response.status}: ${response.text}`);
  }

  return {
    async readInstallationCoverage(): Promise<InstallationCoverage> {
      const token = await installationToken();
      const collected: string[] = [];
      let selection = 'selected';
      // Paginated because the installation is a moving target: it covers three repositories
      // today and the point of this run is to change that.
      for (let page = 1; page <= 10; page += 1) {
        const response = await request(`/installation/repositories?per_page=100&page=${page}`, {
          token,
        });
        assertStatus(response, 200, 'Listing the repositories the App installation can reach');
        const payload = response.body as {
          total_count?: number;
          repository_selection?: string;
          repositories?: { full_name?: string }[];
        };
        selection = payload.repository_selection ?? selection;
        const names = (payload.repositories ?? []).map((entry) => entry.full_name ?? '');
        collected.push(...names);
        if (names.length === 0 || collected.length >= (payload.total_count ?? collected.length)) {
          break;
        }
      }
      return { repositorySelection: selection, repositories: collected };
    },

    async readRepository(fullName: string): Promise<RepositoryRecord | undefined> {
      const response = await request(`/repos/${fullName}`, { token: await userToken() });
      if (response.status === 404) return undefined;
      assertStatus(response, 200, `Reading ${fullName}`);
      return asRepository(response.body);
    },

    async createRepository({
      fullName,
      description,
    }: CreateRepositoryInput): Promise<RepositoryRecord> {
      const name = fullName.split('/').at(1) ?? '';
      const response = await request('/user/repos', {
        method: 'POST',
        token: await userToken(),
        body: { name, description, private: false, auto_init: false, has_issues: false },
      });
      assertStatus(response, 201, `Creating ${fullName}`);
      return asRepository(response.body);
    },

    async createPullRequest({
      fullName,
      base,
      head,
      title,
      body,
    }: CreatePullRequestInput): Promise<PullRequestRecord> {
      const response = await request(`/repos/${fullName}/pulls`, {
        method: 'POST',
        token: await installationToken(),
        body: { base, head, title, body },
      });
      assertStatus(response, 201, `Opening a pull request in ${fullName}`);
      const record = response.body as {
        number?: number;
        html_url?: string;
        head?: { sha?: string };
      };
      return {
        number: record.number ?? 0,
        htmlUrl: record.html_url ?? '',
        headSha: record.head?.sha ?? '',
      };
    },

    async readCheckRuns(fullName: string, ref: string): Promise<readonly CheckRunRecord[]> {
      const response = await request(`/repos/${fullName}/commits/${ref}/check-runs?per_page=100`, {
        token: await installationToken(),
      });
      assertStatus(response, 200, `Reading check runs for ${fullName}@${ref}`);
      const payload = response.body as {
        check_runs?: { name?: string; status?: string; conclusion?: string | null }[];
      };
      return (payload.check_runs ?? []).map((entry) => ({
        name: entry.name ?? '',
        status: entry.status ?? '',
        conclusion: entry.conclusion ?? null,
      }));
    },

    async deleteRepository(fullName: string): Promise<void> {
      // The second layer. `deleteScratchRepository` is the full guard and is where a delete is
      // supposed to come from, but this function is what actually issues the request, so it
      // refuses a name outside the pinned pattern on its own account. Nothing that reaches this
      // line with a real repository's name gets to send it.
      assertScratchName(fullName);
      const response = await request(`/repos/${fullName}`, {
        method: 'DELETE',
        token: await userToken(),
      });
      assertStatus(response, 204, `Deleting ${fullName}`);
    },

    async accountPushEnvironment(): Promise<Record<string, string>> {
      return gitCredentialEnvironment(await userToken());
    },

    async pushEnvironment(): Promise<Record<string, string>> {
      return gitCredentialEnvironment(await installationToken());
    },
  };
}

export type CommandRunner = (
  command: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

/**
 * The account credential, from the environment when a workflow supplies one and from the `gh`
 * CLI otherwise. Captured into memory and never echoed, written or passed as an argument.
 */
export function userTokenFromEnvironmentOrCli(
  environment: Record<string, string | undefined> = Bun.env,
  run: CommandRunner = runCommand,
): () => Promise<string> {
  return async () => {
    const supplied = environment['GH_TOKEN'] ?? environment['GITHUB_TOKEN'];
    if (supplied && supplied.trim().length > 0) return supplied.trim();
    const result = await run(['gh', 'auth', 'token'], { cwd: process.cwd() });
    if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
      throw new GitHubApiError(
        `No account credential: set GH_TOKEN, or run gh auth login (gh auth token exited ${result.exitCode})`,
      );
    }
    return result.stdout.trim();
  };
}

/**
 * The App installation credential, minted once per process and reused.
 *
 * One mint per run keeps the number of places a token exists to one, and an installation token
 * lives an hour, which outlasts any dry run.
 */
export function installationTokenFromApp(
  options: {
    fetchImplementation?: FetchImplementation;
    appId?: number;
    installationId?: number;
  } = {},
  environment: Record<string, string | undefined> = Bun.env,
): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return async () => {
    pending ??= (async () => {
      const privateKey = await readAppPrivateKey(environment);
      const minted = await mintInstallationToken({
        privateKey,
        appId: options.appId ?? mirrorAppId,
        installationId: options.installationId ?? mirrorInstallationId,
        ...(options.fetchImplementation
          ? { fetchImplementation: options.fetchImplementation }
          : {}),
      });
      return minted.token;
    })();
    return pending;
  };
}
