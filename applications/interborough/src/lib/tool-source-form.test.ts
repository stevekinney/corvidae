/** The Connect dialog's form: the request it builds for the host, and the fields it names when it cannot. */
import { describe, expect, test } from 'bun:test';

import { CAPABILITIES_COPY } from '../app/copy.ts';
import {
  authenticationChoices,
  buildToolSourceRequest,
  chosenToolCount,
  connectedTools,
  effectiveAuthentication,
  EMPTY_TOOL_SOURCE_FORM,
  fieldOfHostField,
  startingApproval,
  startingToolChoices,
  toolSettingsOf,
  type ToolSourceForm,
} from './tool-source-form.ts';

const errors = CAPABILITIES_COPY.source.connect.errors;
const form = (extra: Partial<ToolSourceForm>): ToolSourceForm => ({
  ...EMPTY_TOOL_SOURCE_FORM,
  id: 'notes',
  ...extra,
});

describe('buildToolSourceRequest', () => {
  test('describes an MCP server reached by URL, with no authentication, a bearer token, or OAuth', () => {
    const url = 'https://example.com/mcp';

    expect(buildToolSourceRequest(form({ url }))).toEqual({
      id: 'notes',
      request: {
        source: { id: 'notes', kind: 'mcp', transport: { type: 'http', url } },
        credentials: {},
      },
    });
    expect(
      buildToolSourceRequest(form({ url, authentication: 'bearer', secret: ' tok ' })),
    ).toEqual({
      id: 'notes',
      request: {
        source: {
          id: 'notes',
          kind: 'mcp',
          transport: {
            type: 'http',
            url,
            authentication: { type: 'bearer', credential: 'token' },
          },
        },
        credentials: { token: 'tok' },
      },
    });
    expect(buildToolSourceRequest(form({ url, authentication: 'oauth' }))).toMatchObject({
      request: {
        source: { transport: { authentication: { type: 'oauth' } } },
        credentials: {},
      },
    });
  });

  test('describes a local command with the lines of its arguments that have something on them', () => {
    expect(
      buildToolSourceRequest(
        form({ transport: 'stdio', command: ' npx ', args: ' -y \n\n pkg \n' }),
      ),
    ).toMatchObject({
      request: {
        source: { transport: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] } },
      },
    });
    expect(buildToolSourceRequest(form({ transport: 'stdio', command: 'tool' }))).toMatchObject({
      request: { source: { transport: { type: 'stdio', command: 'tool' } } },
    });
  });

  test('ignores a command and a token for an MCP server that does not use them', () => {
    const result = buildToolSourceRequest(
      form({ url: 'https://example.com/mcp', command: 'rm', args: '-rf', secret: 'leftover' }),
    );

    expect(result).toMatchObject({ request: { credentials: {} } });
    expect(JSON.stringify(result)).not.toContain('rm');
    expect(JSON.stringify(result)).not.toContain('leftover');
  });

  test('describes an OpenAPI service from a URL or a file, with a base URL and a bearer token or an API key', () => {
    const fromUrl = buildToolSourceRequest(
      form({
        kind: 'openapi',
        specificationUrl: 'https://example.com/openapi.json',
        baseUrl: ' https://api.example.com ',
        authentication: 'api-key',
        header: ' x-api-key ',
        secret: 'k',
      }),
    );
    const fromFile = buildToolSourceRequest(
      form({
        kind: 'openapi',
        specification: 'file',
        document: '{"openapi":"3.0.0"}',
        authentication: 'bearer',
        secret: 't',
      }),
    );

    expect(fromUrl).toEqual({
      id: 'notes',
      request: {
        source: {
          id: 'notes',
          kind: 'openapi',
          specification: { type: 'url', url: 'https://example.com/openapi.json' },
          baseUrl: 'https://api.example.com',
          authentication: { type: 'api-key', header: 'x-api-key', credential: 'key' },
        },
        credentials: { key: 'k' },
      },
    });
    expect(fromFile).toEqual({
      id: 'notes',
      request: {
        source: {
          id: 'notes',
          kind: 'openapi',
          specification: { type: 'document', document: { openapi: '3.0.0' } },
          authentication: { type: 'bearer', credential: 'token' },
        },
        credentials: { token: 't' },
      },
    });
  });

  test('names each field that needs a value, and only those the choices made apply to', () => {
    expect(buildToolSourceRequest(EMPTY_TOOL_SOURCE_FORM)).toEqual({
      errors: { id: errors.idRequired, url: errors.urlRequired },
    });
    expect(buildToolSourceRequest(form({ id: 'Bad Name', transport: 'stdio' }))).toEqual({
      errors: { id: errors.idInvalid, command: errors.commandRequired },
    });
    expect(
      buildToolSourceRequest(form({ url: 'https://x.example', authentication: 'bearer' })),
    ).toEqual({ errors: { secret: errors.secretRequired.bearer } });
    expect(
      buildToolSourceRequest(
        form({ kind: 'openapi', authentication: 'api-key', specification: 'file' }),
      ),
    ).toEqual({
      errors: {
        document: errors.documentRequired,
        secret: errors.secretRequired['api-key'],
        header: errors.headerRequired,
      },
    });
    expect(buildToolSourceRequest(form({ kind: 'openapi' }))).toEqual({
      errors: { specificationUrl: errors.specificationUrlRequired },
    });
  });

  test('refuses a file that is not a JSON object', () => {
    for (const document of ['nope', '[1]', '3', 'null']) {
      expect(
        buildToolSourceRequest(form({ kind: 'openapi', specification: 'file', document })),
      ).toEqual({ errors: { document: errors.documentInvalid } });
    }
  });

  test('never names a credential in what it says is missing', () => {
    const result = buildToolSourceRequest(
      form({ url: 'https://x.example', authentication: 'bearer', secret: '   ' }),
    );

    expect(JSON.stringify(result)).not.toContain('   ');
  });
});

