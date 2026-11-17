/**
 * The stubs `tests/e2e/capabilities-states.spec.ts` answers the host with are read here through the
 * page's own client functions, which parse them with the client schemas: a stub the page would
 * reject (a wrong enum value, a missing field) fails here, in a unit test, not as a missing detail
 * in the browser (CI run 44112222921: `approval: 'allow'` made the whole sources read fail).
 */
import { describe, expect, test } from 'bun:test';

import {
  DEMO_PLUGIN,
  githubNotLoaded,
  LEDGER_EDITING,
  LEDGER_PROBE,
  RELEASE_NOTES_INSTRUCTIONS,
  RELEASE_NOTES_SKILLS,
  SIGN_IN_START,
} from '../../../tests/e2e/capabilities-states-stubs.ts';
import { getSkillInstructions, listSkillCatalog } from '../../lib/bureau-skills.ts';
import { getPlugins } from '../../lib/host-plugins.ts';
import {
  getToolSourceEditing,
  getToolSources,
  probeToolSource,
  startToolSourceSignIn,
} from '../../lib/host-tool-sources.ts';

/** A fetch that answers every request with `body`. */
const answering = (body: unknown) => async () => Response.json(body);

/** A fetch that answers a Bureau call with `result`. */
const bureauAnswering = (result: unknown) => async () =>
  Response.json({ jsonrpc: '2.0', id: 1, result });

/** The sample world's GitHub source before a stub changes it: loaded, saved without a name. */
const SAMPLE_GITHUB = {
  id: 'github',
  kind: 'mcp',
  localCommand: true,
  state: 'loaded',
  tools: [],
  skipped: [],
  unmatchedSettings: [],
  credentials: [],
};

describe('the stubs of the capabilities states spec', () => {
  for (const state of ['failed', 'needs-authorization'] as const) {
    test(`a GitHub source that is ${state} is a source the page reads, with its last listing`, async () => {
      const snapshot = await getToolSources({
        fetch: answering({
          configurationRevision: null,
          sources: [githubNotLoaded(SAMPLE_GITHUB, state, 'The source could not be reached.')],
        }),
      });
      const [github] = snapshot.sources;
      expect(github?.name).toBe('GitHub');
      expect(github?.lastListing?.tools.map((tool) => tool.name)).toEqual([
        'github__list_issues',
        'github__create_issue',
      ]);
    });
  }

  test('a disabled plugin is a plugin the page reads, with its last listing', async () => {
    const snapshot = await getPlugins({
      fetch: answering({ configurationRevision: null, plugins: [DEMO_PLUGIN], unloaded: [] }),
    });
    expect(snapshot.plugins[0]?.lastListing?.tools.map((tool) => tool.name)).toEqual([
      'demo__draft-release-notes',
    ]);
  });

  test('the skill and its instructions are read by the page', async () => {
    const catalog = await listSkillCatalog({ fetch: bureauAnswering(RELEASE_NOTES_SKILLS) });
    expect(catalog.skills.map((skill) => skill.name)).toEqual(['release-notes']);
    const read = await getSkillInstructions('release-notes', {
      fetch: bureauAnswering(RELEASE_NOTES_INSTRUCTIONS),
    });
    expect(read.instructions?.size).toBe(1229);
  });

  test('the edit read, the probe and the start of a sign-in are read by the page', async () => {
    const editing = await getToolSourceEditing('ledger', { fetch: answering(LEDGER_EDITING) });
    expect(editing.credentials).toEqual(['token']);
    const probe = await probeToolSource(
      'ledger',
      { source: LEDGER_EDITING.source, credentials: {} },
      { fetch: answering(LEDGER_PROBE) },
    );
    expect(probe.outcome).toBe('listed');
    const started = await startToolSourceSignIn('github', LEDGER_EDITING.source, {
      fetch: answering(SIGN_IN_START),
    });
    expect(started.authorized).toBe(false);
  });

  test('a stub the schema does not accept fails here', async () => {
    const wrong = githubNotLoaded(SAMPLE_GITHUB, 'failed');
    const lastListing = wrong['lastListing'] as { tools: Record<string, unknown>[] };
    const rejected = await getToolSources({
      fetch: answering({
        configurationRevision: null,
        sources: [
          {
            ...wrong,
            lastListing: {
              ...lastListing,
              tools: [{ ...lastListing.tools[0], approval: 'allow' }],
            },
          },
        ],
      }),
    }).then(
      () => 'read',
      () => 'rejected',
    );
    expect(rejected).toBe('rejected');
  });
});
