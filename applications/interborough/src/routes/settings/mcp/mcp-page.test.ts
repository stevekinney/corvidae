/**
 * `/settings/mcp` (COR-2539): the address of Interborough's MCP endpoint, and the configuration that
 * registers it with Claude Code and with any other MCP client. The address is the origin the page
 * was served from plus `/bureau/mcp`; the Bureau is a stub, since nothing here is a setting.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, render, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { MCP_COPY } from '../../../app/copy/mcp.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import type { BureauStub } from '../../../lib/bureau-stub.test-support.ts';
import { claudeCodeAddCommand } from '../../../lib/mcp-connection.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';
import { installSettingsBureau, servedSettings } from '../settings-fixtures.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const ENDPOINT = 'http://localhost/bureau/mcp';

function open(method?: 'browser-session') {
  stub = installSettingsBureau(servedSettings(), {});
  landAt('/settings/mcp');
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
      ...(method === undefined ? {} : { method }),
    },
  } as never);
}

describe('Settings › MCP', () => {
  test('reads the endpoint address from the origin the page was served from', async () => {
    const view = open();
    expect(await view.findByRole('heading', { level: 1, name: 'MCP' })).not.toBeNull();
    expect(view.getByText(MCP_COPY.intro)).not.toBeNull();
    const group = await view.findByRole('group', { name: MCP_COPY.groupLabel });
    expect(within(group).getByTestId('mcp-endpoint').textContent).toContain(ENDPOINT);
    expect(within(group).getByRole('button', { name: MCP_COPY.endpoint.copy })).not.toBeNull();
  });

  test('shows the Claude Code command and the mcpServers entry, from the shared function', async () => {
    const view = open();
    const group = await view.findByRole('group', { name: MCP_COPY.groupLabel });
    expect(within(group).getByTestId('mcp-claude-code').textContent).toContain(
      claudeCodeAddCommand('interborough', ENDPOINT),
    );
    const generic = within(group).getByTestId('mcp-generic').textContent ?? '';
    expect(generic).toContain('"mcpServers"');
    expect(generic).toContain(`"url": "${ENDPOINT}"`);
    expect(
      within(group)
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent?.trim()),
    ).toEqual([MCP_COPY.endpoint.heading, MCP_COPY.claudeCode.heading, MCP_COPY.generic.heading]);
  });

  test('draws the three sections alike: one column, no card, one heading and description style', async () => {
    const view = open();
    const group = await view.findByRole('group', { name: MCP_COPY.groupLabel });
    const sections = Array.from(group.querySelectorAll('section.cinder-form-section'));
    expect(sections).toHaveLength(3);
    for (const section of sections) {
      expect(section.getAttribute('data-columns')).toBe('1');
      expect(section.getAttribute('data-grouped')).toBeNull();
      expect(section.querySelector('h2.cinder-form-section__heading')).not.toBeNull();
      expect(section.querySelector('p.cinder-form-section__description')).not.toBeNull();
    }
    // The endpoint is not a settings row: its address follows the description directly.
    expect(group.querySelector('.cinder-setting-row')).toBeNull();
    expect(sections[0]?.querySelector('[data-testid="mcp-endpoint"]')).not.toBeNull();
  });

  test('says the endpoint needs no sign-in in its own description, not in the page intro', async () => {
    const view = open();
    const group = await view.findByRole('group', { name: MCP_COPY.groupLabel });
    expect(MCP_COPY.intro).not.toContain('sign-in');
    const description = group.querySelector('p.cinder-form-section__description');
    expect(description?.textContent).toContain(
      'It needs no sign-in: the host listens on this computer only.',
    );
  });

  test('explains shared OAuth sign-in and limited grants while preserving connection details', async () => {
    const view = open('browser-session');
    const group = await view.findByRole('group', { name: MCP_COPY.groupLabel });
    expect(within(group).getByText(MCP_COPY.endpoint.sharedDescription)).not.toBeNull();
    expect(within(group).getByText(MCP_COPY.claudeCode.sharedDescription)).not.toBeNull();
    expect(group.textContent).toContain('Use a client that supports MCP OAuth');
    expect(group.textContent).not.toContain('It needs no sign-in');
    expect(within(group).getByTestId('mcp-claude-code').textContent).toContain(
      claudeCodeAddCommand('interborough', ENDPOINT),
    );
    expect(within(group).getByTestId('mcp-generic').textContent).toContain(`"url": "${ENDPOINT}"`);
  });

  test('sets .mcp.json in code and names the HTTP transport', async () => {
    const view = open();
    const group = await view.findByRole('group', { name: MCP_COPY.groupLabel });
    const descriptions = group.querySelectorAll('p.cinder-form-section__description');
    const generic = descriptions[2];
    expect(generic?.querySelector('code')?.textContent).toBe('.mcp.json');
    expect(generic?.textContent).toContain(
      'such as an .mcp.json file. It uses the HTTP transport.',
    );
    expect(group.textContent).not.toContain('plain HTTP one');
  });

  test('names each copy button for what it copies, with no header row above the code', async () => {
    const view = open();
    const group = await view.findByRole('group', { name: MCP_COPY.groupLabel });
    const claudeCode = within(group).getByTestId('mcp-claude-code');
    const generic = within(group).getByTestId('mcp-generic');
    expect(
      within(claudeCode).getByRole('button', { name: MCP_COPY.claudeCode.copy }),
    ).not.toBeNull();
    expect(within(generic).getByRole('button', { name: MCP_COPY.generic.copy })).not.toBeNull();
    for (const block of [claudeCode, generic]) {
      expect(
        block
          .querySelector('.cinder-code-block')
          ?.classList.contains('cinder-code-block--floating-meta'),
      ).toBe(true);
    }
  });

  test('shows no credential anywhere on the page', async () => {
    const view = open();
    const group = await view.findByRole('group', { name: MCP_COPY.groupLabel });
    expect(group.textContent).not.toMatch(/authorization|bearer|api[-_ ]?key|secret|password/i);
  });
});
