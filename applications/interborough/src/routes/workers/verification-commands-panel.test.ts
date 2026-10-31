/**
 * The copyable verification commands: each command is printed whole and wraps rather than scrolls,
 * names the files the dashboard can derive, and has its own copy button.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import VerificationCommandsPanel from './verification-commands-panel.svelte';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

function renderPanel() {
  return render(VerificationCommandsPanel, {
    props: {
      headingId: 'commands-heading',
      context: { deploymentName: 'billing', buildId: 'build-a', registryVersion: 7 },
    },
  });
}

describe('VerificationCommandsPanel', () => {
  test('prints both commands in full, with the derived file names', () => {
    const view = renderPanel();

    expect(view.getByRole('heading', { name: 'Verify from the command line' })).not.toBeNull();
    const commands = [
      ...view.container.querySelectorAll('pre.weft-verification-commands__command'),
    ];
    expect(commands).toHaveLength(2);
    expect(commands[1]?.textContent).toMatch(
      /^weft worker verify --manifest billing-build-a\.manifest\.json --from registry-v7\.json$/,
    );
  });

  test('each copy button writes its own command to the clipboard', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });
    const view = renderPanel();

    await fireEvent.click(view.getByRole('button', { name: 'Copy weft codegen command' }));
    await fireEvent.click(view.getByRole('button', { name: 'Copy weft worker verify command' }));

    expect(written).toHaveLength(2);
    expect(written[0]).toMatch(/^weft codegen /);
    expect(written[1]).toMatch(/^weft worker verify /);
  });
});
