/** The Connect tools page's form: the request it builds for the host, and the fields it names when it cannot. */
import { describe, expect, test } from 'bun:test';

import { CAPABILITIES_COPY } from '../app/copy/capabilities.ts';
import {
  authenticationChoices,
  buildToolSourceRequest,
  chosenToolCount,
  connectedTools,
  effectiveAuthentication,
  EMPTY_TOOL_SOURCE_FORM,
  fieldOfHostField,
  openApiToolName,
  splitCommandLine,
  startingApproval,
  startingToolChoices,
  toolSettingsOf,
  toolSourceIdentifier,
  type ToolSourceForm,
} from './tool-source-form.ts';

const errors = CAPABILITIES_COPY.source.connect.errors;
const form = (extra: Partial<ToolSourceForm>): ToolSourceForm => ({
  ...EMPTY_TOOL_SOURCE_FORM,
  id: 'notes',
  ...extra,
});

describe('openApiToolName', () => {
  test('names an operation’s tool as Armorer does: its operationId in kebab case', () => {
    expect(openApiToolName('createPet')).toBe('create-pet');
    expect(openApiToolName('listRefunds')).toBe('list-refunds');
    expect(openApiToolName('list_invoices')).toBe('list-invoices');
    expect(openApiToolName('get{id}Item')).toBe('getid-item');
    expect(openApiToolName('--refund--')).toBe('refund');
  });
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

  test('describes a local command from its one line: the first word, then its arguments (row 33o)', () => {
    expect(
      buildToolSourceRequest(form({ transport: 'stdio', command: ' npx  -y \t pkg ' })),
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
      form({ url: 'https://example.com/mcp', command: 'rm -rf', secret: 'leftover' }),
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
        baseUrl: 'https://files.example.com',
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
          baseUrl: 'https://files.example.com',
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
        baseUrl: errors.baseUrlRequired,
      },
    });
    // An OpenAPI spec's Base URL is required (row 33u).
    expect(buildToolSourceRequest(form({ kind: 'openapi' }))).toEqual({
      errors: {
        specificationUrl: errors.specificationUrlRequired,
        baseUrl: errors.baseUrlRequired,
      },
    });
    // The page makes the identifier from the name: a name with no letter makes none.
    expect(buildToolSourceRequest(form({ id: '', name: '42', url: 'https://x.example' }))).toEqual({
      errors: { id: errors.nameInvalid },
    });
    expect(buildToolSourceRequest(form({ transport: 'stdio', command: '   ' }))).toEqual({
      errors: { command: errors.commandRequired },
    });
  });

  test('sends the name a person gave the source beside the identifier made from it', () => {
    expect(
      buildToolSourceRequest(
        form({ id: toolSourceIdentifier('GitHub'), name: ' GitHub ', url: 'https://x.example' }),
      ),
    ).toMatchObject({ id: 'github', request: { source: { id: 'github' }, name: 'GitHub' } });
  });

  test('refuses a file that is not a JSON object', () => {
    for (const document of ['nope', '[1]', '3', 'null']) {
      expect(
        buildToolSourceRequest(
          form({
            kind: 'openapi',
            specification: 'file',
            document,
            baseUrl: 'https://files.example.com',
          }),
        ),
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
    // In the order Sign in offers them (rows 33g, 33u).
    expect(authenticationChoices({ kind: 'mcp', transport: 'http' })).toEqual([
      'oauth',
      'bearer',
      'none',
    ]);
    expect(authenticationChoices({ kind: 'mcp', transport: 'stdio' })).toEqual(['none']);
    expect(authenticationChoices({ kind: 'openapi', transport: 'http' })).toEqual([
      'api-key',
      'bearer',
      'none',
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

describe('toolSourceIdentifier', () => {
  test('makes the identifier a source is saved under from the name a person gave it', () => {
    expect(toolSourceIdentifier('GitHub')).toBe('github');
    expect(toolSourceIdentifier('  Payments API  ')).toBe('payments-api');
    expect(toolSourceIdentifier('2nd Notes: v2!')).toBe('nd-notes-v2');
    expect(toolSourceIdentifier('notes')).toBe('notes');
  });

  test('cuts it to 20 characters with no hyphen left at the end', () => {
    expect(toolSourceIdentifier('a'.repeat(30))).toBe('a'.repeat(20));
    expect(toolSourceIdentifier('abcdefghijklmnopqrs tuv')).toBe('abcdefghijklmnopqrs');
  });

  test('makes none from a name with no letter', () => {
    expect(toolSourceIdentifier('')).toBe('');
    expect(toolSourceIdentifier('42 - 7')).toBe('');
  });
});

describe('splitCommandLine', () => {
  test('splits on white space and keeps a quoted stretch as one word without its quotes', () => {
    expect(splitCommandLine('npx -y @example/github-mcp')).toEqual([
      'npx',
      '-y',
      '@example/github-mcp',
    ]);
    expect(splitCommandLine(' node  "my server.js" --name \'a b\' ""')).toEqual([
      'node',
      'my server.js',
      '--name',
      'a b',
      '',
    ]);
    expect(splitCommandLine('   ')).toEqual([]);
  });

  test('runs a quote left open to the end of the line', () => {
    expect(splitCommandLine('tool "two words')).toEqual(['tool', 'two words']);
  });
});
