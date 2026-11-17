/**
 * What `capabilities-states.spec.ts` answers the host's reads with, as plain values the page's own
 * client schemas must accept (`src/routes/capabilities/capabilities-states-stubs.test.ts` parses each
 * through them), so a stub the page would reject fails in a unit test, not in the browser.
 */

type Json = Record<string, unknown>;

/** The time every remembered listing carries. */
export const LISTED_AT = '2026-11-16T08:00:00.000Z';

/** The tools the GitHub source lists, as a failed source remembers them (rows 30n, 30o). */
export const GITHUB_LISTING = [
  {
    name: 'github__list_issues',
    tool: 'list_issues',
    acceptsSecrets: false,
    savedAcceptsSecrets: false,
    enabled: true,
    savedEnabled: true,
    tier: 'read-only',
    approval: 'never',
    approvalSaved: false,
    title: 'List issues',
    description: 'List the open issues of a repository.',
    shortDescription: null,
    inputSchema: null,
  },
  {
    name: 'github__create_issue',
    tool: 'create_issue',
    acceptsSecrets: false,
    savedAcceptsSecrets: false,
    enabled: true,
    savedEnabled: true,
    tier: 'mutating',
    approval: 'on-changes',
    approvalSaved: true,
    title: 'Create issue',
    description: 'Opens an issue in a GitHub repository.',
    shortDescription: null,
    inputSchema: null,
  },
];

/**
 * The GitHub source as a world where it is not loaded would list it: its tools are only
 * remembered. The sample world saves it without a name, so the stub names it "GitHub", as the
 * design's world does (rows 30n, 31o).
 */
export function githubNotLoaded(
  source: Json,
  state: 'failed' | 'needs-authorization',
  message?: string,
): Json {
  return {
    ...source,
    name: 'GitHub',
    state,
    ...(message === undefined ? {} : { message }),
    ...(state === 'needs-authorization' ? { authorized: false } : {}),
    tools: [],
    lastListing: { listedAt: LISTED_AT, truncated: false, tools: GITHUB_LISTING },
  };
}

/** A disabled plugin that last offered Draft release notes (row 30p). */
export const DEMO_PLUGIN = {
  descriptor: {
    name: 'demo',
    title: 'Demo',
    version: '1.0.0',
    description: 'A demonstration plugin.',
    required: false,
    enabledByDefault: false,
  },
  source: 'folder',
  location: '/plugins/demo',
  status: 'disabled',
  problems: [],
  contributions: [],
  enabled: false,
  configuration: null,
  configurationSchema: null,
  running: { enabled: false, configuration: null },
  secrets: [],
  restartRequired: false,
  lastListing: {
    listedAt: LISTED_AT,
    truncated: false,
    tools: [
      {
        name: 'demo__draft-release-notes',
        tool: 'draft-release-notes',
        title: 'Draft release notes',
        description: 'Writes release notes from merged changes.',
        shortDescription: null,
        tier: 'mutating',
        inputSchema: null,
      },
    ],
  },
};

/** The skill the detail states open (rows 31m, 31n). */
export const RELEASE_NOTES_DESCRIPTION = 'Writes release notes from merged changes.';

/** `bureau.skills.list` with one built-in skill. */
export const RELEASE_NOTES_SKILLS = {
  revision: 1,
  trustLocked: null,
  sources: [{ id: 'built-in' }],
  skills: [
    {
      name: 'release-notes',
      description: RELEASE_NOTES_DESCRIPTION,
      source: { id: 'built-in', kind: 'built-in', location: 'built-in', plugin: null },
      trust: 'trusted',
      trustReason: 'Built in.',
      available: true,
      unavailableReason: null,
      allowedTools: [],
      tools: [],
    },
  ],
};

/** `bureau.skills.get` for that skill. */
export const RELEASE_NOTES_INSTRUCTIONS = {
  name: 'release-notes',
  unavailableReason: null,
  instructions: {
    size: 1229,
    truncated: false,
    text: [
      '---',
      'name: release-notes',
      `description: ${RELEASE_NOTES_DESCRIPTION}`,
      '---',
      '',
      'Group the merged pull requests by what changed for a customer.',
      '',
      '- Lead with the change, not the pull request number.',
      '- Ask a person before you publish anything.',
      '- Keep each entry to one sentence.',
      '',
    ].join('\n'),
  },
};

/** A saved HTTP source with a bearer token, as the edit read answers it. */
export const LEDGER_EDITING = {
  id: 'ledger',
  source: {
    id: 'ledger',
    kind: 'mcp',
    transport: {
      type: 'http',
      url: 'https://mcp.ledger.example/mcp',
      authentication: { type: 'bearer', credential: 'token' },
    },
  },
  name: 'Ledger',
  description: 'An MCP server for the ledger.',
  credentials: ['token'],
  configurationRevision: 'revision-read-by-the-page',
};

/** What a probe of that source answers. */
export const LEDGER_PROBE = { outcome: 'listed', tools: [], skipped: [] };

/** What starting a sign-in answers, and how it stands afterwards. */
export const SIGN_IN_START = {
  authorized: false,
  signIn: 'sign-in-1',
  authorizationUrl: 'about:blank',
};
