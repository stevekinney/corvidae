/// <reference lib="dom" />
/**
 * DOM tests for finding navigation and remediation in the checks panel (COR-487): summary to
 * finding to editor state, the proposal's contents, focus after Apply and Undo, one
 * aggregate announcement, no focus movement on background revalidation, stale proposals, the
 * blocked state, and the absence of a "Fix all".
 */

import { afterAll, afterEach, beforeEach, expect } from 'bun:test';
import { flushSync, mount, tick, unmount } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

import { awakeTurns } from '@lostgradient/testing/wait-until';
import ThemeChecksPanel from './theme-checks-panel.svelte';
import type { ThemeEvaluator } from './theme-draft-evaluation.ts';
import { createDraft } from './theme-draft.ts';
import { proposeForFinding } from './theme-remediation-apply.ts';
import {
  dimmedText,
  findFinding,
  memoEvaluator,
  oklchColor,
  openController,
  rememberForegroundSearch,
  warmedTests,
  withOverride,
} from './theme-remediation-test-support.ts';

setupHappyDom();

afterAll(rememberForegroundSearch());

// Two independent failures, so a fix has a next unresolved finding to land on. Their
// evaluations (and each fix's) are cached by content at module scope, not in test bodies.
const twoFailures = withOverride('light', 'text.muted', oklchColor(0.93, 0.01, 245), dimmedText);
const grayCanvas = withOverride('light', 'surface.canvas', oklchColor(0.5, 0, 0));

// Warm the content-keyed evaluator for every source a test mounts or proposes, so test bodies
// replay evaluations instead of running the runtime (Bun's 5 s budget covers each body).
for (const envelope of [dimmedText, twoFailures, grayCanvas]) {
  const record = await findFinding(
    envelope,
    (candidate) =>
      candidate.pairingId === 'text:default:canvas' && candidate.context === 'light/default',
  );
  const draft = createDraft(envelope);
  await proposeForFinding({ draft, record, evaluator: memoEvaluator, gamut: 'srgb' });
}

let target: HTMLElement;
let mounted: ReturnType<typeof mount> | null = null;

function openTarget(): void {
  target = document.createElement('div');
  document.body.append(target);
}
function closeTarget(): void {
  if (mounted !== null) void unmount(mounted);
  mounted = null;
  target.remove();
}

beforeEach(openTarget);
afterEach(closeTarget);

// Applying a fix, undoing it and restoring reach states past the fixtures warmed above. Each body
// runs once at the end of this file (COR-1571), outside Bun's per-test budget, so the registered
// run replays the searches and evaluations from memory.
const { group, scenario, warmScenarios } = warmedTests({ before: openTarget, after: closeTarget });

async function until(condition: () => boolean): Promise<void> {
  for await (const _turn of awakeTurns()) {
    if (!!condition()) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
    flushSync();
    await tick();
  }
  if (!condition()) throw new Error('The panel never reached the expected state.');
}

async function open(
  envelope = dimmedText,
  panelEvaluator: ThemeEvaluator = memoEvaluator,
  controllerEvaluator: ThemeEvaluator = memoEvaluator,
) {
  const { controller, workbench } = await openController(envelope, controllerEvaluator);
  mounted = mount(ThemeChecksPanel, {
    target,
    props: { workbench, controller, evaluator: panelEvaluator },
  });
  flushSync();
  const panel = () => target.querySelector<HTMLElement>('[data-testid="checks-panel"]')!;
  await until(() => panel().dataset['readiness'] === 'blocked-accessibility-errors');
  return { controller, workbench, panel };
}

const buttons = (root: ParentNode = target) => [...root.querySelectorAll('button')];
const buttonNamed = (name: RegExp | string, root: ParentNode = target) =>
  buttons(root).find((button) => {
    const text = `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`;
    return typeof name === 'string' ? text.includes(name) : name.test(text);
  });
const announcer = () =>
  target.querySelector('[data-testid="checks-announcer"]')?.textContent?.trim() ?? '';