describe('the authentication a form offers', () => {
  test('depends on the kind and how an MCP server is reached', () => {
    expect(authenticationChoices({ kind: 'mcp', transport: 'http' })).toEqual([
      'none',
      'bearer',
      'oauth',
    ]);
    expect(authenticationChoices({ kind: 'mcp', transport: 'stdio' })).toEqual(['none']);
    expect(authenticationChoices({ kind: 'openapi', transport: 'http' })).toEqual([
      'none',
      'bearer',
      'api-key',
    ]);
  });

  test('falls back to none when the choice made no longer applies', () => {
    expect(effectiveAuthentication(form({ authentication: 'oauth', kind: 'openapi' }))).toBe(
      'none',
    );
    expect(effectiveAuthentication(form({ authentication: 'bearer', transport: 'stdio' }))).toBe(
      'none',
    );
    expect(effectiveAuthentication(form({ authentication: 'bearer' }))).toBe('bearer');
  });
});

describe('fieldOfHostField', () => {
  test('maps the fields the host names to the inputs that are on screen', () => {
    const mcp = { kind: 'mcp', transport: 'http', specification: 'url' } as const;
    const command = { kind: 'mcp', transport: 'stdio', specification: 'url' } as const;
    const file = { kind: 'openapi', transport: 'http', specification: 'file' } as const;
    const url = { kind: 'openapi', transport: 'http', specification: 'url' } as const;

    expect(fieldOfHostField('id', mcp)).toBe('id');
    expect(fieldOfHostField('source.id', mcp)).toBe('id');
    expect(fieldOfHostField('credentials.token', mcp)).toBe('secret');
    expect(fieldOfHostField('source.transport.url', mcp)).toBe('url');
    expect(fieldOfHostField('source.transport.command', command)).toBe('command');
    expect(fieldOfHostField('source.baseUrl', url)).toBe('baseUrl');
    expect(fieldOfHostField('source.specification.url', url)).toBe('specificationUrl');
    expect(fieldOfHostField('source.specification.document', file)).toBe('document');
  });

  test('has no field for one that is not on screen, so the refusal is shown for the whole request', () => {
    const mcp = { kind: 'mcp', transport: 'http', specification: 'url' } as const;
    const command = { kind: 'mcp', transport: 'stdio', specification: 'url' } as const;

    expect(fieldOfHostField('source.transport.url', command)).toBeUndefined();
    expect(fieldOfHostField('source.transport.command', mcp)).toBeUndefined();
    expect(fieldOfHostField('source.baseUrl', mcp)).toBeUndefined();
    expect(fieldOfHostField('source.specification.url', mcp)).toBeUndefined();
    expect(fieldOfHostField('source', mcp)).toBeUndefined();
  });
});

