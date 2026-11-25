import { throwingRejectionOf } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';
import { checkDeployment, parseProbeConfiguration, type ProbeFetch } from './deployed-smoke';

describe('deployed smoke', () => {
  const configuration = parseProbeConfiguration([
    'https://equipment.example',
    '/api/mcp',
    'equipment:read',
    'equipment:write',
  ]);
  const request: ProbeFetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/.well-known/oauth-protected-resource/api/mcp'))
      return Response.json({
        resource: 'https://equipment.example/api/mcp',
        authorization_servers: ['https://equipment.example'],
        scopes_supported: ['equipment:read', 'equipment:write'],
      });
    if (url.endsWith('/.well-known/oauth-authorization-server'))
      return Response.json({
        issuer: 'https://equipment.example',
        authorization_endpoint: 'https://equipment.example/oauth/authorize',
        token_endpoint: 'https://equipment.example/oauth/token',
        registration_endpoint: 'https://equipment.example/oauth/register',
      });
    return new Response(null, {
      status: 401,
      headers: {
        'www-authenticate':
          'Bearer resource_metadata="https://equipment.example/.well-known/oauth-protected-resource/api/mcp"',
      },
    });
  };
  test('checks the configured nested resource and scopes', async () => {
    expect(await checkDeployment(configuration, request)).toBeUndefined();
    expect(
      await throwingRejectionOf(
        checkDeployment({ ...configuration, scopes: ['missing'] }, request),
      ),
    ).toThrow('scope mismatch');
    expect(
      await throwingRejectionOf(checkDeployment({ ...configuration, path: '/mcp' }, request)),
    ).toThrow();
  });
  test('rejects noncanonical input', () => {
    expect(() => parseProbeConfiguration(['http://example.com', '/mcp', 'read'])).toThrow();
    expect(() =>
      parseProbeConfiguration(['https://example.com', '/mcp?query=1', 'read']),
    ).toThrow();
  });
});