const firstError = () =>
  target.querySelector<HTMLElement>(
    '[data-testid="finding"][data-severity="accessibility-error"]',
  )!;

async function review(finding: HTMLElement): Promise<void> {
  buttonNamed('Review a fix', finding)!.click();
  await until(() => target.querySelector('[data-testid="remediation-proposal"]') !== null);
  await tick();
}

group('navigating from the summary', () => {
  scenario(
    'a severity count moves focus to its first finding, and Show in editor reports the state',
    async () => {
      const { workbench } = await open();
      const link = buttonNamed('Go to the first accessibility errors finding')!;
      link.focus();
      link.click();
      await until(() => document.activeElement === firstError());
      expect(document.activeElement?.getAttribute('data-finding-id')).toBe(
        firstError().dataset['findingId'] ?? null,
      );
      const show = buttonNamed('Show in editor', firstError())!;
      show.focus();
      show.click();
      flushSync();
      expect(workbench.selectedTokenPath).toBe('text.default');
      expect(workbench.context.colorMode).toBe('light');
      expect(announcer()).toContain('Showing text.default in the editor, light/default');
      // The button keeps focus; opening the editor state never steals it.
      // Compared as booleans: a failed DOM-node `toBe` pretty-prints the whole document.
      expect(document.activeElement === buttonNamed('Show in editor', firstError())).toBe(true);
    },
  );
});

group('the proposal', () => {
  scenario('shows every changed path, the measurements, the gamut and a single Apply', async () => {
    await open();
    const finding = firstError();
    await review(finding);
    const proposal = target.querySelector<HTMLElement>('[data-testid="remediation-proposal"]')!;
    expect(proposal.dataset['action']).toBe('replace-oklch');
    expect(proposal.querySelector('h4')?.textContent).toContain('Replace value with OKLCH');
    expect(document.activeElement === proposal.querySelector('h4')).toBe(true);
    expect(proposal.textContent).toContain('text.default');
    expect(proposal.textContent).toContain('oklch(0.93 0.01 245)');
    expect(proposal.textContent).toContain('Output gamut: sRGB');
    expect(proposal.textContent).toContain('foreground-oklch-remediation/1');
    expect(
      proposal.querySelectorAll('[data-testid="remediation-measurements"] tbody tr').length,
    ).toBeGreaterThan(0);
    expect(
      buttons(proposal).filter((button) => /Apply fix/.test(button.textContent ?? '')),
    ).toHaveLength(1);
    expect(target.textContent).not.toMatch(/fix all/i);
  });

  scenario('Cancel changes nothing and returns focus to the finding’s button', async () => {
    const { controller } = await open();
    const before = JSON.stringify(controller.draft!.envelope);
    await review(firstError());
    buttonNamed('Cancel')!.click();
    await until(() => target.querySelector('[data-testid="remediation-proposal"]') === null);
    await tick();
    expect(JSON.stringify(controller.draft!.envelope)).toBe(before);
    expect(document.activeElement === buttonNamed('Review a fix', firstError())).toBe(true);
  });

  scenario('a proposal goes stale when the source changes and Apply is withheld', async () => {
    const { controller } = await open();
    await review(firstError());
    await controller.setLocked('accent.text', true);
    await until(() => target.querySelector('[data-testid="remediation-stale"]') !== null);
    const apply = buttonNamed('Apply fix')!;
    expect(apply.hasAttribute('disabled') || apply.getAttribute('aria-disabled') === 'true').toBe(
      true,
    );
    expect(target.querySelector('[data-testid="remediation-stale"]')?.textContent).toContain(
      'source changed',
    );
  });
});

