/// <reference lib="dom" />
import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import Ajv2020 from 'ajv/dist/2020';

import {
  expectNoLeakedTimers,
  requiredInstance,
  setupHappyDom,
  trackTimers,
} from '@lostgradient/testing';
import {
  formatEditableArguments,
  isApprovalActionable,
  prepareArgumentsPreview,
  resolveEffectiveApprovalState,
} from './approval-card-state.ts';
import type { ApprovalCardProps } from './approval-card.types.ts';

setupHappyDom();

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/svelte');
const { createRawSnippet } = await import('svelte');
const { tick } = await import('svelte');
const { default: ApprovalCard } = await import('./approval-card.svelte');
const { default: approvalCardSchema } = await import('./approval-card.schema.ts');
const { default: CodeHighlighterContextFixture } =
  await import('../../test/fixtures/code-highlighter-context-fixture.svelte');

afterEach(() => {
  cleanup();
  if (jest.isFakeTimers()) {
    jest.useRealTimers();
  }
  jest.restoreAllMocks();
  document.body.replaceChildren();
});

// An approval that passed the time its request set says when, in the viewer's zone.
const EXPIRED_NOTICE =
  /^This approval expired at \d{1,2}:\d{2} [AP]M \w+, the time its request set\.$/;

function approvalCardProps(overrides: Partial<ApprovalCardProps> = {}): ApprovalCardProps {
  return {
    tool: { name: 'deploy-cloud', risk: 'medium' },
    sandbox: {
      provider: 'codex',
      name: 'workspace-write',
      workingDir: '/workspace/project',
    },
    operation: {
      kind: 'command',
      command: 'bun run --filter=@lostgradient/cinder test',
      filesTouched: ['components/cinder/src/components/approval-card/approval-card.svelte'],
      argsPreview: { dryRun: false, retries: 1 },
    },
    env: ['DATABASE_URL=postgres://fake-secret-value', 'OPENAI_API_KEY'],
    snapshotId: 'snapshot-123',
    policyVersion: 'policy-2026-06',
    idempotencyKey: 'approval-card-test-key',
    state: 'pending',
    rememberScope: 'the rest of this chat',
    onResolve: () => undefined,
    ...overrides,
  };
}

