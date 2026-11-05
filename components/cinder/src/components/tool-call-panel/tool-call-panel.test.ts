/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import { resetEscapeStack, resetScrollLock } from '../../_internal/overlay.ts';
import { installDrawerDialogStubs } from '../drawer/drawer-test-helpers.ts';
import { readPanelPayload } from './tool-call-panel.utilities.ts';

test('invalid stored JSON remains a scalar and copies the original text', () => {
  expect(readPanelPayload('{ unfinished')).toEqual({
    present: true,
    fields: [{ key: 'value', label: 'Value', text: '{ unfinished', kind: 'text' }],
    json: '"{ unfinished"',
    copy: '{ unfinished',
  });
});

test('a bigint root has one numeric Value row and copies its digits', () => {
  expect(readPanelPayload(7n)).toEqual({
    present: true,
    fields: [{ key: 'value', label: 'Value', text: '7', kind: 'number' }],
    json: '7',
    copy: '7',
  });
});

setupHappyDom();
installDrawerDialogStubs();

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { tick } = await import('svelte');
const { default: ToolCallPanel } = await import('./tool-call-panel.svelte');

const cssText = await Bun.file(new URL('./tool-call-panel.css', import.meta.url)).text();

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  resetScrollLock();
  resetEscapeStack();
});