describe('the name and description a connect carries (COR-2022)', () => {
  test('are sent trimmed, and left out when empty so the host keeps what it saved', () => {
    const url = 'https://mcp.github.example/mcp';

    expect(
      buildToolSourceRequest(form({ url, name: ' GitHub ', description: ' Issues and files. ' })),
    ).toMatchObject({
      request: { name: 'GitHub', description: 'Issues and files.' },
    });
    const plain = buildToolSourceRequest(form({ url, name: '  ' }));
    expect(plain).not.toHaveProperty('request.name');
    expect(plain).not.toHaveProperty('request.description');
  });
});

describe('Choose tools (COR-2022)', () => {
  const listed = [
    { tool: 'list_issues', tier: 'read-only', title: 'List issues' },
    { tool: 'create_issue', tier: 'mutating', title: 'Create issue' },
    { tool: 'delete_branch', tier: 'dangerous', title: 'Delete branch' },
  ];
  const tiers = Object.fromEntries(listed.map(({ tool, tier }) => [tool, tier]));

  test('start from the server’s hints: a read on Never, a change on On changes, a dangerous tool on Always', () => {
    expect(startingApproval('read-only')).toBe('never');
    expect(startingApproval('mutating')).toBe('on-changes');
    expect(startingApproval('dangerous')).toBe('always');
    expect(startingApproval(null)).toBe('on-changes');
    expect(startingToolChoices('mcp', listed)).toEqual({
      list_issues: { on: true, approval: 'never' },
      create_issue: { on: true, approval: 'on-changes' },
      delete_branch: { on: true, approval: 'always' },
    });
    // An OpenAPI spec's reads start on and its changes start off.
    expect(startingToolChoices('openapi', listed)).toMatchObject({
      list_issues: { on: true },
      create_issue: { on: false },
      delete_branch: { on: false },
    });
  });

  test('send a tool left off as off, and a level only when it is not the tier’s', () => {
    const choices = {
      list_issues: { on: true, approval: 'never' as const },
      create_issue: { on: true, approval: 'always' as const },
      delete_branch: { on: false, approval: 'always' as const },
    };

    expect(toolSettingsOf(choices, tiers)).toEqual({
      create_issue: { approval: 'always' },
      delete_branch: { enabled: false },
    });
    expect(chosenToolCount(choices)).toBe(2);
    // A server that offers no tools still connects, with an empty choice.
    expect(toolSettingsOf({}, {})).toEqual({});
    expect(chosenToolCount({})).toBe(0);
  });

  test('list what was connected: each tool’s level, or off', () => {
    const choices = {
      list_issues: { on: true, approval: 'never' as const },
      create_issue: { on: true, approval: 'on-changes' as const },
      delete_branch: { on: false, approval: 'always' as const },
    };

    expect(connectedTools(listed, choices)).toEqual([
      { tool: 'list_issues', title: 'List issues', approval: 'never' },
      { tool: 'create_issue', title: 'Create issue', approval: 'on-changes' },
      { tool: 'delete_branch', title: 'Delete branch', approval: 'off' },
    ]);
  });
});
