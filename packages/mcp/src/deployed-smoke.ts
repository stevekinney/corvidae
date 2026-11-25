import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isAddressInCidr } from './oauth/security-utilities';

export type ProbeConfiguration = { origin: string; path: string; scopes: string[] };
export type ProbeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function parseProbeConfiguration(arguments_: string[]): ProbeConfiguration {
  if (arguments_.length < 3)
    throw new Error('Usage: <https-origin> <resource-path> <scope> [scope ...]');
  const [origin, path, ...scopes] = arguments_;
  const url = new URL(origin!);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password)
    throw new Error('Expected a canonical HTTPS origin');
  if (!path?.startsWith('/') || path.startsWith('//') || new URL(path, origin).pathname !== path)
    throw new Error('Expected an absolute resource path without a query or fragment');
  if (scopes.some((scope) => !scope || /\s/.test(scope))) throw new Error('Invalid scope');
  return { origin, path, scopes };
}

const nonPublicNetworks = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::1/128',
  '::/128',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '100::/64',
  '2001:db8::/32',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
];

export async function checkDeployment(
  configuration: ProbeConfiguration,
  request: ProbeFetch = fetch,
): Promise<void> {
  configuration = { ...configuration, scopes: [...configuration.scopes] };
  const resource = configuration.origin + configuration.path;
  const metadataUrl = `${configuration.origin}/.well-known/oauth-protected-resource${configuration.path}`;
  const getJson = async (url: string): Promise<Record<string, unknown>> => {
    const response = await request(url, { redirect: 'manual' });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Error(`${url} did not return an object`);
    return body as Record<string, unknown>;
  };
  const metadata = await getJson(metadataUrl);
  if (metadata['resource'] !== resource) throw new Error('Protected-resource audience mismatch');
  const supportedScopes = metadata['scopes_supported'];
  if (
    !Array.isArray(supportedScopes) ||
    configuration.scopes.some((scope) => !supportedScopes.includes(scope))
  )
    throw new Error('Protected-resource scope mismatch');
  if (
    !Array.isArray(metadata['authorization_servers']) ||
    metadata['authorization_servers'].length !== 1 ||
    metadata['authorization_servers'][0] !== configuration.origin
  )
    throw new Error('Unexpected authorization server');
  const issuer = await getJson(`${configuration.origin}/.well-known/oauth-authorization-server`);
  if (issuer['issuer'] !== configuration.origin)
    throw new Error('Authorization server issuer mismatch');
  for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    if (!Object.hasOwn(issuer, key)) throw new Error(`Missing ${key}`);
    const value = issuer[key];
    if (typeof value !== 'string' || new URL(value).origin !== configuration.origin)
      throw new Error(`Invalid ${key}`);
  }
  const response = await request(resource, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
  });
  if (
    response.status !== 401 ||
    !response.headers.get('www-authenticate')?.includes(`resource_metadata="${metadataUrl}"`)
  )
    throw new Error('MCP resource did not return the expected 401 metadata challenge');
}

if (import.meta.main) {
  try {
    const configuration = parseProbeConfiguration(process.argv.slice(2));
    const addresses = await lookup(new URL(configuration.origin).hostname, { all: true });
    if (
      !addresses.length ||
      addresses.some(
        ({ address }) =>
          !isIP(address) || nonPublicNetworks.some((cidr) => isAddressInCidr(address, cidr)),
      )
    )
      throw new Error('DNS returned a non-public address');
    await checkDeployment(configuration);
    console.info(`Deployment smoke passed: ${configuration.origin}${configuration.path}`);
  } catch (error) {
    console.error(
      `Deployment smoke failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