const text = (element: Element | null): string =>
  (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

const failed = {
  placement: 'docked',
  name: 'Send email',
  identifier: 'send-email',
  status: 'failed',
  duration: '10.0s',
  position: 'call 28 of 30',
  input: { to: 'maya@example.com', template: 'refund-notice', orderId: '4471' },
  error: {
    message: 'No reply from mail.example.com after 10s',
    code: 'smtp-timeout',
    retryable: true,
  },
  retryMessage: 'Please retry Send email to maya@example.com',
} as const;

const fieldRows = (root: Element): string[][] =>
  [...root.querySelectorAll('.cinder-tool-call-panel__field')].map((row) => [
    text(row.querySelector('dt')),
    text(row.querySelector('dd')),
  ]);

describe('ToolCallPanel header', () => {
  test('the heading names the panel with the identifier and the status line reads the state, duration and position', () => {
    const { container } = render(ToolCallPanel, { props: { ...failed } });
    const aside = container.querySelector('aside');
    expect(aside?.getAttribute('aria-labelledby')).toBe(
      container.querySelector('h2')?.getAttribute('id'),
    );
    expect(text(container.querySelector('h2'))).toBe('Send email send-email');
    expect(container.querySelector('.cinder-tool-call-panel__identifier')?.tagName).toBe('CODE');
    expect(text(container.querySelector('.cinder-tool-call-panel__status'))).toContain(
      'Failed · 10.0s · call 28 of 30',
    );
  });

  test('summary replaces the status word, duration and position', () => {
    const { container } = render(ToolCallPanel, {
      props: {
        placement: 'docked',
        name: 'Lookup order',
        status: 'done',
        summary: 'Reads · ran in 0.4s',
      },
    });
    expect(text(container.querySelector('.cinder-tool-call-panel__status'))).toBe(
      'Reads · ran in 0.4s',
    );
  });

  test.each([
    ['done', 'Done'],
    ['approved', 'Approved'],
    ['running', 'Running'],
    ['waiting', 'Waiting on you'],
    ['denied', 'Denied'],
    ['failed', 'Failed'],
  ] as const)('%s reads %s and can be written in another language', (status, word) => {
    const { container, unmount } = render(ToolCallPanel, {
      props: { placement: 'docked', name: 'Tool', status },
    });
    expect(text(container.querySelector('.cinder-tool-call-panel__status-word'))).toBe(word);
    unmount();
    const other = render(ToolCallPanel, {
      props: {
        placement: 'docked',
        name: 'Tool',
        status,
        labels: { status: { [status]: 'Fait' } },
      },
    });
    expect(text(other.container.querySelector('.cinder-tool-call-panel__status-word'))).toBe(
      'Fait',
    );
  });

  test('a running call shows a spinner in place of the dot', () => {
    const { container } = render(ToolCallPanel, {
      props: { placement: 'docked', name: 'Tool', status: 'running', duration: '1.2s' },
    });
    expect(
      container.querySelector('.cinder-tool-call-panel__marker .cinder-spinner'),
    ).not.toBeNull();
    expect(container.querySelector('.cinder-tool-call-panel__dot')).toBeNull();
  });
});

describe('ToolCallPanel sections', () => {
  test('a failed call lists Input as labelled fields and the Error message first, then Code and Retryable', () => {
    const { container } = render(ToolCallPanel, { props: { ...failed } });
    const sections = [...container.querySelectorAll('section')];
    expect(sections.map((section) => text(section.querySelector('h3')))).toEqual([
      'Input',
      'Error',
    ]);
    expect(fieldRows(sections[0]!)).toEqual([
      ['To', 'maya@example.com'],
      ['Template', 'refund-notice'],
      ['Order ID', '4471'],
    ]);
    expect(fieldRows(sections[1]!)).toEqual([
      ['Message', 'No reply from mail.example.com after 10s'],
      ['Code', 'smtp-timeout'],
      ['Retryable', 'Yes'],
    ]);
    expect(sections[1]!.querySelector('[data-cinder-tone="danger"]')).not.toBeNull();
    expect(sections[1]!.querySelector('dd[data-cinder-kind="code"]')).not.toBeNull();
  });

  test('a failed call explains what retrying sends and offers the secondary retry and the copy buttons', async () => {
    const onRetry = mock(() => undefined);
    const { container, getByRole } = render(ToolCallPanel, { props: { ...failed, onRetry } });
    expect(text(container.querySelector('.cinder-tool-call-panel__note'))).toContain(
      'Failures aren’t retried automatically. Ask the agent to retry sends “Please retry Send email to maya@example.com” as your message',
    );
    const retry = getByRole('button', { name: 'Ask the agent to retry' });
    expect(retry.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(retry.querySelector('svg')).not.toBeNull();
    await fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(getByRole('button', { name: 'Copy input' })).toBeTruthy();
    expect(getByRole('button', { name: 'Copy error' })).toBeTruthy();
  });

  test('without onRetry there is no retry button and no primary action in the panel', () => {
    const { queryByRole, container } = render(ToolCallPanel, { props: { ...failed } });
    expect(queryByRole('button', { name: 'Ask the agent to retry' })).toBeNull();
    expect(container.querySelector('[data-cinder-variant="primary"]')).toBeNull();
  });

  test('a done call shows Input and Result as fields with Copy input and Copy result', () => {
    const { container, getByRole } = render(ToolCallPanel, {
      props: {
        placement: 'docked',
        name: 'Lookup order',
        identifier: 'lookup-order',
        status: 'done',
        duration: '0.2s',
        input: { orderId: '4471' },
        result: { amount: '$42.00', delivered: 'Monday', flag: 'Damaged' },
      },
    });
    const sections = [...container.querySelectorAll('section')];
    expect(sections.map((section) => text(section.querySelector('h3')))).toEqual([
      'Input',
      'Result',
    ]);
    expect(fieldRows(sections[1]!)).toEqual([
      ['Amount', '$42.00'],
      ['Delivered', 'Monday'],
      ['Flag', 'Damaged'],
    ]);
    expect(text(container.querySelector('.cinder-tool-call-panel__status'))).toContain(
      'Done · 0.2s',
    );
    expect(getByRole('button', { name: 'Copy input' })).toBeTruthy();
    expect(getByRole('button', { name: 'Copy result' })).toBeTruthy();
  });

  test('a running call shows its Input and says the result is coming, with no copy buttons', () => {
    const { container, queryByRole } = render(ToolCallPanel, {
      props: {
        placement: 'docked',
        name: 'Lookup order',
        status: 'running',
        duration: '1.2s',
        input: { orderId: '4492' },
      },
    });
    const sections = [...container.querySelectorAll('section')];
    expect(sections.map((section) => text(section.querySelector('h3')))).toEqual([
      'Input',
      'Result',
    ]);
    expect(text(sections[1]!)).toContain('The result appears when the call finishes.');
    expect(queryByRole('button', { name: 'Copy input' })).toBeNull();
  });

  test('a call with no input says so', () => {
    const { container } = render(ToolCallPanel, {
      props: { placement: 'docked', name: 'List tools', status: 'done' },
    });
    expect(text(container)).toContain('This tool call takes no input.');
  });

  test('the Result heading can be renamed and the copy button follows it', () => {
    const { container, getByRole } = render(ToolCallPanel, {
      props: {
        placement: 'docked',
        name: 'Lookup order',
        status: 'done',
        resultLabel: 'Output',
        result: { total: 42 },
      },
    });
    expect(text(container.querySelectorAll('h3')[1] ?? null)).toBe('Output');
    expect(getByRole('button', { name: 'Copy output' })).toBeTruthy();
  });

  test('values read as the Fields view reads them: dates, booleans, none, empty and identifiers', () => {
    const { container } = render(ToolCallPanel, {
      props: {
        placement: 'docked',
        name: 'Tool',
        status: 'done',
        input: {
          shippedOn: '2026-10-24',
          insured: true,
          coupon: null,
          giftNote: '',
          trackingId: 'abc123',
          parts: [1, 2],
        },
      },
    });
    expect(fieldRows(container)).toEqual([
      ['Shipped on', 'Oct 24, 2026'],
      ['Insured', 'Yes'],
      ['Coupon', 'None'],
      ['Gift note', 'Empty'],
      ['Tracking ID', 'abc123'],
      ['Parts', '[ 1, 2 ]'],
    ]);
    expect(container.querySelector('dd[data-cinder-kind="code"]')).not.toBeNull();
    expect(container.querySelector('dd[data-cinder-kind="none"]')).not.toBeNull();
  });

  test('secret values are hidden in the fields, the JSON view and the copy value', () => {
    const input = { orderId: '4471', authorization: 'Bearer abc', apiKey: 'sk-live-1' };
    const fields = render(ToolCallPanel, {
      props: { placement: 'docked', name: 'Tool', status: 'done', input },
    });
    expect(fieldRows(fields.container)).toEqual([
      ['Order ID', '4471'],
      ['Authorization', 'Hidden'],
      ['API key', 'Hidden'],
    ]);
    expect(fields.container.innerHTML).not.toContain('sk-live-1');
    expect(fields.container.innerHTML).not.toContain('Bearer abc');
    fields.unmount();

    const json = render(ToolCallPanel, {
      props: { placement: 'docked', name: 'Tool', status: 'done', input, view: 'json' },
    });
    expect(json.container.innerHTML).not.toContain('sk-live-1');
    expect(text(json.container.querySelector('.cinder-tool-call-panel__json'))).toContain('••••');
  });

  test('redact names the secret paths and an empty list hides nothing', () => {
    const { container } = render(ToolCallPanel, {
      props: {
        placement: 'docked',
        name: 'Tool',
        status: 'done',
        input: { token: 'visible', note: 'hidden' },
        redact: ['note'],
      },
    });
    expect(fieldRows(container)).toEqual([
      ['Token', 'visible'],
      ['Note', 'Hidden'],
    ]);
  });

  test('view="json" shows the stored text of a payload given as JSON text, and a flat object on one line', () => {
    const { container } = render(ToolCallPanel, {
      props: {
        placement: 'docked',
        name: 'Lookup order',
        status: 'done',
        view: 'json',
        input: '{ "orderId": "4471" }',
        result: { total: 42, status: 'paid' },
      },
    });
    const blocks = [...container.querySelectorAll('.cinder-tool-call-panel__json')].map(text);
    expect(blocks).toEqual(['{ "orderId": "4471" }', '{ "total": 42, "status": "paid" }']);
  });
});

describe('ToolCallPanel decision', () => {
  const waiting = {
    placement: 'docked',
    name: 'Issue refund',
    identifier: 'issue-refund',
    status: 'waiting',
    input: { orderId: '4480', amount: '$27.25', reason: 'Arrived damaged' },
  } as const;

  test('a waiting call shows a note field and Deny and Approve, with Approve the only primary', () => {
    const { container, getByRole, getByLabelText } = render(ToolCallPanel, {
      props: { ...waiting, onApprove: () => undefined, onDeny: () => undefined },
    });
    expect(getByLabelText('Note (optional)')).toBeTruthy();
    expect(text(container)).toContain(
      'Saved with your decision. If you deny, the agent reads it as the reason.',
    );
    expect(getByRole('button', { name: 'Deny' }).getAttribute('data-cinder-variant')).toBe(
      'secondary',
    );
    expect(getByRole('button', { name: 'Approve' }).getAttribute('data-cinder-variant')).toBe(
      'primary',
    );
    expect(container.querySelectorAll('[data-cinder-variant="primary"]')).toHaveLength(1);
    expect(container.querySelector('section[aria-labelledby$="-result"]')).toBeNull();
  });

  test('Approve and Deny send the note', async () => {
    const onApprove = mock((_note: string) => undefined);
    const onDeny = mock((_note: string) => undefined);
    const { getByRole, getByLabelText } = render(ToolCallPanel, {
      props: { ...waiting, onApprove, onDeny },
    });
    await fireEvent.input(getByLabelText('Note (optional)'), {
      target: { value: 'Photo checked' },
    });
    await fireEvent.click(getByRole('button', { name: 'Approve' }));
    await fireEvent.click(getByRole('button', { name: 'Deny' }));
    expect(onApprove).toHaveBeenCalledWith('Photo checked');
    expect(onDeny).toHaveBeenCalledWith('Photo checked');
  });

  test('without a handler there is no decision bar', () => {
    const { queryByRole } = render(ToolCallPanel, { props: { ...waiting } });
    expect(queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  test('while an answer is on its way both buttons are off and the note is read-only', () => {
    const { getByRole, getByLabelText } = render(ToolCallPanel, {
      props: {
        ...waiting,
        onApprove: () => undefined,
        onDeny: () => undefined,
        resolving: 'approve',
      },
    });
    expect(getByRole('button', { name: 'Deny' }).hasAttribute('disabled')).toBe(true);
    expect(
      getByRole('button', { name: /Approv/ }).getAttribute('aria-busy') === 'true' ||
        getByRole('button', { name: /Approv/ }).hasAttribute('disabled') ||
        getByRole('button', { name: /Approv/ }).getAttribute('aria-disabled') === 'true',
    ).toBe(true);
    expect(getByLabelText('Note (optional)').hasAttribute('disabled')).toBe(true);
  });
});

describe('ToolCallPanel placement', () => {
  test('docked draws an aside in the page with an X that closes it and reports onClose once', async () => {
    const onClose = mock(() => undefined);
    const { container, getByRole } = render(ToolCallPanel, { props: { ...failed, onClose } });
    expect(container.querySelector('aside.cinder-tool-call-panel')).not.toBeNull();
    expect(container.querySelector('dialog')).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Close panel' }));
    await tick();
    expect(container.querySelector('aside')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('Esc inside a docked panel closes it', async () => {
    const { container } = render(ToolCallPanel, { props: { ...failed } });
    const aside = container.querySelector('aside')!;
    await fireEvent.keyDown(aside, { key: 'Escape' });
    await tick();
    expect(container.querySelector('aside')).toBeNull();
  });

  test('closed, nothing is drawn', () => {
    const { container } = render(ToolCallPanel, { props: { ...failed, open: false } });
    expect(container.querySelector('aside')).toBeNull();
  });

  test('overlay opens a modal right drawer with the same content, an X and the panel width', async () => {
    const { container } = render(ToolCallPanel, {
      props: { ...failed, placement: 'overlay', open: true },
    });
    await tick();
    const dialog = container.querySelector('dialog.cinder-tool-call-panel-drawer');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('data-cinder-modal')).toBe('true');
    expect(
      container.querySelector('.cinder-drawer__panel')?.getAttribute('data-cinder-placement'),
    ).toBe('right');
    expect(container.querySelector('.cinder-drawer__close')?.getAttribute('aria-label')).toBe(
      'Close drawer',
    );
    expect(text(container.querySelector('h2'))).toBe('Send email send-email');
    expect(dialog?.getAttribute('aria-labelledby')).toBe(container.querySelector('h2')?.id ?? '');
  });

  test('sheet opens a bottom drawer with a grabber and a Close button that reads Close', async () => {
    const { container, getByRole } = render(ToolCallPanel, {
      props: { ...failed, placement: 'sheet', open: true, onRetry: () => undefined },
    });
    await tick();
    expect(
      container.querySelector('.cinder-drawer__panel')?.getAttribute('data-cinder-placement'),
    ).toBe('bottom');
    expect(container.querySelector('.cinder-drawer__drag-handle')).not.toBeNull();
    const close = container.querySelector('.cinder-drawer__close');
    expect(text(close)).toBe('Close');
    expect(close?.hasAttribute('aria-label')).toBe(false);
    expect(getByRole('button', { name: 'Ask the agent to retry' })).toBeTruthy();
  });

  test('closing a sheet through Close sets open to false', async () => {
    const onClose = mock(() => undefined);
    const { container } = render(ToolCallPanel, {
      props: { ...failed, placement: 'sheet', open: true, onClose },
    });
    await tick();
    await fireEvent.click(container.querySelector('.cinder-drawer__close')!);
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('an unusable dockedFrom throws', () => {
    expect(() =>
      render(ToolCallPanel, { props: { ...failed, placement: 'auto', dockedFrom: 'wide' } }),
    ).toThrow(/dockedFrom/);
  });
});

describe('ToolCallPanel stylesheet', () => {
  test('docks at about 340px, tints the error block, and gives a phone sheet 44px actions', () => {
    expect(cssText).toContain('--_cinder-tool-call-panel-width: 21.25rem');
    expect(cssText).toMatch(/\[data-cinder-tone='danger'\][^}]*status-danger-background/);
    expect(cssText).toMatch(
      /\[data-cinder-placement='sheet'\] \.cinder-tool-call-panel__retry[^}]*touch-target-min/,
    );
  });

  test('every status the rail has is styled for the dot or the glyph', () => {
    for (const status of ['approved', 'failed', 'waiting']) {
      expect(cssText).toContain(`data-cinder-status='${status}'`);
    }
  });
});