describe('ApprovalCard', () => {
  test('keeps a single owned padding layer inside Card', () => {
    const styles = readFileSync(new URL('./approval-card.css', import.meta.url), 'utf8');
    const surfaceHeaderRule =
      styles.match(
        /\.cinder-approval-card__surface\s*>\s*\.cinder-card__header\s*\{[^}]*\}/,
      )?.[0] ?? '';
    const ownedHeaderRule = styles.match(/\.cinder-approval-card__header\s*\{[^}]*\}/)?.[0] ?? '';

    expect(surfaceHeaderRule).toContain('padding: 0');
    expect(ownedHeaderRule).toContain('padding: var(--cinder-space-4)');
  });

  test('imports JsonEditor through its public component subpath', () => {
    const actionsSource = readFileSync(
      new URL('./approval-card-actions.svelte', import.meta.url),
      'utf8',
    );

    expect(actionsSource).toContain("from '../json-editor/index.ts'");
    expect(actionsSource).not.toContain("from '../json-editor/json-editor.svelte'");
  });

  test('schema represents the required operation prop', () => {
    expect(approvalCardSchema.required).toContain('operation');
    expect(approvalCardSchema.properties).toHaveProperty('operation');
    expect(approvalCardSchema.metadata?.unsupportedProps?.map((prop) => prop.name)).toEqual([
      'context',
      'onResolve',
    ]);
  });

  test('schema accepts nested JSON argument previews', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(approvalCardSchema);

    expect(
      validate({
        tool: { name: 'deploy-cloud', risk: 'medium' },
        operation: {
          kind: 'other',
          argsPreview: {
            filters: {
              include: {
                branch: 'main',
              },
            },
          },
        },
        policyVersion: 'policy-2026-06',
        idempotencyKey: 'approval-card-test-key',
        state: 'pending',
      }),
    ).toBe(true);
    expect(validate.errors).toBeNull();
  });

  test('schema accepts nested array argument previews', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(approvalCardSchema);

    expect(
      validate({
        tool: { name: 'deploy-cloud', risk: 'medium' },
        operation: {
          kind: 'other',
          argsPreview: [['cmd', 'arg'], { nested: [['branch', 'main']] }],
        },
        policyVersion: 'policy-2026-06',
        idempotencyKey: 'approval-card-test-key',
        state: 'pending',
      }),
    ).toBe(true);
    expect(validate.errors).toBeNull();
  });

  test('schema rejects command approvals without command payloads', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(approvalCardSchema);

    expect(
      validate({
        tool: { name: 'deploy-cloud', risk: 'medium' },
        operation: {
          kind: 'command',
        },
        policyVersion: 'policy-2026-06',
        idempotencyKey: 'approval-card-test-key',
        state: 'pending',
      }),
    ).toBe(false);
  });

  test('schema rejects patch approvals without diff payloads', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(approvalCardSchema);

    expect(
      validate({
        tool: { name: 'deploy-cloud', risk: 'medium' },
        operation: {
          kind: 'patch',
        },
        policyVersion: 'policy-2026-06',
        idempotencyKey: 'approval-card-test-key',
        state: 'pending',
      }),
    ).toBe(false);
  });

  test('schema rejects file-write approvals without touched files', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(approvalCardSchema);
    const basePayload = {
      tool: { name: 'write-file', risk: 'high' },
      policyVersion: 'policy-2026-06',
      idempotencyKey: 'approval-card-test-key',
      state: 'pending',
    };

    expect(
      validate({
        ...basePayload,
        operation: {
          kind: 'file-write',
        },
      }),
    ).toBe(false);

    expect(
      validate({
        ...basePayload,
        operation: {
          kind: 'file-write',
          filesTouched: [],
        },
      }),
    ).toBe(false);

    expect(
      validate({
        ...basePayload,
        operation: {
          kind: 'file-write',
          filesTouched: ['src/new-file.ts'],
        },
      }),
    ).toBe(true);
    expect(validate.errors).toBeNull();
  });

  test('resolves already-expired approvals before timer state initializes', () => {
    const expirationTimestamp = Date.parse('2026-06-24T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(expirationTimestamp);

    expect(resolveEffectiveApprovalState('pending', expirationTimestamp, undefined)).toBe(
      'expired',
    );
    expect(isApprovalActionable('pending', expirationTimestamp, undefined)).toBe(false);
    expect(isApprovalActionable('pending', expirationTimestamp, expirationTimestamp - 1)).toBe(
      true,
    );
    expect(resolveEffectiveApprovalState('pending', expirationTimestamp, expirationTimestamp)).toBe(
      'expired',
    );
    expect(isApprovalActionable('pending', expirationTimestamp, expirationTimestamp)).toBe(false);
  });

  test('keeps unserializable argument previews visible without truncation metadata', () => {
    const circularPreview: Record<string, unknown> = { command: 'deploy' };
    circularPreview['self'] = circularPreview;

    const preview = prepareArgumentsPreview(circularPreview);
    expect(preview.value).toBe(circularPreview);
    expect(preview.truncated).toBe(false);
  });

  test('falls back to an empty editable JSON object for unserializable argument previews', () => {
    const circularPreview: Record<string, unknown> = { command: 'deploy' };
    circularPreview['self'] = circularPreview;

    expect(formatEditableArguments(circularPreview)).toBe('{}');
  });

  test('renders as an article without nested region landmarks', () => {
    const { getByRole, queryAllByRole } = render(ApprovalCard, { ...approvalCardProps() });

    expect(getByRole('article', { name: 'Approval required for deploy-cloud' })).toBeTruthy();
    expect(queryAllByRole('region')).toHaveLength(0);
  });

  test('renders pending approval details', () => {
    const { container, getByRole } = render(ApprovalCard, { ...approvalCardProps() });

    expect(container.textContent).toContain('deploy-cloud');
    expect(getByRole('img', { name: 'Medium risk' })).toBeTruthy();
    expect(getByRole('group', { name: 'Approval status' })).toBeTruthy();
    expect(getByRole('group', { name: 'Approval actions' })).toBeTruthy();
    expect(getByRole('button', { name: 'Approve' }).getAttribute('type')).toBe('button');
  });

  test('renders the risk level as a named, focusable signal image per risk level', () => {
    for (const risk of ['low', 'medium', 'high'] as const) {
      const { getByRole, unmount } = render(ApprovalCard, {
        ...approvalCardProps({ tool: { name: 'deploy-cloud', risk } }),
      });

      const expectedName =
        risk === 'low' ? 'Low risk' : risk === 'medium' ? 'Medium risk' : 'High risk';
      const icon = getByRole('img', { name: expectedName });
      expect(icon.getAttribute('tabindex')).toBe('0');
      expect(icon.getAttribute('data-cinder-risk')).toBe(risk);
      unmount();
    }
  });

  test('renders headings at the configured level', () => {
    const { container, unmount } = render(ApprovalCard, { ...approvalCardProps() });
    expect(container.querySelector('h3.cinder-approval-card__title')).not.toBeNull();
    expect(container.querySelector('h4.cinder-approval-card__section-title')).not.toBeNull();
    unmount();

    const { container: leveled } = render(ApprovalCard, {
      ...approvalCardProps({ headingLevel: 2 }),
    });
    expect(leveled.querySelector('h2.cinder-approval-card__title')).not.toBeNull();
    expect(leveled.querySelector('h3.cinder-approval-card__section-title')).not.toBeNull();
  });

  test('renders no action buttons when onResolve is absent', () => {
    const { onResolve: _onResolve, ...withoutResolve } = approvalCardProps();
    const { queryByRole } = render(ApprovalCard, withoutResolve);

    expect(queryByRole('group', { name: 'Approval actions' })).toBeNull();
    expect(queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(queryByRole('checkbox')).toBeNull();
  });

  test('renders no action buttons and does not throw when onResolve is a truthy non-function', () => {
    const { queryByRole } = render(ApprovalCard, {
      ...approvalCardProps({ onResolve: 'not-a-function' as unknown as () => void }),
    });

    expect(queryByRole('group', { name: 'Approval actions' })).toBeNull();
    expect(queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  test('orders actions with the primary decision last, matching the dialog convention', () => {
    const { getByRole } = render(ApprovalCard, {
      ...approvalCardProps({ editableArgs: true }),
    });

    const actionGroup = getByRole('group', { name: 'Approval actions' });
    const buttons = Array.from(actionGroup.querySelectorAll('button')).map((button) =>
      button.textContent?.trim(),
    );

    expect(buttons).toEqual(['Deny', 'Approve with edits', 'Approve']);
  });

  test('does not render a Remember action button', () => {
    const { queryByRole } = render(ApprovalCard, {
      ...approvalCardProps({ editableArgs: true }),
    });

    expect(queryByRole('button', { name: 'Remember' })).toBeNull();
  });

  test('emits a complete approval resolution when approving as presented', async () => {
    const onResolve = mock();

    const { getByRole } = render(ApprovalCard, {
      ...approvalCardProps({ editableArgs: false, onResolve }),
    });

    const rememberCheckbox = requiredInstance(
      getByRole('checkbox', {
        name: 'Allow deploy-cloud for the rest of this chat',
      }),
      HTMLInputElement,
    );

    await fireEvent.click(rememberCheckbox);
    await fireEvent.click(getByRole('button', { name: 'Approve' }));

    expect(onResolve).toHaveBeenCalledWith({
      decision: 'approve',
      remember: true,
    });
  });

  test('emits reason text and remember state when denying', async () => {
    const onResolve = mock();

    const { getByLabelText, getByRole } = render(ApprovalCard, {
      ...approvalCardProps({ editableArgs: false, onResolve }),
    });

    await fireEvent.input(getByLabelText('Note (optional)'), {
      target: { value: 'Outside the deployment window.' },
    });
    await fireEvent.click(
      getByRole('checkbox', { name: 'Allow deploy-cloud for the rest of this chat' }),
    );
    await fireEvent.click(getByRole('button', { name: 'Deny' }));

    expect(onResolve).toHaveBeenCalledWith({
      decision: 'deny',
      reason: 'Outside the deployment window.',
      remember: true,
    });
  });

  test('offers no Dismiss: Deny and Approve are the only decisions on screen', () => {
    const { queryByRole } = render(ApprovalCard, { ...approvalCardProps() });

    expect(queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  test('resets resolution reason and remember state when the approval request changes', async () => {
    const onResolve = mock();
    const view = render(ApprovalCard, {
      ...approvalCardProps({
        onResolve,
        idempotencyKey: 'approval-one',
      }),
    });

    await fireEvent.input(view.getByLabelText('Note (optional)'), {
      target: { value: 'Applies only to the first approval.' },
    });
    await fireEvent.click(
      view.getByRole('checkbox', { name: 'Allow deploy-cloud for the rest of this chat' }),
    );

    await view.rerender({
      ...approvalCardProps({
        onResolve,
        idempotencyKey: 'approval-two',
      }),
    });

    expect(
      requiredInstance(view.getByLabelText('Note (optional)'), HTMLTextAreaElement).value,
    ).toBe('');
    expect(
      requiredInstance(
        view.getByRole('checkbox', {
          name: 'Allow deploy-cloud for the rest of this chat',
        }),
        HTMLInputElement,
      ).checked,
    ).toBe(false);

    await fireEvent.click(view.getByRole('button', { name: 'Approve' }));
    expect(onResolve).toHaveBeenCalledWith({
      decision: 'approve',
      remember: false,
    });
  });

  test('preserves in-progress reason text and remember state across an unrelated host re-render', async () => {
    const onResolve = mock();
    const view = render(ApprovalCard, {
      ...approvalCardProps({ onResolve, idempotencyKey: 'approval-one' }),
    });

    await fireEvent.input(view.getByLabelText('Note (optional)'), {
      target: { value: 'Still drafting this reason.' },
    });
    await fireEvent.click(
      view.getByRole('checkbox', { name: 'Allow deploy-cloud for the rest of this chat' }),
    );

    // Same idempotencyKey — the host re-rendered for some unrelated reason
    // (e.g. a countdown tick elsewhere on the page), not because a new
    // approval request arrived. The draft must survive this.
    await view.rerender({
      ...approvalCardProps({ onResolve, idempotencyKey: 'approval-one', snapshotId: 'snap-2' }),
    });

    expect(
      requiredInstance(view.getByLabelText('Note (optional)'), HTMLTextAreaElement).value,
    ).toBe('Still drafting this reason.');
    expect(
      requiredInstance(
        view.getByRole('checkbox', {
          name: 'Allow deploy-cloud for the rest of this chat',
        }),
        HTMLInputElement,
      ).checked,
    ).toBe(true);
  });

  test('shows the arguments an approver signs off on as fields, with the exact JSON a click away', async () => {
    const { container, getByRole } = render(ApprovalCard, {
      ...approvalCardProps({
        operation: { kind: 'command', command: 'run', argsPreview: { count: 1, label: '1' } },
      }),
    });
    expect(container.querySelector('.cinder-json-viewer')).toBeNull();
    await fireEvent.click(getByRole('radio', { name: 'JSON' }));
    expect(container.querySelector('.cinder-json-viewer')).not.toBeNull();
    expect(container.textContent).toContain('"1"');
  });

  test('edits arguments as JSON before approving with edits', async () => {
    const onResolve = mock();
    const { getByLabelText, getByRole, queryByRole } = render(ApprovalCard, {
      ...approvalCardProps({
        editableArgs: true,
        onResolve,
        operation: {
          kind: 'other',
          argsPreview: { force: false },
        },
      }),
    });

    const editToggle = getByRole('button', { name: 'Approve with edits' });
    expect(editToggle.getAttribute('aria-expanded')).toBe('false');

    await fireEvent.click(editToggle);
    expect(editToggle.getAttribute('aria-expanded')).toBe('true');

    const textarea = requiredInstance(getByLabelText('Edited arguments JSON'), HTMLTextAreaElement);
    expect(textarea.value).toContain('"force": false');

    await fireEvent.input(textarea, { target: { value: '{ broken' } });
    const invalidConfirmButton = requiredInstance(
      getByRole('button', {
        name: 'Confirm edited approval',
      }),
      HTMLButtonElement,
    );
    expect(invalidConfirmButton.disabled).toBe(true);
    expect(getByRole('alert').textContent).toContain('valid JSON');

    await fireEvent.input(textarea, { target: { value: '{ "force": true }' } });
    expect(queryByRole('alert')).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Confirm edited approval' }));

    expect(onResolve).toHaveBeenCalledWith({
      decision: 'approve_with_edits',
      editedArgs: { force: true },
      remember: false,
    });
  });

  test('moves focus into the JSON editor when it opens', async () => {
    const { getByLabelText, getByRole } = render(ApprovalCard, {
      ...approvalCardProps({ editableArgs: true }),
    });

    await fireEvent.click(getByRole('button', { name: 'Approve with edits' }));
    await tick();

    expect(document.activeElement).toBe(getByLabelText('Edited arguments JSON'));
  });

  test('seeds editable arguments from serialized JSON previews', async () => {
    const onResolve = mock();
    const { getByLabelText, getByRole } = render(ApprovalCard, {
      ...approvalCardProps({
        editableArgs: true,
        onResolve,
        operation: {
          kind: 'other',
          argsPreview: '{"force":false,"files":["src/a.ts"]}',
        },
      }),
    });

    await fireEvent.click(getByRole('button', { name: 'Approve with edits' }));

    const textarea = requiredInstance(getByLabelText('Edited arguments JSON'), HTMLTextAreaElement);
    expect(textarea.value).toContain('"force": false');
    expect(textarea.value).toContain('"files"');

    await fireEvent.click(getByRole('button', { name: 'Confirm edited approval' }));
    expect(onResolve).toHaveBeenCalledWith({
      decision: 'approve_with_edits',
      editedArgs: { force: false, files: ['src/a.ts'] },
      remember: false,
    });
  });

  test('preserves null arguments when approving with edits without changes', async () => {
    const onResolve = mock();
    const { getByLabelText, getByRole } = render(ApprovalCard, {
      ...approvalCardProps({
        editableArgs: true,
        onResolve,
        operation: {
          kind: 'other',
          argsPreview: null,
        },
      }),
    });

    await fireEvent.click(getByRole('button', { name: 'Approve with edits' }));

    const textarea = requiredInstance(getByLabelText('Edited arguments JSON'), HTMLTextAreaElement);
    expect(textarea.value).toBe('null');

    await fireEvent.click(getByRole('button', { name: 'Confirm edited approval' }));

    expect(onResolve).toHaveBeenCalledWith({
      decision: 'approve_with_edits',
      editedArgs: null,
      remember: false,
    });
  });

  test('hides the edit panel and blocks the resolution when editableArgs is disabled after the editor was opened', async () => {
    const onResolve = mock();
    const view = render(ApprovalCard, {
      ...approvalCardProps({
        editableArgs: true,
        onResolve,
        operation: {
          kind: 'other',
          argsPreview: { force: false },
        },
      }),
    });

    await fireEvent.click(view.getByRole('button', { name: 'Approve with edits' }));
    expect(view.getByLabelText('Edited arguments JSON')).toBeTruthy();

    await view.rerender({
      ...approvalCardProps({
        editableArgs: false,
        onResolve,
        operation: {
          kind: 'other',
          argsPreview: { force: false },
        },
      }),
    });

    expect(view.queryByLabelText('Edited arguments JSON')).toBeNull();
    expect(view.queryByRole('button', { name: 'Confirm edited approval' })).toBeNull();
    expect(onResolve).not.toHaveBeenCalled();
  });

  test('does not offer edited approval when no preview is provided', () => {
    const { queryByRole } = render(ApprovalCard, {
      ...approvalCardProps({
        editableArgs: true,
        operation: {
          kind: 'other',
        },
      }),
    });

    expect(queryByRole('button', { name: 'Approve with edits' })).toBeNull();
  });

  test('reseeds editable arguments when the approval request changes', async () => {
    const onResolve = mock();
    const view = render(ApprovalCard, {
      ...approvalCardProps({
        editableArgs: true,
        onResolve,
        idempotencyKey: 'approval-one',
        operation: {
          kind: 'other',
          argsPreview: { force: false },
        },
      }),
    });

    await fireEvent.click(view.getByRole('button', { name: 'Approve with edits' }));
    const staleTextarea = requiredInstance(
      view.getByLabelText('Edited arguments JSON'),
      HTMLTextAreaElement,
    );
    await fireEvent.input(staleTextarea, { target: { value: '{ "force": true }' } });

    await view.rerender({
      ...approvalCardProps({
        editableArgs: true,
        onResolve,
        idempotencyKey: 'approval-two',
        operation: {
          kind: 'other',
          argsPreview: { force: false, region: 'iad' },
        },
      }),
    });

    expect(view.queryByLabelText('Edited arguments JSON')).toBeNull();

    await fireEvent.click(view.getByRole('button', { name: 'Approve with edits' }));
    const nextTextarea = requiredInstance(
      view.getByLabelText('Edited arguments JSON'),
      HTMLTextAreaElement,
    );
    expect(nextTextarea.value).toContain('"region": "iad"');
    expect(nextTextarea.value).not.toContain('"force": true');
  });

  test('closes the edit panel when argsPreview changes for the SAME approval request', async () => {
    const onResolve = mock();
    const view = render(ApprovalCard, {
      ...approvalCardProps({
        editableArgs: true,
        onResolve,
        idempotencyKey: 'approval-one',
        operation: {
          kind: 'other',
          argsPreview: { force: false },
        },
      }),
    });

    await fireEvent.click(view.getByRole('button', { name: 'Approve with edits' }));
    expect(view.getByLabelText('Edited arguments JSON')).toBeTruthy();

    // Same idempotencyKey — the host revised the live arguments (e.g. a
    // websocket update) while the editor was open, not a new request.
    await view.rerender({
      ...approvalCardProps({
        editableArgs: true,
        onResolve,
        idempotencyKey: 'approval-one',
        operation: {
          kind: 'other',
          argsPreview: { force: true },
        },
      }),
    });

    expect(view.queryByLabelText('Edited arguments JSON')).toBeNull();

    await fireEvent.click(view.getByRole('button', { name: 'Approve with edits' }));
    const reopenedTextarea = requiredInstance(
      view.getByLabelText('Edited arguments JSON'),
      HTMLTextAreaElement,
    );
    expect(reopenedTextarea.value).toContain('"force": true');
  });

  test('closes the edit panel when the request changes even if the new arguments serialize identically', async () => {
    const onResolve = mock();
    const view = render(ApprovalCard, {
      ...approvalCardProps({
        editableArgs: true,
        onResolve,
        idempotencyKey: 'approval-one',
        operation: {
          kind: 'other',
          argsPreview: { force: false },
        },
      }),
    });

    await fireEvent.click(view.getByRole('button', { name: 'Approve with edits' }));
    expect(view.getByLabelText('Edited arguments JSON')).toBeTruthy();

    // A genuinely NEW request (different idempotencyKey) whose arguments
    // happen to serialize to the exact same text as the previous request's.
    // The argumentsValue-snapshot comparison alone wouldn't see a change
    // here — the identity change itself must still close the editor.
    await view.rerender({
      ...approvalCardProps({
        editableArgs: true,
        onResolve,
        idempotencyKey: 'approval-two',
        operation: {
          kind: 'other',
          argsPreview: { force: false },
        },
      }),
    });

    expect(view.queryByLabelText('Edited arguments JSON')).toBeNull();
  });

  test('shows a string argsPreview quoted in the JSON view and copies the original, un-quoted value', async () => {
    const writeText = mock(async () => undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    try {
      const { container, getByRole } = render(ApprovalCard, {
        ...approvalCardProps({
          operation: {
            kind: 'other',
            argsPreview: '--force',
          },
        }),
      });

      await fireEvent.click(getByRole('radio', { name: 'JSON' }));
      const viewer = container.querySelector('.cinder-json-viewer');
      expect(viewer?.textContent).toContain('"--force"');

      const copyButton = getByRole('button', { name: 'Copy deploy-cloud arguments' });
      await fireEvent.click(copyButton);
      expect(writeText).toHaveBeenCalledWith('--force');
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  test('scopes the arguments copy button name to the tool, so multiple cards on one page stay unambiguous', () => {
    render(ApprovalCard, {
      ...approvalCardProps({ tool: { name: 'deploy-cloud', risk: 'medium' } }),
    });
    render(ApprovalCard, {
      ...approvalCardProps({ tool: { name: 'rotate-secret', risk: 'high' } }),
    });

    expect(
      document.body.querySelector('[aria-label="Copy deploy-cloud arguments"]'),
    ).not.toBeNull();
    expect(
      document.body.querySelector('[aria-label="Copy rotate-secret arguments"]'),
    ).not.toBeNull();
  });

  test('truncates large argument previews and renders every touched file', () => {
    const filesTouched = Array.from({ length: 8 }, (_, index) => `src/file-${index + 1}.ts`);
    const { container } = render(ApprovalCard, {
      ...approvalCardProps({
        operation: {
          kind: 'file-write',
          filesTouched,
          argsPreview: { payload: `start-${'x'.repeat(10_000)}` },
        },
      }),
    });

    expect(container.textContent).toContain('Truncated');
    expect(container.textContent).toContain('8 files');
    for (const file of filesTouched) {
      expect(container.textContent).toContain(file);
    }
  });

  test('collapses duplicate touched files into a single row', () => {
    const { container } = render(ApprovalCard, {
      ...approvalCardProps({
        operation: {
          kind: 'file-write',
          filesTouched: ['src/repeated.ts', 'src/repeated.ts'],
        },
      }),
    });

    expect(
      Array.from(container.querySelectorAll('.cinder-approval-card__file-path')).map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(['src/repeated.ts']);
    expect(container.textContent).toContain('1 file');
    expect(container.textContent).not.toContain('1 files');
  });

  test('renders a copy button for each touched file path', async () => {
    const writeText = mock(async () => undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    try {
      const { getByRole } = render(ApprovalCard, {
        ...approvalCardProps({
          operation: {
            kind: 'file-write',
            filesTouched: ['src/new-file.ts'],
          },
        }),
      });

      await fireEvent.click(getByRole('button', { name: 'Copy path src/new-file.ts' }));
      expect(writeText).toHaveBeenCalledWith('src/new-file.ts');
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  test('renders environment names as plain text without leaking supplied values', async () => {
    const { container, getByRole } = render(ApprovalCard, {
      ...approvalCardProps({
        env: ['DATABASE_URL=postgres://fake-secret-value', 'ANTHROPIC_API_KEY'],
      }),
    });

    await fireEvent.click(getByRole('button', { name: 'Details' }));

    expect(container.textContent).toContain('DATABASE_URL');
    expect(container.textContent).toContain('ANTHROPIC_API_KEY');
    expect(
      container
        .querySelector('.cinder-approval-card__environment-list')
        ?.getAttribute('aria-label'),
    ).toContain('values are never shown');
    expect(container.innerHTML).not.toContain('postgres://fake-secret-value');
    expect(container.querySelector('.cinder-secret-value-field')).toBeNull();
  });

  test('deduplicates sanitized environment names', async () => {
    const { container, getByRole } = render(ApprovalCard, {
      ...approvalCardProps({
        env: [
          'DATABASE_URL=postgres://fake-secret-value',
          'DATABASE_URL',
          'DATABASE_URL=postgres://other-fake-secret-value',
        ],
      }),
    });

    await fireEvent.click(getByRole('button', { name: 'Details' }));

    const items = Array.from(
      container.querySelectorAll('.cinder-approval-card__environment-list li'),
    );
    expect(items).toHaveLength(1);
    expect(container.innerHTML).not.toContain('postgres://fake-secret-value');
    expect(container.innerHTML).not.toContain('postgres://other-fake-secret-value');
  });

  test('renders commands with a CodeBlock and no language header chip', () => {
    const { container } = render(ApprovalCard, {
      ...approvalCardProps({
        operation: {
          kind: 'command',
          command: 'bun run components:check',
          argsPreview: { package: '@lostgradient/cinder' },
        },
      }),
    });

    const codeBlock = container.querySelector<HTMLElement>('.cinder-code-block');
    expect(codeBlock).not.toBeNull();
    expect(codeBlock?.querySelector('.cinder-code-block__language')).toBeNull();
    expect(container.querySelector('.cinder-code-block__code')?.textContent).toContain(
      'bun run components:check',
    );
  });

  test('renders patch operations as unified diff code', () => {
    const { container } = render(ApprovalCard, {
      ...approvalCardProps({
        operation: {
          kind: 'patch',
          filesTouched: ['src/approval.ts'],
          diff: 'diff --git a/src/approval.ts b/src/approval.ts\n+export const approved = true;',
          argsPreview: { mode: 'patch' },
        },
      }),
    });

    const codeBlock = container.querySelector<HTMLElement>('.cinder-code-block');
    expect(codeBlock).not.toBeNull();
    expect(codeBlock?.querySelector('.cinder-code-block__language')).toBeNull();
    expect(container.textContent).toContain('diff --git a/src/approval.ts b/src/approval.ts');
    expect(container.textContent).toContain('export const approved = true;');
  });

  test('renders the command unhighlighted when no ancestor publishes a highlighter', async () => {
    const { container } = render(ApprovalCard, { ...approvalCardProps() });
    await tick();
    await Promise.resolve();

    expect(container.querySelector('.cinder-code-block__highlighted')).toBeNull();
    expect(container.querySelector('.cinder-code-block__code')?.textContent).toBe(
      'bun run --filter=@lostgradient/cinder test',
    );
  });

  test('highlights the command as shell and the patch as diff through the context highlighter', async () => {
    const highlighter = mock(
      (code: string, language: string) =>
        `<pre class="shiki context-highlighted" data-language="${language}"><code>${code}</code></pre>`,
    );

    const command = render(CodeHighlighterContextFixture, {
      highlighter,
      component: ApprovalCard,
      childProps: approvalCardProps(),
    });
    await waitFor(() => {
      expect(
        command.container.querySelector('.cinder-code-block__highlighted .context-highlighted'),
      ).not.toBeNull();
    });
    expect(highlighter).toHaveBeenCalledWith('bun run --filter=@lostgradient/cinder test', 'shell');
    command.unmount();

    const diff = 'diff --git a/src/approval.ts b/src/approval.ts\n+export const approved = true;';
    const patch = render(CodeHighlighterContextFixture, {
      highlighter,
      component: ApprovalCard,
      childProps: approvalCardProps({
        operation: { kind: 'patch', filesTouched: ['src/approval.ts'], diff, argsPreview: {} },
      }),
    });
    await waitFor(() => {
      expect(
        patch.container.querySelector('.cinder-code-block__highlighted [data-language="diff"]'),
      ).not.toBeNull();
    });
    expect(highlighter).toHaveBeenCalledWith(diff, 'diff');
  });

  test('collapses sandbox, environment, and request metadata into one Details disclosure', async () => {
    const { container, getByRole } = render(ApprovalCard, { ...approvalCardProps() });

    const trigger = getByRole('button', { name: 'Details' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('/workspace/project');
    expect(container.textContent).not.toContain('DATABASE_URL');
    expect(container.textContent).not.toContain('policy-2026-06');

    await fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('/workspace/project');
    expect(container.textContent).toContain('workspace-write');
    expect(container.textContent).toContain('DATABASE_URL');
    expect(container.textContent).toContain('policy-2026-06');
    expect(container.textContent).toContain('approval-card-test-key');
    expect(container.textContent).toContain('snapshot-123');
  });

  test('transitions pending approvals to an expired read-only state without firing callbacks', async () => {
    const now = new Date('2026-06-24T12:00:00.000Z');
    jest.useFakeTimers({ now });

    const onResolve = mock();
    const { getByRole, getByText, queryByRole } = render(ApprovalCard, {
      ...approvalCardProps({
        expiresAt: new Date(now.getTime() + 1_000).toISOString(),
        onResolve,
      }),
    });

    await tick();
    expect(getByText('Expires in 1s')).toBeTruthy();

    jest.advanceTimersByTime(1_000);
    await tick();

    expect(getByText(EXPIRED_NOTICE)).toBeTruthy();
    expect(getByRole('img', { name: 'Expired' })).toBeTruthy();
    expect(queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(onResolve).not.toHaveBeenCalled();
  });

  test('blocks resolutions at the exact expiration deadline', async () => {
    const now = new Date('2026-06-24T12:00:00.000Z');
    jest.useFakeTimers({ now });
    const onResolve = mock();

    const { getByRole, queryByRole } = render(ApprovalCard, {
      ...approvalCardProps({
        expiresAt: new Date(now.getTime() + 250).toISOString(),
        onResolve,
      }),
    });

    await tick();
    const approveButton = getByRole('button', { name: 'Approve' });

    jest.advanceTimersByTime(250);
    await fireEvent.click(approveButton);

    expect(onResolve).not.toHaveBeenCalled();

    await tick();
    expect(queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  test('syncs the visible expired state when an overdue action is attempted before the timer fires', async () => {
    const now = new Date('2026-06-24T12:00:00.000Z').getTime();
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(now);
    const onResolve = mock();

    const { getByRole, getByText, queryByRole } = render(ApprovalCard, {
      ...approvalCardProps({
        expiresAt: new Date(now + 60_000).toISOString(),
        onResolve,
      }),
    });

    await tick();
    const approveButton = getByRole('button', { name: 'Approve' });

    dateNow.mockReturnValue(now + 60_001);
    await fireEvent.click(approveButton);
    await tick();

    expect(onResolve).not.toHaveBeenCalled();
    expect(getByText(EXPIRED_NOTICE)).toBeTruthy();
    expect(queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  test('renders past expiration as expired after mount without action buttons', async () => {
    const now = new Date('2026-06-24T12:00:00.000Z');
    jest.useFakeTimers({ now });

    const { getByRole, getByText, queryByRole } = render(ApprovalCard, {
      ...approvalCardProps({
        expiresAt: new Date(now.getTime() - 1_000).toISOString(),
      }),
    });

    await tick();

    expect(getByText(EXPIRED_NOTICE)).toBeTruthy();
    expect(getByRole('img', { name: 'Expired' })).toBeTruthy();
    expect(queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  test('treats invalid expiration timestamps as no expiration', async () => {
    const onResolve = mock();

    const { getByRole, queryByText } = render(ApprovalCard, {
      ...approvalCardProps({
        expiresAt: 'not-an-iso-date',
        onResolve,
      }),
    });

    await tick();

    expect(
      queryByText('No approval actions are available because this request is expired.'),
    ).toBeNull();
    expect(getByRole('article').getAttribute('data-cinder-state')).toBe('pending');

    await fireEvent.click(getByRole('button', { name: 'Approve' }));

    expect(onResolve).toHaveBeenCalledWith({ decision: 'approve', remember: false });
  });

  test('renders already-expired approvals read-only on the initial render', () => {
    const now = new Date('2026-06-24T12:00:00.000Z');
    jest.useFakeTimers({ now });

    const { getByRole, getByText, queryByRole } = render(ApprovalCard, {
      ...approvalCardProps({
        expiresAt: new Date(now.getTime() - 1_000).toISOString(),
      }),
    });

    expect(getByText(EXPIRED_NOTICE)).toBeTruthy();
    expect(getByRole('img', { name: 'Expired' })).toBeTruthy();
    expect(queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  test('cleans up countdown timers on destroy', async () => {
    const now = new Date('2026-06-24T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    const timers = trackTimers();

    try {
      const { unmount } = render(ApprovalCard, {
        ...approvalCardProps({
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        }),
      });
      await tick();

      expect(timers.active().size).toBeGreaterThan(0);
      unmount();
      expectNoLeakedTimers(timers.active());
    } finally {
      timers.release();
    }
  });

  test('renders read-only summaries without action buttons for terminal states', () => {
    for (const state of [
      'approved',
      'approved_with_edits',
      'denied',
      'expired',
      'cancelled',
    ] as const) {
      const { container, getByText, queryByRole, unmount } = render(ApprovalCard, {
        ...approvalCardProps({ state }),
      });

      expect(
        getByText(
          `No approval actions are available because this request is ${state.replaceAll('_', ' ')}.`,
        ),
      ).toBeTruthy();
      expect(
        container
          .querySelector('.cinder-approval-card__readonly-summary')
          ?.getAttribute('data-cinder-state'),
      ).toBe(state);
      expect(queryByRole('group', { name: 'Approval actions' })).toBeNull();
      unmount();
    }
  });
});

type RowOverrides = { [Key in keyof ApprovalCardProps]?: ApprovalCardProps[Key] | undefined };

/** The refund approval of the sample world as a row; an override of `undefined` removes the prop. */
function refundRow(overrides: RowOverrides = {}): ApprovalCardProps {
  const merged: RowOverrides = {
    ...approvalCardProps({
      layout: 'row',
      question: 'Refund order 4471 for $42.00?',
      tool: { name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true },
      operation: {
        kind: 'other',
        argsPreview: { orderId: 4471, amount: '$42.00', reason: 'Arrived damaged' },
      },
      source: 'Tool runner',
      requestedAt: '2026-11-02T10:38:00.000Z',
      now: new Date('2026-11-02T10:42:00.000Z'),
      consequence: 'Sends $42.00 back to the original card',
    }),
    rememberScope: undefined,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as ApprovalCardProps;
}

function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

describe('ApprovalCard card layout anatomy', () => {
  test('stacks who asked, the question, the tool and the risk line on a neutral header', () => {
    const { container } = render(ApprovalCard, {
      props: refundRow({ layout: 'card', onResolve: undefined }),
    });

    expect(squash(container.querySelector('.cinder-approval-card__eyebrow')?.textContent)).toBe(
      'Approval from Tool runner · 4 min ago',
    );
    expect(container.querySelector('.cinder-approval-card__title')?.textContent?.trim()).toBe(
      'Refund order 4471 for $42.00?',
    );
    expect(squash(container.querySelector('.cinder-approval-card__tool-line')?.textContent)).toBe(
      'Issue refund issue-refund',
    );
    expect(squash(container.querySelector('.cinder-approval-card__risk-line')?.textContent)).toBe(
      "Dangerous · Can't be undone",
    );
    expect(container.querySelector('.cinder-approval-card__consequence')?.textContent).toBe(
      'Sends $42.00 back to the original card',
    );
  });

  test('offers Deny as secondary, a Note (optional) field and no Allow checkbox for an Always tool', () => {
    const { getByRole, getByLabelText, queryByRole } = render(ApprovalCard, {
      props: refundRow({ layout: 'card', rememberScope: undefined }),
    });

    expect(getByRole('button', { name: 'Deny' }).getAttribute('data-cinder-variant')).toBe(
      'secondary',
    );
    expect(getByLabelText('Note (optional)')).not.toBeNull();
    expect(queryByRole('checkbox')).toBeNull();
  });

  test('never fills the header with a warning or danger colour', () => {
    const css = readFileSync(new URL('./approval-card.css', import.meta.url), 'utf8');

    expect(css).not.toMatch(/\[data-cinder-risk='high'\] \.cinder-approval-card__header/);
    expect(css).not.toMatch(/readonly-summary\[data-cinder-state='denied'\]/);
    // Only the inline failure message is red-toned; no surface or header ever is.
    expect(css.replace(/\.cinder-approval-card__failure \{[^}]*\}/, '')).not.toContain(
      '--cinder-status-danger',
    );
  });

  test('shows an unavailable card read-only with its reason', () => {
    const { container, queryByRole } = render(ApprovalCard, {
      props: refundRow({
        layout: 'card',
        state: 'unavailable',
        unavailableReason: 'Release helper is unavailable.',
      }),
    });

    expect(container.textContent).toContain('Release helper is unavailable.');
    expect(queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});

describe('ApprovalCard row layout', () => {
  test('mounts when two argument keys humanize to the same label', () => {
    const { container } = render(ApprovalCard, {
      props: refundRow({
        operation: { kind: 'other', argsPreview: { orderId: 4471, order_id: 4472 } },
      }),
    });

    const labels = [...container.querySelectorAll('.cinder-approval-card__pair-label')];
    expect(labels.map((label) => label.textContent)).toEqual(['Order ID', 'Order ID']);
    expect(squash(container.querySelector('.cinder-approval-card__input-pairs')?.textContent)).toBe(
      'Order ID 4471 · Order ID 4472',
    );
  });

  test('renders the shared approval row: glyph, question, line, consequence, Input, note, Deny and Approve', () => {
    const { container, getByRole } = render(ApprovalCard, { props: refundRow() });

    const article = getByRole('article', { name: 'Refund order 4471 for $42.00?' });
    expect(article.getAttribute('data-cinder-layout')).toBe('row');
    expect(getByRole('img', { name: 'High risk' })).not.toBeNull();
    expect(squash(container.querySelector('.cinder-approval-card__line')?.textContent)).toBe(
      "Issue refund issue-refund · Dangerous · Can't be undone · Approval from Tool runner · 4 min ago",
    );
    expect(container.querySelector('.cinder-approval-card__consequence')?.textContent).toBe(
      'Sends $42.00 back to the original card',
    );
    expect(
      squash(container.querySelector('.cinder-approval-card__input-toggle')?.textContent),
    ).toBe('Input Order ID 4471 · Amount $42.00 · Reason Arrived damaged');
    expect(getByRole('button', { name: 'Add a note' })).not.toBeNull();
    expect(container.querySelector('.cinder-approval-card__details')).toBeNull();
  });

  test("writes the identifier small and monospaced and keeps Can't be undone from breaking", () => {
    const { container } = render(ApprovalCard, { props: refundRow() });

    const identifier = container.querySelector('code.cinder-approval-card__tool-identifier');
    expect(identifier?.textContent).toBe('issue-refund');
    expect(container.querySelector('.cinder-approval-card__undone')?.textContent).toBe(
      "Can't be undone",
    );
    expect(container.querySelector('.cinder-approval-card__tool-label')?.textContent).toBe(
      'Issue refund',
    );
  });

  test('leaves out the tool label and the irreversible phrase when they are not given', () => {
    const { container } = render(ApprovalCard, {
      props: refundRow({
        tool: { name: 'issue-refund', risk: 'high' },
        source: 'the agent',
        requestedAt: '2026-11-02T10:40:00.000Z',
      }),
    });

    expect(squash(container.querySelector('.cinder-approval-card__line')?.textContent)).toBe(
      'issue-refund · Dangerous · Approval from the agent · 2 min ago',
    );
    expect(container.querySelector('.cinder-approval-card__undone')).toBeNull();
    expect(container.querySelector('.cinder-approval-card__tool-label')).toBeNull();
  });

  test.each([
    ['low', 'Reads'],
    ['medium', 'Changes things'],
    ['high', 'Dangerous'],
  ] as const)('reads %s risk as the muted word %s', (risk, word) => {
    const { container } = render(ApprovalCard, {
      props: refundRow({ tool: { name: 'issue-refund', risk } }),
    });

    expect(container.querySelector('.cinder-approval-card__risk-word')?.textContent).toBe(word);
    expect(container.querySelector('.cinder-approval-card')?.getAttribute('data-cinder-risk')).toBe(
      risk,
    );
  });

  test('defaults the question to the tool name', () => {
    const { getByRole } = render(ApprovalCard, { props: approvalCardProps({ layout: 'row' }) });

    expect(getByRole('article', { name: 'Run deploy-cloud?' })).not.toBeNull();
  });

  test('Deny is secondary and Approve is the only primary action', () => {
    const { getByRole, container } = render(ApprovalCard, { props: refundRow() });

    expect(getByRole('button', { name: 'Deny' }).getAttribute('data-cinder-variant')).toBe(
      'secondary',
    );
    expect(getByRole('button', { name: 'Approve' }).getAttribute('data-cinder-variant')).toBe(
      'primary',
    );
    expect(container.querySelectorAll('[data-cinder-variant="primary"]')).toHaveLength(1);
  });

  test('approve and deny forward resolutions without a note', async () => {
    const onResolve = mock((_resolution: unknown) => undefined);
    const { getByRole } = render(ApprovalCard, { props: refundRow({ onResolve }) });

    await fireEvent.click(getByRole('button', { name: 'Deny' }));
    await fireEvent.click(getByRole('button', { name: 'Approve' }));

    expect(onResolve.mock.calls).toEqual([
      [{ decision: 'deny', remember: false }],
      [{ decision: 'approve', remember: false }],
    ]);
  });

  test('Input discloses the operation and the arguments as the Fields view', async () => {
    const { container, getByRole } = render(ApprovalCard, {
      props: refundRow({
        operation: {
          kind: 'command',
          command: 'bun run refund',
          argsPreview: { orderId: 4471, amount: '$42.00' },
        },
      }),
    });
    const toggle = getByRole('button', { name: /^Input/ });
    const region = requiredInstance(
      container.querySelector('.cinder-approval-card__row-input'),
      HTMLElement,
    );

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(region.hidden).toBe(true);
    expect(toggle.getAttribute('aria-controls')).toBe(region.id);

    await fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(region.hidden).toBe(false);
    expect(region.textContent).toContain('bun run refund');
    const inspector = requiredInstance(
      region.querySelector('.cinder-payload-inspector'),
      HTMLElement,
    );
    expect(inspector.getAttribute('aria-label')).toBe('Input');
    expect(region.querySelector('.cinder-json-viewer')).toBeNull();
  });

  test('Input lists touched files and is absent when there is nothing to show', async () => {
    const withFiles = render(ApprovalCard, {
      props: refundRow({ operation: { kind: 'file-write', filesTouched: ['notes/plan.md'] } }),
    });
    await fireEvent.click(withFiles.getByRole('button', { name: /^Input/ }));
    expect(withFiles.container.textContent).toContain('notes/plan.md');
    cleanup();

    const empty = render(ApprovalCard, { props: refundRow({ operation: { kind: 'other' } }) });
    expect(empty.queryByRole('button', { name: /^Input/ })).toBeNull();
    expect(empty.getByRole('button', { name: 'Approve' })).not.toBeNull();
  });

  test('shows no Allow checkbox unless the tool offers one', () => {
    const { queryByRole } = render(ApprovalCard, { props: refundRow() });

    expect(queryByRole('checkbox')).toBeNull();
  });

  test('offers Allow for the rest of this chat on its own line and sends it with Approve', async () => {
    const onResolve = mock((_resolution: unknown) => undefined);
    const { container, getByRole } = render(ApprovalCard, {
      props: refundRow({
        tool: { name: 'triage-refunds', label: 'Triage refunds', risk: 'medium' },
        rememberScope: 'the rest of this chat',
        onResolve,
      }),
    });

    const checkbox = getByRole('checkbox', {
      name: 'Allow Triage refunds for the rest of this chat',
    });
    expect(checkbox.closest('.cinder-approval-card__remember')).not.toBeNull();
    expect(
      container
        .querySelector('.cinder-approval-card__remember')
        ?.contains(getByRole('button', { name: 'Approve' })),
    ).toBe(false);

    await fireEvent.click(checkbox);
    await fireEvent.click(getByRole('button', { name: 'Approve' }));

    expect(onResolve).toHaveBeenCalledWith({ decision: 'approve', remember: true });
  });

  test('Add a note opens the Note (optional) field, and the note travels with Approve and Deny', async () => {
    const onResolve = mock((_resolution: unknown) => undefined);
    const { getByLabelText, getByRole, getByText, queryByLabelText } = render(ApprovalCard, {
      props: refundRow({ onResolve }),
    });
    expect(queryByLabelText('Note (optional)')).toBeNull();

    await fireEvent.click(getByRole('button', { name: 'Add a note' }));

    const field = requiredInstance(getByLabelText('Note (optional)'), HTMLTextAreaElement);
    expect(field.placeholder).toBe('Add a note for the agent or the record');
    expect(
      getByText('Saved with your decision. If you deny, the agent reads it as the reason.'),
    ).not.toBeNull();

    await fireEvent.input(field, { target: { value: '  Check the carrier first.  ' } });
    await fireEvent.click(getByRole('button', { name: 'Deny' }));
    await fireEvent.click(getByRole('button', { name: 'Approve' }));

    expect(onResolve.mock.calls).toEqual([
      [{ decision: 'deny', reason: 'Check the carrier first.', remember: false }],
      [{ decision: 'approve', reason: 'Check the carrier first.', remember: false }],
    ]);
  });

  test('resets the note and the checkbox when the request changes, and keeps them across a re-render', async () => {
    const onResolve = mock((_resolution: unknown) => undefined);
    const props = refundRow({
      rememberScope: 'the rest of this chat',
      tool: { name: 'triage-refunds', label: 'Triage refunds', risk: 'medium' },
      onResolve,
      idempotencyKey: 'one',
    });
    const view = render(ApprovalCard, { props });
    await fireEvent.click(view.getByRole('button', { name: 'Add a note' }));
    await fireEvent.input(view.getByLabelText('Note (optional)'), {
      target: { value: 'Draft for the first.' },
    });
    await fireEvent.click(view.getByRole('checkbox'));

    await view.rerender({ ...props, consequence: 'Sends it back' });
    expect(
      requiredInstance(view.getByLabelText('Note (optional)'), HTMLTextAreaElement).value,
    ).toBe('Draft for the first.');

    await view.rerender({ ...props, idempotencyKey: 'two' });
    expect(view.queryByLabelText('Note (optional)')).toBeNull();
    expect(requiredInstance(view.getByRole('checkbox'), HTMLInputElement).checked).toBe(false);
  });

  test('holds Deny and Approve while the reason is given, with aria-disabled, and names it on both', async () => {
    const onResolve = mock((_resolution: unknown) => undefined);
    const { getByRole, getByText } = render(ApprovalCard, {
      props: refundRow({
        onResolve,
        disabledReason: 'Approving is off until Interborough is reachable',
      }),
    });

    const reason = getByText('Approving is off until Interborough is reachable');
    for (const name of ['Deny', 'Approve']) {
      const button = requiredInstance(getByRole('button', { name }), HTMLButtonElement);
      // Off with aria-disabled, never the disabled property, so the control stays focusable and
      // the reason is read when it is focused.
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.getAttribute('aria-describedby')).toBe(reason.id);
      button.focus();
      expect(document.activeElement).toBe(button);
      await fireEvent.click(button);
    }
    expect(onResolve).not.toHaveBeenCalled();
    expect(getByRole('button', { name: 'Add a note' })).not.toBeNull();
    expect(getByRole('button', { name: /^Input/ })).not.toBeNull();
  });

  test('an unavailable approval shows the neutral word, its input and the reason, with no decision buttons', () => {
    const { container, queryByRole, getByText } = render(ApprovalCard, {
      props: refundRow({
        question: 'Publish notes for 2.4?',
        tool: { name: 'publish-notes', label: 'Publish notes', risk: 'medium' },
        operation: { kind: 'other', argsPreview: { version: '2.4', changes: 12 } },
        source: 'Release helper',
        requestedAt: '2026-11-02T10:30:00.000Z',
        consequence: undefined,
        state: 'unavailable',
        unavailableReason:
          "Release helper is unavailable, so this can't be answered now. It returns when the Demo plugin is enabled.",
      }),
    });

    expect(container.querySelector('.cinder-approval-card__state-word')?.textContent?.trim()).toBe(
      'Unavailable',
    );
    expect(squash(container.querySelector('.cinder-approval-card__line')?.textContent)).toBe(
      'Publish notes publish-notes · Changes things · Approval from Release helper · 12 min ago',
    );
    expect(
      squash(container.querySelector('.cinder-approval-card__input-summary')?.textContent),
    ).toBe('Version 2.4 · Changes 12');
    expect(
      getByText(
        "Release helper is unavailable, so this can't be answered now. It returns when the Demo plugin is enabled.",
      ),
    ).not.toBeNull();
    expect(queryByRole('button')).toBeNull();
    expect(
      container.querySelector('.cinder-approval-card')?.getAttribute('data-cinder-state'),
    ).toBe('unavailable');
  });

  test('a denied approval stays as a neutral decision with who and when', () => {
    const { container, queryByRole } = render(ApprovalCard, {
      props: refundRow({
        question: 'Refund order 4398 for $27.25?',
        state: 'denied',
        requestedAt: undefined,
        decidedBy: 'you',
        decidedAt: '2026-11-02T10:40:00.000Z',
      }),
    });

    expect(squash(container.querySelector('.cinder-approval-card__outcome')?.textContent)).toBe(
      'Denied by you · 10:40 AM',
    );
    expect(queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(queryByRole('button', { name: /^Input/ })).toBeNull();
    expect(container.querySelector('.cinder-status-dot')).toBeNull();
    expect(container.querySelector('.cinder-approval-card__consequence')).toBeNull();
  });

  test('a decided approval without a time reads only what was decided', () => {
    const { container } = render(ApprovalCard, {
      props: refundRow({ state: 'approved', decidedAt: undefined }),
    });

    expect(squash(container.querySelector('.cinder-approval-card__outcome')?.textContent)).toBe(
      'Approved',
    );
  });

  test('a pending row nobody can answer shows its state word instead of buttons', () => {
    const { container, queryByRole } = render(ApprovalCard, {
      props: refundRow({ onResolve: undefined }),
    });

    expect(container.querySelector('.cinder-approval-card__state-word')?.textContent?.trim()).toBe(
      'Pending',
    );
    expect(queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(queryByRole('button', { name: 'Add a note' })).toBeNull();
  });

  test('writes the time the approval was asked as a time element and drops it once decided', () => {
    const pending = render(ApprovalCard, { props: refundRow() });
    expect(pending.container.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-11-02T10:38:00.000Z',
    );
    cleanup();

    const decided = render(ApprovalCard, { props: refundRow({ state: 'denied' }) });
    expect(
      decided.container.querySelector('.cinder-approval-card__line')?.textContent,
    ).not.toContain('min ago');
  });
});

describe('ApprovalCard detail consequence and Done record', () => {
  test("sets Can't be undone. in semibold in the consequence line", () => {
    const css = readFileSync(new URL('./approval-card.css', import.meta.url), 'utf8');
    expect(css).toMatch(
      /\.cinder-approval-card__detail-risk \.cinder-approval-card__undone \{[^}]*font-weight: var\(--cinder-font-semibold\)/s,
    );
  });

  test('the Done detail is the eyebrow, the question, the outcome, the input and the result', () => {
    const { container } = render(ApprovalCard, {
      props: refundRow({
        layout: 'detail',
        source: 'Tool runner',
        sourceIn: 'Please refund order 4471, it arrived damaged.',
        rememberScope: undefined,
        state: 'approved',
        decidedBy: 'you',
        decidedAt: '2026-11-02T10:33:00.000Z',
        now: new Date('2026-11-02T12:00:00.000Z'),
        result: 'Refunded $18.50 to the original card.',
      }),
    });

    expect(container.querySelector('.cinder-approval-card__detail-tool')).toBeNull();
    expect(container.querySelector('.cinder-approval-card__detail-risk')).toBeNull();
    expect(container.textContent).not.toContain("Can't be undone");
    expect(container.querySelector('.cinder-approval-card__detail-eyebrow')).not.toBeNull();
    expect(container.querySelector('.cinder-payload-inspector')).not.toBeNull();
    expect(squash(container.querySelector('.cinder-approval-card__result')?.textContent)).toBe(
      'Result: Refunded $18.50 to the original card.',
    );
  });

  test('an open or failed detail still carries the tool line and the consequence', () => {
    const { container } = render(ApprovalCard, {
      props: refundRow({
        layout: 'detail',
        onResolve: mock(),
        failure: { summary: "Couldn't deny.", detail: "Interborough couldn't reach the agent." },
      }),
    });

    expect(container.querySelector('.cinder-approval-card__detail-tool')).not.toBeNull();
    expect(container.querySelector('.cinder-approval-card__detail-risk')).not.toBeNull();
  });
});

describe('ApprovalCard answers in flight, failed and read-only', () => {
  const approveFailure = {
    summary: "Couldn't approve.",
    detail: "Interborough couldn't reach the agent. Nothing was refunded.",
  };

  describe('a row decided on another page while it was shown waiting (Chat frame r)', () => {
    test('collapses to a check, the question and the decision, with no tool line, no Input and no dot', () => {
      const { container } = render(ApprovalCard, {
        props: refundRow({
          state: 'approved',
          decidedBy: 'you',
          decidedIn: 'Reviews',
          decidedAt: '2026-11-02T10:46:00.000Z',
        }),
      });
      const article = container.querySelector('.cinder-approval-card--row');
      expect(squash(article?.textContent)).toBe(
        'Refund order 4471 for $42.00? Approved by you in Reviews · 10:46 AM',
      );
      expect(container.querySelector('.cinder-approval-card__line')).toBeNull();
      expect(container.querySelector('.cinder-approval-card__decided-input')).toBeNull();
      expect(container.querySelector('.cinder-approval-card__outcome-dot')).toBeNull();
      expect(container.querySelector('.cinder-approval-card__risk-icon')).toBeNull();
      const glyph = container.querySelector('.cinder-approval-card__decided-glyph');
      expect(glyph?.getAttribute('data-cinder-tone')).toBe('success');
      expect(glyph?.querySelector('svg')?.classList.contains('lucide-check')).toBe(true);
    });

    test('a denial collapses the same way, with the prohibition glyph in neutral', () => {
      const { container } = render(ApprovalCard, {
        props: refundRow({
          state: 'denied',
          decidedBy: 'you',
          decidedIn: 'Reviews',
          decidedAt: '2026-11-02T10:46:00.000Z',
        }),
      });
      expect(squash(container.querySelector('.cinder-approval-card--row')?.textContent)).toBe(
        'Refund order 4471 for $42.00? Denied by you in Reviews · 10:46 AM',
      );
      const glyph = container.querySelector('.cinder-approval-card__decided-glyph');
      expect(glyph?.getAttribute('data-cinder-tone')).toBe('neutral');
      expect(glyph?.querySelector('svg')?.classList.contains('lucide-ban')).toBe(true);
    });

    test('a row decided here keeps its tool line, its Input summary and the dot', () => {
      const { container } = render(ApprovalCard, {
        props: refundRow({
          state: 'approved',
          decidedBy: 'you',
          decidedAt: '2026-11-02T10:33:00.000Z',
        }),
      });
      expect(container.querySelector('.cinder-approval-card__line')).not.toBeNull();
      expect(container.querySelector('.cinder-approval-card__decided-input')).not.toBeNull();
      expect(container.querySelector('.cinder-approval-card__outcome-dot')).not.toBeNull();
      expect(container.querySelector('.cinder-approval-card__decided-glyph')).toBeNull();
    });
  });

  for (const layout of ['row', 'card', 'detail'] as const) {
    describe(`${layout} layout`, () => {
      test('Approve in flight writes Approving… with a spinner and turns both buttons off', async () => {
        const onResolve = mock();
        const { getByRole, queryByRole, container } = render(ApprovalCard, {
          props: refundRow({ layout, resolving: 'approve', onResolve }),
        });

        const approve = getByRole('button', { name: 'Approving…' });
        expect(approve.getAttribute('data-cinder-loading')).not.toBeNull();
        expect(approve.getAttribute('aria-busy')).toBe('true');
        expect(approve.getAttribute('aria-disabled')).toBe('true');
        expect(queryByRole('button', { name: 'Approve' })).toBeNull();
        expect((getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true);
        expect(
          [...container.querySelectorAll('[data-cinder-button-status]')]
            .map((node) => node.textContent)
            .join(''),
        ).toBe('Approving…');

        await fireEvent.click(approve);
        await fireEvent.click(getByRole('button', { name: 'Deny' }));
        expect(onResolve).not.toHaveBeenCalled();
        // The approval is still waiting on the answer.
        expect(getByRole('article').getAttribute('data-cinder-state')).toBe('pending');
      });

      test('Deny in flight writes Denying… and turns Approve off', async () => {
        const onResolve = mock();
        const { getByRole } = render(ApprovalCard, {
          props: refundRow({ layout, resolving: 'deny', onResolve }),
        });

        expect(getByRole('button', { name: 'Denying…' }).getAttribute('aria-busy')).toBe('true');
        expect((getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
        await fireEvent.click(getByRole('button', { name: 'Approve' }));
        expect(onResolve).not.toHaveBeenCalled();
      });

      test('the note and the checkbox stop taking changes while an answer is in flight', () => {
        const { container, getByRole } = render(ApprovalCard, {
          props: refundRow({
            layout,
            resolving: 'approve',
            rememberScope: 'the rest of this chat',
          }),
        });

        expect(getByRole('checkbox') as HTMLInputElement).toHaveProperty('disabled', true);
        const note = container.querySelector('textarea');
        if (note !== null) expect(note.disabled).toBe(true);
        else
          expect((getByRole('button', { name: 'Add a note' }) as HTMLButtonElement).disabled).toBe(
            true,
          );
      });

      test('a failed answer shows a red-toned alert below the input and leaves Approve live as the retry', async () => {
        const onResolve = mock();
        const { getByRole, queryByRole } = render(ApprovalCard, {
          props: refundRow({ layout, failure: approveFailure, onResolve }),
        });

        const alert = getByRole('alert');
        expect(squash(alert.textContent)).toBe(
          "Couldn't approve. Interborough couldn't reach the agent. Nothing was refunded.",
        );
        expect(alert.querySelector('strong')?.textContent).toBe("Couldn't approve.");
        expect(queryByRole('button', { name: /try again/i })).toBeNull();
        expect(getByRole('article').getAttribute('data-cinder-state')).toBe('pending');

        await fireEvent.click(getByRole('button', { name: 'Approve' }));
        expect(onResolve).toHaveBeenCalledWith({ decision: 'approve', remember: false });
      });

      test('a failure with only a summary writes just the summary', () => {
        const { getByRole } = render(ApprovalCard, {
          props: refundRow({ layout, failure: { summary: "Couldn't deny." } }),
        });
        expect(squash(getByRole('alert').textContent)).toBe("Couldn't deny.");
      });

      test('an expired approval is read-only and says when it expired', () => {
        const { getByText, queryByRole, getByRole } = render(ApprovalCard, {
          props: refundRow({
            layout,
            expiresAt: '2026-11-02T10:15:00.000Z',
            now: new Date('2026-11-02T10:42:00.000Z'),
          }),
        });

        expect(getByRole('article').getAttribute('data-cinder-state')).toBe('expired');
        expect(queryByRole('button', { name: 'Approve' })).toBeNull();
        expect(queryByRole('button', { name: 'Deny' })).toBeNull();
        expect(
          getByText('This approval expired at 10:15 AM UTC, the time its request set.'),
        ).toBeTruthy();
      });

      test('a notice from the host replaces the default expiry sentence', () => {
        const { getByText, queryByText } = render(ApprovalCard, {
          props: refundRow({
            layout,
            expiresAt: '2026-11-02T10:15:00.000Z',
            notice: 'This approval expired at 10:15 AM CST. Nothing was refunded.',
          }),
        });

        expect(
          getByText('This approval expired at 10:15 AM CST. Nothing was refunded.'),
        ).toBeTruthy();
        expect(queryByText(/the time its request set/)).toBeNull();
      });

      test('a decided approval shows who decided, when, and the result', () => {
        const { container, getByText } = render(ApprovalCard, {
          props: refundRow({
            layout,
            state: 'approved',
            decidedBy: 'you',
            decidedAt: '2026-11-02T10:33:00.000Z',
            result: 'Refunded $18.50 to the original card.',
          }),
        });

        expect(squash(container.querySelector('.cinder-approval-card__outcome')?.textContent)).toBe(
          layout === 'detail'
            ? 'Approved by you 10:33 AM today · Tool runner'
            : 'Approved by you · 10:33 AM',
        );
        expect(squash(container.querySelector('.cinder-approval-card__result')?.textContent)).toBe(
          'Result: Refunded $18.50 to the original card.',
        );
        expect(getByText('Refunded $18.50 to the original card.', { exact: false })).toBeTruthy();
      });

      test('an approval answered elsewhere says where and when in one sentence', () => {
        const { container, queryByRole } = render(ApprovalCard, {
          props: refundRow({
            layout,
            state: 'approved',
            decidedBy: 'you',
            decidedIn: 'Reviews',
            decidedAt: '2026-11-02T10:44:00.000Z',
            notice:
              "The run is continuing, so this page changed. You don't need to do anything here.",
          }),
        });

        expect(
          squash(
            container.querySelector('.cinder-approval-card__outcome, [class*="elsewhere-title"]')
              ?.textContent,
          ),
        ).toBe(
          layout === 'detail'
            ? 'Approved by you in Reviews at 10:44 AM · Tool runner'
            : layout === 'row'
              ? // The row writes the time after a middot, as it does for a decision made here.
                'Approved by you in Reviews · 10:44 AM'
              : 'Approved by you in Reviews at 10:44 AM',
        );
        expect(container.textContent).toContain("You don't need to do anything here.");
        expect(queryByRole('button', { name: 'Approve' })).toBeNull();
        expect(queryByRole('button', { name: 'Deny' })).toBeNull();
      });

      test('the footnote shows while the approval waits and goes with the buttons', () => {
        const waiting = render(ApprovalCard, {
          props: refundRow({
            layout,
            footnote: 'Once you decide, Tool runner continues when a provider is connected.',
          }),
        });
        expect(
          waiting.getByText('Once you decide, Tool runner continues when a provider is connected.'),
        ).toBeTruthy();
        cleanup();

        const decided = render(ApprovalCard, {
          props: refundRow({ layout, state: 'denied', footnote: 'Once you decide.' }),
        });
        expect(decided.queryByText('Once you decide.')).toBeNull();
      });

      test('inputLabel renames the Input block', () => {
        const { container } = render(ApprovalCard, {
          props: refundRow({ layout, inputLabel: 'Runs with' }),
        });
        expect(container.textContent).toContain('Runs with');
      });

      test('a context slot writes its line above the question', () => {
        const context = createRawSnippet(() => ({
          render: () => '<span>Test chat · this runs for real: order 4471 is refunded</span>',
        }));
        const { container } = render(ApprovalCard, { props: refundRow({ layout, context }) });

        const line = container.querySelector('.cinder-approval-card__context');
        const title = container.querySelector('h3');
        expect(line?.textContent).toBe('Test chat · this runs for real: order 4471 is refunded');
        // Above the question, except on the detail page, which writes the context under who asked.
        const following =
          line !== null &&
          title !== null &&
          line.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING;
        expect(layout === 'detail' ? !following : Boolean(following)).toBe(true);
      });
    });
  }

  test('an unavailable row writes the host notice beside the reason', () => {
    const { getByText } = render(ApprovalCard, {
      props: refundRow({
        state: 'unavailable',
        unavailableReason: 'Tool runner is unavailable.',
        notice: 'It returns when the plugin is enabled.',
      }),
    });
    expect(getByText('Tool runner is unavailable.')).toBeTruthy();
    expect(getByText('It returns when the plugin is enabled.')).toBeTruthy();
  });

  test('a failure is not shown once the approval is decided', () => {
    const { queryByRole } = render(ApprovalCard, {
      props: refundRow({ state: 'approved', failure: approveFailure }),
    });
    expect(queryByRole('alert')).toBeNull();
  });
});

describe('ApprovalCard detail layout', () => {
  const detailProps = (overrides: RowOverrides = {}): ApprovalCardProps =>
    refundRow({
      layout: 'detail',
      source: 'Tool runner',
      sourceIn: 'Please refund order 4471, it arrived damaged.',
      rememberScope: undefined,
      ...overrides,
    });

  test('orders the eyebrow, the question, who asked, the tool, the input and the risk line', () => {
    const { container, getByRole } = render(ApprovalCard, { props: detailProps() });

    const article = getByRole('article', { name: 'Refund order 4471 for $42.00?' });
    expect(article.getAttribute('data-cinder-layout')).toBe('detail');
    expect(
      squash(container.querySelector('.cinder-approval-card__detail-eyebrow')?.textContent),
    ).toBe('Tool approval');
    expect(squash(container.querySelector('.cinder-approval-card__detail-ask')?.textContent)).toBe(
      'Asked by Tool runner in Please refund order 4471, it arrived damaged. · waiting 4 min',
    );
    expect(squash(container.querySelector('.cinder-approval-card__detail-tool')?.textContent)).toBe(
      'It wants to run Issue refund issue-refund · Dangerous',
    );
    expect(squash(container.querySelector('.cinder-approval-card__detail-risk')?.textContent)).toBe(
      "Can't be undone. Sends $42.00 back to the original card",
    );

    const order = [
      '.cinder-approval-card__detail-eyebrow',
      '.cinder-approval-card__title',
      '.cinder-approval-card__detail-ask',
      '.cinder-approval-card__detail-tool',
      '.cinder-payload-inspector',
      '.cinder-approval-card__detail-risk',
      '.cinder-approval-card__action-row',
    ].map((selector) => container.querySelector(selector));
    for (const [index, element] of order.entries()) {
      expect(element, `missing ${index}`).not.toBeNull();
      const next = order[index + 1];
      if (element !== null && next !== undefined && next !== null) {
        expect(
          element.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    }
  });

  test('has no Details disclosure and renames the eyebrow, the prefixes and the Input block', () => {
    const { container, getByText, queryByRole } = render(ApprovalCard, {
      props: detailProps({
        eyebrow: 'Approval',
        sourcePrefix: 'From',
        toolPrefix: 'Wants',
        inputLabel: 'Runs with',
      }),
    });

    expect(queryByRole('button', { name: 'Details' })).toBeNull();
    expect(getByText('Approval')).toBeTruthy();
    expect(
      squash(container.querySelector('.cinder-approval-card__detail-ask')?.textContent),
    ).toMatch(/^From Tool runner/);
    expect(
      squash(container.querySelector('.cinder-approval-card__detail-tool')?.textContent),
    ).toMatch(/^Wants Issue refund/);
    expect(container.textContent).toContain('Runs with');
  });

  test('keeps the failure below the risk line while Deny and Approve stay live', () => {
    const { container, getByRole } = render(ApprovalCard, {
      props: detailProps({
        failure: {
          summary: "Couldn't approve.",
          detail: "Interborough couldn't reach the agent. Nothing was refunded.",
        },
        onResolve: mock(),
      }),
    });

    const risk = container.querySelector('.cinder-approval-card__detail-risk');
    const failure = getByRole('alert');
    expect(risk?.compareDocumentPosition(failure)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(false);
  });

  test('leads a decided approval with its green outcome and writes the result and no state sentence', () => {
    const { container } = render(ApprovalCard, {
      props: detailProps({
        state: 'approved',
        decidedBy: 'you',
        decidedAt: '2026-11-02T10:33:00.000Z',
        result: 'Refunded $18.50 to the original card.',
        onResolve: undefined,
      }),
    });

    const outcome = container.querySelector('.cinder-approval-card__outcome');
    expect(outcome?.getAttribute('data-cinder-tone')).toBe('success');
    expect(squash(outcome?.textContent)).toBe(
      'Approved by you 10:33 AM today · Tool runner in Please refund order 4471, it arrived damaged.',
    );
    expect(container.querySelector('.cinder-approval-card__readonly-summary')).toBeNull();
    expect(container.querySelector('.cinder-approval-card__detail-ask')).toBeNull();
    expect(squash(container.querySelector('.cinder-approval-card__result')?.textContent)).toBe(
      'Result: Refunded $18.50 to the original card.',
    );
  });

  test('names an expired approval beside who asked, with the expiry notice', () => {
    const { container } = render(ApprovalCard, {
      props: detailProps({
        expiresAt: '2026-11-02T10:15:00.000Z',
        requestedAt: undefined,
        onResolve: undefined,
      }),
    });

    expect(squash(container.querySelector('.cinder-approval-card__detail-ask')?.textContent)).toBe(
      'Asked by Tool runner in Please refund order 4471, it arrived damaged. · Expired',
    );
    expect(container.querySelector('.cinder-approval-card__readonly-summary')?.textContent).toMatch(
      EXPIRED_NOTICE,
    );
  });
});

describe('ApprovalCard outcome', () => {
  test('draws an approval in green and a denial in neutral text', () => {
    const approved = render(ApprovalCard, {
      props: refundRow({ state: 'approved', decidedBy: 'you' }),
    });
    expect(
      approved.container
        .querySelector('.cinder-approval-card__outcome')
        ?.getAttribute('data-cinder-tone'),
    ).toBe('success');
    cleanup();

    const denied = render(ApprovalCard, {
      props: refundRow({ state: 'denied', decidedBy: 'you' }),
    });
    expect(
      denied.container
        .querySelector('.cinder-approval-card__outcome')
        ?.getAttribute('data-cinder-tone'),
    ).toBe('neutral');
  });

  test('writes the approver note under a denial and says it went to the agent as the reason', () => {
    const { container } = render(ApprovalCard, {
      props: refundRow({
        state: 'denied',
        decidedBy: 'you',
        decidedAt: '2026-11-02T10:40:00.000Z',
        decisionNote: 'Check the carrier’s claim first.',
      }),
    });

    expect(
      squash(container.querySelector('.cinder-approval-card__decision-note')?.textContent),
    ).toBe('Your note Check the carrier’s claim first. Sent to the agent as the reason.');
  });

  test('keeps the input line on a decided row', () => {
    const { container } = render(ApprovalCard, {
      props: refundRow({ state: 'approved', decidedBy: 'you', inputLabel: 'Input' }),
    });

    expect(
      squash(container.querySelector('.cinder-approval-card__decided-input')?.textContent),
    ).toBe('Input Order ID 4471 · Amount $42.00 · Reason Arrived damaged');
  });

  test('says nothing more than the outcome when no notice or reason was given', () => {
    const { container } = render(ApprovalCard, {
      props: refundRow({
        layout: 'card',
        state: 'approved',
        decidedBy: 'you',
        onResolve: undefined,
      }),
    });

    expect(container.querySelector('.cinder-approval-card__readonly-summary')).toBeNull();
  });

  test('colours only an approval green in the stylesheet', () => {
    const css = readFileSync(new URL('./approval-card.css', import.meta.url), 'utf8');

    expect(css).toMatch(
      /outcome\[data-cinder-tone='success'\] \.cinder-approval-card__outcome-dot \{[^}]*status-success/,
    );
    expect(css).not.toMatch(/outcome\[data-cinder-tone='neutral'\]/);
  });
});

describe('ApprovalCard line wrapping', () => {
  test('keeps the time and the tool facts from breaking in the stylesheet', () => {
    const css = readFileSync(new URL('./approval-card.css', import.meta.url), 'utf8');

    // The facts line may wrap between its pieces, so a phone never clips "Can't be undone" at the
    // card's edge; each piece stays whole and keeps the middot that follows it.
    expect(css).not.toMatch(/\.cinder-approval-card__line-facts \{[^}]*white-space: nowrap/);
    expect(css).toMatch(/\.cinder-approval-card__keep \{\s*white-space: nowrap;/);
    expect(css).toMatch(/\.cinder-approval-card__undone \{\s*white-space: nowrap;/);
    expect(css).toMatch(/\.cinder-approval-card__line time[^{]*\{\s*white-space: nowrap;/);
  });

  test('puts the time on a line of its own, without the middot, where who asked and when cannot share one', () => {
    const css = readFileSync(new URL('./approval-card.css', import.meta.url), 'utf8');

    expect(css).toMatch(
      /@container \(inline-size < 17rem\) \{[^@]*__line \.cinder-approval-card__time-separator \{\s*display: none;[^@]*__line time \{\s*display: block;/,
    );
    expect(css).toMatch(
      /@container \(inline-size < 19rem\) \{[^@]*__eyebrow \.cinder-approval-card__time-separator,[^@]*__detail-ask \.cinder-approval-card__time-separator \{\s*display: none;/,
    );
  });

  test('keeps each piece of the facts line whole with the middot that follows it', () => {
    const { container } = render(ApprovalCard, { props: refundRow() });

    expect(squash(container.querySelector('.cinder-approval-card__line-facts')?.textContent)).toBe(
      "issue-refund · Dangerous · Can't be undone",
    );
    expect(
      [
        ...container.querySelectorAll('.cinder-approval-card__line .cinder-approval-card__keep'),
      ].map((piece) => squash(piece.textContent)),
    ).toEqual(['issue-refund ·', 'Dangerous ·']);
    expect(container.querySelector('.cinder-approval-card__line time')?.textContent).toBe(
      '4 min ago',
    );
  });
});

describe('ApprovalCard view', () => {
  test('shows the JSON view of its input when view is json', async () => {
    const { container, getByRole } = render(ApprovalCard, { props: refundRow({ view: 'json' }) });

    await fireEvent.click(getByRole('button', { name: /^Input/ }));

    expect(container.querySelector('.cinder-payload-inspector')?.textContent).toContain('orderId');
  });
});

describe('ApprovalCard source line', () => {
  for (const layout of ['row', 'card', 'detail'] as const) {
    test(`${layout}: sourcePrefix replaces the words before the source`, () => {
      const { container } = render(ApprovalCard, {
        props: refundRow({ layout, sourcePrefix: 'Asked by' }),
      });

      expect(container.textContent).toContain('Asked by Tool runner');
      expect(container.textContent).not.toContain('Approval from Tool runner');
    });
  }

  test('row: the default prefix is Approval from, and the source stays on its own line with its time', () => {
    const { container } = render(ApprovalCard, { props: refundRow() });

    expect(squash(container.querySelector('.cinder-approval-card__line-source')?.textContent)).toBe(
      '· Approval from Tool runner · 4 min ago',
    );
  });

  test('the card keeps the middot with the source, so the time is never stranded behind it', () => {
    const { container } = render(ApprovalCard, { props: refundRow({ layout: 'card' }) });

    expect(squash(container.querySelector('.cinder-approval-card__eyebrow')?.textContent)).toBe(
      'Approval from Tool runner · 4 min ago',
    );
    // The middot is tied to the source by a no-break space, so it never starts a line or stands alone.
    expect(container.querySelector('.cinder-approval-card__eyebrow')?.textContent).toContain(
      'Approval from Tool runner\u00a0·',
    );
  });
});

describe('ApprovalCard detail links and what the source said', () => {
  const detail = (overrides: RowOverrides = {}): ApprovalCardProps =>
    refundRow({
      layout: 'detail',
      sourceIn: 'Please refund order 4471, it arrived damaged.',
      rememberScope: undefined,
      ...overrides,
    });

  test('writes the source and the chat as links when they have a place to lead', () => {
    const { container } = render(ApprovalCard, {
      props: detail({ sourceHref: '/agents/tool-runner', sourceInHref: '/chat/415b1fd8' }),
    });

    const links = [...container.querySelectorAll('.cinder-approval-card__detail-ask a')];
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Tool runner', '/agents/tool-runner'],
      ['Please refund order 4471, it arrived damaged.', '/chat/415b1fd8'],
    ]);
    expect(squash(container.querySelector('.cinder-approval-card__detail-ask')?.textContent)).toBe(
      'Asked by Tool runner in Please refund order 4471, it arrived damaged. · waiting 4 min',
    );
  });

  test('a decided approval writes the chat as a link after the outcome', () => {
    const { container } = render(ApprovalCard, {
      props: detail({
        state: 'approved',
        decidedBy: 'you',
        decidedAt: '2026-11-02T10:33:00.000Z',
        sourceInHref: '/chat/415b1fd8',
        onResolve: undefined,
      }),
    });

    const outcome = container.querySelector('.cinder-approval-card__outcome');
    expect(squash(outcome?.textContent)).toBe(
      'Approved by you 10:33 AM today · Tool runner in Please refund order 4471, it arrived damaged.',
    );
    const link = outcome?.querySelector('a');
    expect(link?.textContent).toBe('Please refund order 4471, it arrived damaged.');
    expect(link?.getAttribute('href')).toBe('/chat/415b1fd8');
    // The source's name is plain text until the page gives it a place to lead.
    expect(outcome?.querySelectorAll('a')).toHaveLength(1);
  });

  test('names the day when the decision was not made today', () => {
    const { container } = render(ApprovalCard, {
      props: detail({
        state: 'approved',
        decidedBy: 'you',
        decidedAt: '2026-11-01T16:12:00.000Z',
        onResolve: undefined,
      }),
    });

    expect(squash(container.querySelector('.cinder-approval-card__outcome')?.textContent)).toMatch(
      /^Approved by you 4:12 PM yesterday · /,
    );
  });

  test('the other layouts keep the clock alone after a middot', () => {
    const { container } = render(ApprovalCard, {
      props: refundRow({
        layout: 'row',
        state: 'approved',
        decidedBy: 'you',
        decidedAt: '2026-11-02T10:33:00.000Z',
        onResolve: undefined,
      }),
    });

    expect(squash(container.querySelector('.cinder-approval-card__outcome')?.textContent)).toBe(
      'Approved by you · 10:33 AM',
    );
  });

  test('what the source said is a collapsed line that opens in place to the whole text', async () => {
    const said = 'Order 4471 is $42.00, delivered Monday, and the carrier flagged it as damaged.';
    const { container, getByRole } = render(ApprovalCard, { props: detail({ said }) });

    const toggle = getByRole('button', { name: /^Tool runner said/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const text = container.querySelector('.cinder-approval-card__said-text') as HTMLElement;
    expect(text.textContent).toBe(said);
    expect(text.hasAttribute('data-cinder-open')).toBe(false);

    await fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(text.hasAttribute('data-cinder-open')).toBe(true);
    expect(toggle.getAttribute('aria-controls')).toBe(text.id);
    const ask = container.querySelector('.cinder-approval-card__detail-ask') as HTMLElement;
    const tool = container.querySelector('.cinder-approval-card__detail-tool') as HTMLElement;
    const line = container.querySelector('.cinder-approval-card__said') as HTMLElement;
    expect(ask.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('says nothing about what was said when the source said nothing', () => {
    const { container } = render(ApprovalCard, { props: detail() });

    expect(container.querySelector('.cinder-approval-card__said')).toBeNull();
  });
});

describe('ApprovalCard failure message', () => {
  for (const layout of ['row', 'card', 'detail'] as const) {
    test(`${layout}: is a tinted, bordered danger Alert with the summary in bold`, () => {
      const { getByRole } = render(ApprovalCard, {
        props: refundRow({
          layout,
          failure: { summary: "Couldn't deny.", detail: "Interborough couldn't reach the agent." },
        }),
      });

      const alert = getByRole('alert');
      expect(alert.classList.contains('cinder-alert')).toBe(true);
      expect(alert.classList.contains('cinder-approval-card__failure')).toBe(true);
      expect(alert.getAttribute('data-cinder-variant')).toBe('danger');
      expect(alert.querySelector('strong')?.textContent).toBe("Couldn't deny.");
      expect(squash(alert.textContent)).toBe(
        "Couldn't deny. Interborough couldn't reach the agent.",
      );
    });
  }
});

describe('ApprovalCard Details disclosure', () => {
  test('appears only when there is a sandbox, environment names or a snapshot to disclose', () => {
    const bare = render(ApprovalCard, {
      props: refundRow({ layout: 'card', sandbox: undefined, env: [], snapshotId: undefined }),
    });
    expect(bare.queryByRole('button', { name: 'Details' })).toBeNull();
    cleanup();

    const withSnapshot = render(ApprovalCard, {
      props: refundRow({ layout: 'card', sandbox: undefined, env: [], snapshotId: 'snapshot-1' }),
    });
    expect(withSnapshot.getByRole('button', { name: 'Details' })).toBeTruthy();
  });
});

describe('ApprovalCard answered elsewhere', () => {
  test('replaces the card with a glyph, who decided where and when, and one sentence', () => {
    const { container, queryByRole, getByRole } = render(ApprovalCard, {
      props: refundRow({
        layout: 'card',
        state: 'approved',
        decidedBy: 'you',
        decidedIn: 'Reviews',
        decidedAt: '2026-11-02T10:44:00.000Z',
        notice: "The run is continuing, so this page changed. You don't need to do anything here.",
      }),
    });

    const article = getByRole('article', { name: 'Approved by you in Reviews at 10:44 AM' });
    expect(article.classList.contains('cinder-approval-card--elsewhere')).toBe(true);
    expect(article.querySelector('svg')).not.toBeNull();
    expect(
      squash(container.querySelector('.cinder-approval-card__elsewhere-body')?.textContent),
    ).toBe(
      "Refund order 4471 for $42.00 · Issue refund. The run is continuing, so this page changed. You don't need to do anything here.",
    );
    // Nothing of the card is left to answer or read: no input, no details, no buttons.
    expect(container.querySelector('.cinder-payload-inspector')).toBeNull();
    expect(queryByRole('button')).toBeNull();
    expect(container.querySelector('.cinder-approval-card__readonly-summary')).toBeNull();
  });

  test('a question answered elsewhere reads Answered by you in Reviews and names no tool', () => {
    const { container, getByRole } = render(ApprovalCard, {
      props: refundRow({
        layout: 'card',
        question: 'Which environment should the release go to?',
        tool: { name: 'ask-user', label: 'Ask a question', risk: 'low' },
        state: 'approved',
        outcomeLabel: 'Answered',
        decidedBy: 'you',
        decidedIn: 'Reviews',
        decidedAt: '2026-11-02T10:44:00.000Z',
        notice: "The run is continuing, so this page changed. You don't need to do anything here.",
      }),
    });

    const article = getByRole('article', { name: 'Answered by you in Reviews at 10:44 AM' });
    expect(article.classList.contains('cinder-approval-card--elsewhere')).toBe(true);
    expect(
      squash(container.querySelector('.cinder-approval-card__elsewhere-body')?.textContent),
    ).toBe(
      "Which environment should the release go to? The run is continuing, so this page changed. You don't need to do anything here.",
    );
  });

  test('a decision made here still draws the whole card', () => {
    const { container } = render(ApprovalCard, {
      props: refundRow({
        layout: 'card',
        state: 'approved',
        decidedBy: 'you',
        decidedAt: '2026-11-02T10:44:00.000Z',
      }),
    });

    expect(container.querySelector('.cinder-approval-card--elsewhere')).toBeNull();
    expect(container.querySelector('.cinder-payload-inspector')).not.toBeNull();
  });
});

describe('ApprovalCard decided row order', () => {
  test('reads the question, the tool line, the input and then the decision', () => {
    const { container } = render(ApprovalCard, {
      props: refundRow({
        layout: 'row',
        tool: { name: 'create-workflow', risk: 'medium' },
        state: 'approved',
        decidedBy: 'you',
        decidedAt: '2026-11-02T10:42:00.000Z',
        onResolve: undefined,
      }),
    });

    const order = [
      '.cinder-approval-card__row-question',
      '.cinder-approval-card__line',
      '.cinder-approval-card__decided-input',
      '.cinder-approval-card__outcome',
    ].map((selector) => container.querySelector(selector));
    for (const [index, element] of order.entries()) {
      expect(element, `missing ${index}`).not.toBeNull();
      const next = order[index + 1];
      if (element !== null && next !== undefined && next !== null) {
        expect(
          element.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    }
    expect(container.querySelector('.cinder-approval-card__tool-label')).toBeNull();
  });
});
