import { createSign } from 'node:crypto';

/**
 * Authentication for the mirror GitHub App.
 *
 * Two credentials exist in this pipeline and they are not interchangeable. The `gh` CLI token is
 * a user credential: it owns the account, so it can create and delete repositories, and it is the
 * only thing that can. The App installation token is what every write *into* a mirror goes
 * through, because the App is the identity the mirror repositories trust — a pull request opened
 * by a user token proves nothing about whether the App path works, which is the entire point of
 * the dry run.
 *
 * Nothing here ever writes a key or a token to disk, puts one in an argument vector, or returns
 * one in an error message. A token reaches git as an environment variable and reaches the API as
 * a header; a failed request is reported by status and by GitHub's own response body, neither of
 * which contains the credential that was sent.
 */

/** The mirror App's identity. Fixed, because there is exactly one of it. */
export const mirrorAppId = 4_997_180;

/** The installation of that App on the `stevekinney` account. */
export const mirrorInstallationId = 162_905_409;

/** The login GitHub gives the App's bot account, which authors every sync pull request. */
export const mirrorBotLogin = 'lost-gradient-mirror-sync[bot]';

export const githubApiRoot = 'https://api.github.com';

/** Where the owner manages which repositories the installation can reach. */
export const installationSettingsUrl = `https://github.com/settings/installations/${mirrorInstallationId}`;

export class GitHubAppError extends Error {}

/** The `fetch` surface every request in this pipeline goes through, so a test can supply its own. */
export type FetchImplementation = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

export interface AppJwtOptions {
  /** A PKCS#8 or PKCS#1 PEM. Held in memory only. */
  privateKey: string;
  appId: number;
  now?: Date;
}

/**
 * A short-lived RS256 assertion identifying the App itself.
 *
 * `iat` is backdated a minute because GitHub rejects a token whose issue time is ahead of its
 * own clock, and the lifetime stops well inside the ten minutes GitHub allows: a JWT is exchanged
 * for an installation token immediately, so a longer window buys nothing and widens the blast
 * radius of a leak.
 */
export function mintAppJwt({ privateKey, appId, now = new Date() }: AppJwtOptions): string {
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;
  const expiresAt = issuedAt + 540;
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ iat: issuedAt, exp: expiresAt, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64Url(signer.sign(privateKey))}`;
}

export interface InstallationTokenOptions extends AppJwtOptions {
  installationId: number;
  fetchImplementation?: FetchImplementation;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
  /** `all` or `selected`, straight from GitHub. */
  repositorySelection: string;
}

/** Exchange an App JWT for an installation access token. */
export async function mintInstallationToken({
  privateKey,
  appId,
  installationId,
  now,
  fetchImplementation = fetch,
}: InstallationTokenOptions): Promise<InstallationToken> {
  const jwt = mintAppJwt({ privateKey, appId, ...(now ? { now } : {}) });
  const response = await fetchImplementation(
    `${githubApiRoot}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'corvidae-mirror',
      },
    },
  );
  const text = await response.text();
  if (response.status !== 201) {
    throw new GitHubAppError(
      `Minting an installation token for installation ${installationId} returned HTTP ${response.status}: ${text}`,
    );
  }
  const body = JSON.parse(text) as {
    token?: string;
    expires_at?: string;
    repository_selection?: string;
  };
  if (!body.token) {
    throw new GitHubAppError(
      `Installation ${installationId} returned HTTP 201 with no token in the body`,
    );
  }
  return {
    token: body.token,
    expiresAt: body.expires_at ?? '',
    repositorySelection: body.repository_selection ?? 'selected',
  };
}

/**
 * Read the App private key from the environment.
 *
 * `MIRROR_APP_PRIVATE_KEY` carries the PEM directly, which is how the repository secret of the
 * same name arrives in a workflow. `MIRROR_APP_PRIVATE_KEY_FILE` names a file instead, which is
 * how a local run points at the downloaded key without the PEM ever passing through a shell.
 */
export async function readAppPrivateKey(
  environment: Record<string, string | undefined> = Bun.env,
): Promise<string> {
  const inline = environment['MIRROR_APP_PRIVATE_KEY'];
  if (inline && inline.trim().length > 0) return inline;
  const path = environment['MIRROR_APP_PRIVATE_KEY_FILE'];
  if (path && path.trim().length > 0) {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      throw new GitHubAppError(
        `MIRROR_APP_PRIVATE_KEY_FILE points at ${path}, which does not exist`,
      );
    }
    return file.text();
  }
  throw new GitHubAppError(
    'No App private key: set MIRROR_APP_PRIVATE_KEY to the PEM or MIRROR_APP_PRIVATE_KEY_FILE to its path',
  );
}