group('applying and undoing', () => {
  scenario(
    'Apply announces the aggregate effect, moves focus to the next unresolved finding, and Undo returns it',
    async () => {
      const { controller } = await open(twoFailures);
      const finding = firstError();
      const fixedId = finding.dataset['findingId']!;
      const fixedPath = finding.textContent?.includes('text.muted') ? 'text.muted' : 'text.default';
      const before = JSON.stringify(controller.draft!.envelope);
      await review(finding);
      buttonNamed('Apply fix')!.click();
      await until(() => controller.history!.entries.at(-1)?.kind === 'remediation');
      await until(() => /applied/.test(announcer()) && /Checks for revision/.test(announcer()));
      expect(announcer()).toMatch(
        /Replace value with OKLCH applied\. \d+ findings? resolved, none introduced\./,
      );
      // Focus lands on the other, still unresolved, error finding: never on the body.
      const active = document.activeElement as HTMLElement;
      expect(active.dataset['testid']).toBe('finding');
      expect(active.dataset['severity']).toBe('accessibility-error');
      expect(active.dataset['findingId']).not.toBe(fixedId);
      expect(active.textContent).not.toContain(`Tokens${fixedPath}`);

      const undo = buttonNamed('Undo last fix')!;
      undo.focus();
      undo.click();
      await until(() => JSON.stringify(controller.draft!.envelope) === before);
      await until(() => document.activeElement?.getAttribute('data-finding-id') === fixedId);
      expect(announcer()).toContain('Undid');
    },
  );

  scenario('background revalidation never moves focus', async () => {
    const { controller } = await open();
    const outside = document.createElement('button');
    outside.textContent = 'Somewhere else';
    document.body.append(outside);
    outside.focus();
    await controller.setLocked('accent.text', true);
    await until(() => announcer() !== '');
    expect(document.activeElement === outside).toBe(true);
    outside.remove();
  });
});

group('when no fix is safe', () => {
  scenario('the blocking constraints are explained and a passing restore is offered', async () => {
    const { controller } = await open(grayCanvas);
    const finding = target.querySelector<HTMLElement>(
      '[data-finding-id="wcag-1.4.3-text-contrast:text:default:canvas:light/default"]',
    )!;
    buttonNamed('Review a fix', finding)!.click();
    await until(() => target.querySelector('[data-testid="remediation-blocked"]') !== null);
    expect(target.querySelector('[data-testid="remediation-reason"]')?.textContent).toContain(
      'no single color on the search grid passes all of them',
    );
    const restore = target.querySelector<HTMLElement>('[data-testid="remediation-proposal"]')!;
    expect(restore.dataset['action']).toBe('restore-overrides');
    expect(restore.textContent).toContain('Restore affected overrides');
    buttonNamed('Apply fix', restore)!.click();
    await until(() => controller.history!.entries.at(-1)?.kind === 'remediation');
    expect(controller.draft!.envelope.overrides.light).toEqual({});
  });
});

group('invalid source', () => {
  scenario(
    'offers only "Restore last valid value" and applies it as one undoable transaction',
    async () => {
      const accepting: ThemeEvaluator = {
        async evaluate(_source, revision, context) {
          return { revision, context, ok: true, properties: [] };
        },
      };
      const rejecting: ThemeEvaluator = {
        async evaluate(source, revision, context) {
          const shared = source.overrides.shared as { radius?: unknown };
          return shared.radius === undefined
            ? { revision, context, ok: true, properties: [] }
            : {
                revision,
                context,
                ok: false,
                diagnostics: [{ path: 'radius.medium', code: 'invalid-theme', message: 'unit' }],
              };
        },
      };
      const { controller, workbench } = await (async () => {
        const opened = await openController(withOverride('shared', 'radius', {}), accepting);
        return opened;
      })();
      mounted = mount(ThemeChecksPanel, {
        target,
        props: { workbench, controller, evaluator: rejecting },
      });
      flushSync();
      await until(() => target.querySelector('#checks-invalid-heading') !== null);
      expect(buttonNamed('Fix all')).toBeUndefined();
      buttonNamed('Restore last valid value')!.click();
      await until(() => target.querySelector('[data-testid="remediation-proposal"]') !== null);
      buttonNamed('Apply fix')!.click();
      await until(() => controller.history!.entries.at(-1)?.kind === 'remediation');
      expect(controller.draft!.envelope.overrides.shared).toEqual({});
    },
  );
});

await warmScenarios();
