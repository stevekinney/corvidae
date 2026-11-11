#!/usr/bin/env bun
/**
 * Captures the Chat stress fixture (COR-2289): every case of `chat-stress.json` at the board's four
 * profiles, each from a fresh page load, through the real controls its steps press.
 *
 *   bun scripts/browser-fixtures/scripts/capture-chat-stress.ts [--out <directory>] [--cases 9,10,14-15]
 *     [--profiles 1440-light,320-dark]
 *
 * `CHAT_STRESS_SUPPLEMENTAL=1` adds the 390 dark phone profile. Before the first case it builds the
 * fixture host into the run's own directory, records the source identity (commit, uncommitted
 * changes, built page, Bun version) in `source-identity.json`, serves that build on a port the
 * system chooses, and waits for the host to answer. Each run writes into a fresh directory under
 * `--out` (default `<repository>/tmp/chat-stress`), so no run overwrites another and a server another
 * checkout left running is never read.
 *
 * The run writes `manifest.jsonl` (one line per image), `summary.json` and `gallery.html`. Every page
 * is measured for errors, document overflow, short touch targets below 500 px, clipped status text,
 * Arabic direction and the composer edge of the paired cases, and one deadline, the awake-time hang
 * guard, bounds every wait: the tool never sleeps. A failure names the case, the profile and the
 * measurement, and the gallery says Failed at the top; a failed run is never a passing witness.
 * Exit 0 when every image was taken and every measurement passed, 1 otherwise, 2 for bad usage.
 *
 * Playwright is used as a library from this process, so the run has no child test runner. The
 * design review that follows reads `gallery.html` and `manifest.jsonl`; it is not part of this tool.
 */
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { THEME_STORAGE_KEY, buildBrowser } from '@lostgradient/testing';
import {
  GEOMETRY_THRESHOLDS,
  auditCapture,
  consolidateFindings,
  renderGeometryReport as renderCraftGeometryReport,
  type GeometryCapture,
  type GeometryFinding,
} from '@lostgradient/testing/design-review-geometry';
import { measureGeometry } from '@lostgradient/testing/design-review-geometry-probe';
import { HANG_GUARD_MILLISECONDS } from '@lostgradient/testing/hang-guard';

import { environmentConfiguration } from '../environment-configuration.ts';
import casesData from '../src/fixtures/chat-stress.json';
import {
  STRESS_NOW,
  caseLabel,
  parseStressCases,
  type StressCase,
  type StressStep,
} from '../src/fixtures/chat-stress/stress-cases.ts';
import { createFixtureServer } from '../src/server.ts';
import {
  RUN_DIRECTORY_PREFIX,
  composerEdgeProblems,
  countProblems,
  focusVariantName,
  galleryImageFiles,
  measurementProblems,
  primaryImageName,
  profilesFor,
  reconciliationProblems,
  renderGallery,
  selectCases,
  sourceIdentity,
  variantImageName,
  type CaptureRecord,
  type PageMeasurement,
  type RunSummary,
  type SourceIdentity,
  type StressProfile,
} from './chat-stress-plan.ts';
import { prepareManifest } from './prepare-manifest.ts';

/** The one deadline every wait of the run shares. */
const DEADLINE = HANG_GUARD_MILLISECONDS;

const fixtureRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(fixtureRoot, '..', '..');

type Role = Parameters<Page['getByRole']>[0];

type Hooks = Record<string, (...argumentsList: unknown[]) => void>;

/** What the page measures about itself; the plan turns it into problems. */
type InPageMeasurement = Omit<PageMeasurement, 'pageErrors' | 'withdrawal' | 'approvalReceiptFits'>;

/** Runs in the page: the geometry the plan checks. */
export function measureInPage(options: {
  coarse: boolean;
  rtl: boolean;
  settledApproval: boolean;
}): InPageMeasurement {
  const shell = document.querySelector('[data-testid="chat-stress-shell"]') ?? document.body;
  const isVisible = (element: Element): boolean => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      box.width > 1 &&
      box.height > 1 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      element.closest('[hidden], [inert], [aria-hidden="true"]') === null
    );
  };
  const nameOf = (element: Element): string =>
    (element.getAttribute('aria-label') ?? element.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);

  const boxOf = (
    element: Element,
  ): { left: number; top: number; right: number; bottom: number } => {
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  };
  const rectArea = (left: number, top: number, right: number, bottom: number): number =>
    Math.max(0, right - left) * Math.max(0, bottom - top);
  const topAt = (x: number, y: number): string => {
    const element = document.elementFromPoint(x, y);
    return element === null ? '' : nameOf(element);
  };
  const hitTargetAt = (target: Element, x: number, y: number): boolean => {
    const hit = document.elementFromPoint(x, y);
    return hit !== null && (hit === target || target.contains(hit));
  };
  const modalBackground = (element: Element): boolean => {
    const modal = [
      ...document.querySelectorAll('[role="dialog"][aria-modal="true"], [aria-modal="true"]'),
    ].find((candidate) => isVisible(candidate));
    return modal !== undefined && !modal.contains(element);
  };
  // Cinder overlays are portaled to document.body, outside the fixture shell. Only include
  // visible overlay surfaces (and the shell) so background application controls cannot become
  // a false part of the captured fixture's reachable geometry.
  const overlayRoots = [
    ...document.querySelectorAll(
      '[role="dialog"], .cinder-citation__panel, .cinder-popover__sheet',
    ),
  ].filter(isVisible);
  const roots = [shell, ...overlayRoots.filter((root) => root !== shell)];
  const elementsInScope = <T extends Element>(selector: string): T[] => {
    const elements = new Set<T>();
    for (const root of roots) {
      if (root.matches(selector)) elements.add(root as T);
      for (const element of root.querySelectorAll<T>(selector)) elements.add(element);
    }
    return [...elements];
  };
  const reachableBox = (element: Element, box: DOMRect): DOMRect | undefined => {
    if (modalBackground(element)) return undefined;
    let left = Math.max(0, box.left);
    let top = Math.max(0, box.top);
    let right = Math.min(innerWidth, box.right);
    let bottom = Math.min(innerHeight, box.bottom);
    let ancestor = element.parentElement;
    while (ancestor !== null && ancestor !== shell.parentElement) {
      const style = getComputedStyle(ancestor);
      const clipX =
        ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflow) ||
        ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX);
      const clipY =
        ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflow) ||
        ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY);
      if (clipX || clipY) {
        const clip = ancestor.getBoundingClientRect();
        const clipLeft = clip.left + ancestor.clientLeft;
        const clipTop = clip.top + ancestor.clientTop;
        if (clipX) {
          left = Math.max(left, clipLeft);
          right = Math.min(right, clipLeft + ancestor.clientWidth);
        }
        if (clipY) {
          top = Math.max(top, clipTop);
          bottom = Math.min(bottom, clipTop + ancestor.clientHeight);
        }
      }
      ancestor = ancestor.parentElement;
    }
    return right > left && bottom > top
      ? new DOMRect(left, top, right - left, bottom - top)
      : undefined;
  };
  const maskHasTransparentStop = (value: string): boolean =>
    value !== 'none' && /transparent|rgba?\([^)]*,\s*0\)|hsla?\([^)]*,\s*0\)/i.test(value);
  const paintedBox = (element: Element, box: DOMRect): { width: number; height: number } => {
    const style = getComputedStyle(element);
    const face = getComputedStyle(element, '::before');
    if (face.content !== 'none' && face.position === 'absolute') {
      const parseInset = (value: string): number => {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const top = parseInset(face.top);
      const right = parseInset(face.right);
      const bottom = parseInset(face.bottom);
      const left = parseInset(face.left);
      if (face.width === 'auto' || face.height === 'auto') {
        return {
          width: Math.max(0, box.width - left - right),
          height: Math.max(0, box.height - top - bottom),
        };
      }
      return {
        width: Math.max(0, Number.parseFloat(face.width)),
        height: Math.max(0, Number.parseFloat(face.height)),
      };
    }
    const transparent = (color: string): boolean =>
      color === 'transparent' || color.endsWith(', 0)');
    if (style.backgroundClip === 'border-box') {
      return { width: box.width, height: box.height };
    }
    const horizontal =
      transparent(style.borderLeftColor) && transparent(style.borderRightColor)
        ? parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
        : 0;
    const vertical =
      transparent(style.borderTopColor) && transparent(style.borderBottomColor)
        ? parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
        : 0;
    return {
      width: Math.max(0, box.width - horizontal),
      height: Math.max(0, box.height - vertical),
    };
  };

  const smallTargets: { name: string; width: number; height: number }[] = [];
  const controlGeometry: {
    name: string;
    hitWidth: number;
    hitHeight: number;
    paintedWidth: number;
    paintedHeight: number;
    reachableWidth: number;
    reachableHeight: number;
    samples: { x: number; y: number; top: string; hitsTarget: boolean }[];
  }[] = [];
  if (options.coarse) {
    const controls = elementsInScope<HTMLElement>(
      'button, [role="button"], [role="radio"], [role="checkbox"], a[href], textarea, select, summary',
    );
    for (const element of controls) {
      if (!isVisible(element) || element.getAttribute('aria-hidden') === 'true') continue;
      if ((element as HTMLButtonElement).disabled) continue;
      // A link inside a sentence is sized by its text, not by the touch target rule.
      if (element.matches('a') && element.closest('p, li, td') !== null) continue;
      const box = element.getBoundingClientRect();
      const reachable = reachableBox(element, box);
      if (reachable === undefined) continue;
      const painted = paintedBox(element, box);
      const samplePoints: readonly [number, number][] = [
        [reachable.left + reachable.width / 2, reachable.top + reachable.height / 2],
        [reachable.left + Math.min(8, reachable.width / 2), reachable.top + reachable.height / 2],
        [reachable.right - Math.min(8, reachable.width / 2), reachable.top + reachable.height / 2],
        [reachable.left + reachable.width / 2, reachable.top + Math.min(8, reachable.height / 2)],
        [
          reachable.left + reachable.width / 2,
          reachable.bottom - Math.min(8, reachable.height / 2),
        ],
      ];
      controlGeometry.push({
        name: nameOf(element),
        hitWidth: Math.round(box.width * 100) / 100,
        hitHeight: Math.round(box.height * 100) / 100,
        paintedWidth: Math.round(painted.width * 100) / 100,
        paintedHeight: Math.round(painted.height * 100) / 100,
        reachableWidth: Math.round(reachable.width * 100) / 100,
        reachableHeight: Math.round(reachable.height * 100) / 100,
        samples: samplePoints.map(([x, y]) => ({
          x: Math.round(x * 100) / 100,
          y: Math.round(y * 100) / 100,
          top: topAt(x, y),
          hitsTarget: hitTargetAt(element, x, y),
        })),
      });
      if (box.width < 44 || box.height < 44) {
        smallTargets.push({
          name: nameOf(element),
          width: Math.round(box.width),
          height: Math.round(box.height),
        });
      }
    }
  }

  const occlusions: {
    target: string;
    overlay: string;
    overlapWidth: number;
    overlapHeight: number;
  }[] = [];
  const important = elementsInScope<HTMLButtonElement>('button, [role="button"]').filter(
    (element) => {
      const label = nameOf(element).toLowerCase();
      const approvalSurface = element.closest(
        '[class*="approval"], [data-chat-approval-drawer], .chat-tool-call-summary',
      );
      return (
        label.includes('approve') ||
        label.includes('deny') ||
        label.includes('copy') ||
        label.includes('refund') ||
        (approvalSurface !== null && !label.includes('review'))
      );
    },
  );
  for (const target of important) {
    const targetBox = target.getBoundingClientRect();
    if (
      !isVisible(target) ||
      reachableBox(target, targetBox) === undefined ||
      targetBox.bottom <= 0 ||
      targetBox.top >= innerHeight
    )
      continue;
    for (const candidate of elementsInScope('*')) {
      if (candidate === target || target.contains(candidate)) continue;
      const style = getComputedStyle(candidate);
      const pseudoStyles = [
        getComputedStyle(candidate, '::before'),
        getComputedStyle(candidate, '::after'),
      ];
      const positioned = ['absolute', 'fixed', 'sticky'].includes(style.position);
      const namedFade = candidate.matches(
        '[data-approval-fade], [class*="fade"], [class*="overlay"], [class*="mask"], .cinder-_scroll-fade, .cinder-_scroll-fade-start',
      );
      const visualMask =
        maskHasTransparentStop(style.maskImage) ||
        maskHasTransparentStop(style.webkitMaskImage) ||
        pseudoStyles.some(
          (pseudo) =>
            maskHasTransparentStop(pseudo.maskImage) ||
            maskHasTransparentStop(pseudo.webkitMaskImage),
        );
      const visualFade =
        namedFade &&
        (style.backgroundImage.includes('gradient') ||
          style.opacity !== '1' ||
          pseudoStyles.some(
            (pseudo) => pseudo.backgroundImage.includes('gradient') || pseudo.opacity !== '1',
          ));
      if (!positioned || (!visualMask && !visualFade)) continue;
      const candidateBox = candidate.getBoundingClientRect();
      const left = Math.max(targetBox.left, candidateBox.left);
      const top = Math.max(targetBox.top, candidateBox.top);
      const right = Math.min(targetBox.right, candidateBox.right);
      const bottom = Math.min(targetBox.bottom, candidateBox.bottom);
      if (rectArea(left, top, right, bottom) === 0) continue;
      const samples = [
        [targetBox.left + targetBox.width / 2, targetBox.top + targetBox.height / 2],
        [targetBox.left + 2, targetBox.top + targetBox.height / 2],
        [targetBox.right - 2, targetBox.top + targetBox.height / 2],
      ] as const;
      if (visualMask || visualFade || samples.some(([x, y]) => !hitTargetAt(target, x, y))) {
        occlusions.push({
          target: nameOf(target),
          overlay: nameOf(candidate),
          overlapWidth: Math.round((right - left) * 100) / 100,
          overlapHeight: Math.round((bottom - top) * 100) / 100,
        });
      }
    }
    if (nameOf(target).toLowerCase().includes('copy')) {
      const codeBlock = target.closest(
        '[data-cinder-markdown-kind="code-block"], .cinder-code-block',
      );
      const code = codeBlock?.querySelector('pre, code');
      const viewport = codeBlock?.querySelector('.cinder-code-block__viewport');
      if (code !== null && code !== undefined && codeBlock !== null && codeBlock !== undefined) {
        const codeBox = code.getBoundingClientRect();
        const viewportBox = (viewport ?? codeBlock).getBoundingClientRect();
        const visibleCode = reachableBox(code, codeBox);
        const left = Math.max(
          targetBox.left,
          visibleCode?.left ?? viewportBox.left,
          viewportBox.left,
        );
        const top = Math.max(targetBox.top, visibleCode?.top ?? viewportBox.top, viewportBox.top);
        const right = Math.min(
          targetBox.right,
          visibleCode?.right ?? viewportBox.right,
          viewportBox.right,
        );
        const bottom = Math.min(
          targetBox.bottom,
          visibleCode?.bottom ?? viewportBox.bottom,
          viewportBox.bottom,
        );
        if (rectArea(left, top, right, bottom) > 0) {
          occlusions.push({
            target: nameOf(target),
            overlay: 'code content',
            overlapWidth: Math.round((right - left) * 100) / 100,
            overlapHeight: Math.round((bottom - top) * 100) / 100,
          });
        }
      }
    }
  }

  const chromeParts: { name: string; top: number; bottom: number }[] = [];
  for (const element of shell.querySelectorAll(
    '.chat-input-area, [data-chat-approval-drawer], [data-chat-follow-up], [data-chat-attachment]',
  )) {
    if (!isVisible(element)) continue;
    const box = boxOf(element);
    chromeParts.push({
      name: nameOf(element),
      top: Math.round(box.top * 100) / 100,
      bottom: Math.round(box.bottom * 100) / 100,
    });
  }
  const chromeTop =
    chromeParts.length === 0 ? innerHeight : Math.min(...chromeParts.map((part) => part.top));
  const bottomChrome = {
    height: Math.round(Math.max(0, innerHeight - chromeTop) * 100) / 100,
    viewportHeight: innerHeight,
    share: Math.round((Math.max(0, innerHeight - chromeTop) / innerHeight) * 10000) / 10000,
    parts: chromeParts,
  };

  const clippedStatuses: string[] = [];
  for (const element of shell.querySelectorAll(
    '[role="status"], [data-status], [class*="status"]',
  )) {
    if (!isVisible(element)) continue;
    const style = getComputedStyle(element);
    const clips = style.overflow !== 'visible' && style.textOverflow !== 'ellipsis';
    const overflows =
      element.scrollWidth > element.clientWidth + 1 ||
      element.scrollHeight > element.clientHeight + 1;
    if (clips && overflows) clippedStatuses.push(nameOf(element));
  }

  const directions: { text: string; direction: string; textAlign: string }[] = [];
  if (options.rtl) {
    for (const element of shell.querySelectorAll('*')) {
      const ownText = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join('')
        .trim();
      if (!/[؀-ۿ]/.test(ownText) || !isVisible(element)) continue;
      directions.push({
        text: ownText.slice(0, 40),
        direction: element.matches(':dir(rtl)') ? 'rtl' : 'ltr',
        textAlign: getComputedStyle(element).textAlign,
      });
    }
  }

  const composer =
    shell.querySelector('.chat-input-area > .chat-input-shell') ??
    shell.querySelector('.chat-input-area');
  const transcript = shell.querySelector('.chat-timeline');
  const jump = shell.querySelector('.chat-jump-button, .chat-new-indicator');
  return {
    documentWidth: {
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    },
    smallTargets,
    controlGeometry,
    occlusions,
    bottomChrome,
    pendingHighlights: shell.querySelectorAll('[data-cinder-highlight-state="pending"]').length,
    clippedStatuses,
    directions,
    jumpOverlapsTranscript:
      transcript !== null &&
      jump !== null &&
      isVisible(jump) &&
      jump.getBoundingClientRect().top < transcript.getBoundingClientRect().bottom,
    approvalStillWaiting:
      options.settledApproval &&
      (shell.querySelector('[data-chat-approval-drawer]') !== null ||
        [...shell.querySelectorAll('.chat-tool-call-summary')].some((summary) =>
          summary.textContent.includes('waiting for approval'),
        )),
    composerEdge:
      composer === null ? null : Math.round(composer.getBoundingClientRect().bottom * 100) / 100,
  };
}

type WithdrawalWindow = Window & { stressAnnouncements?: number };

/** Runs in the page: observes changes to live regions after a source is withdrawn. */
function observeAnnouncements(): void {
  const host = window as WithdrawalWindow;
  const regions = new Map<Element, string>();
  const scan = (): void => {
    for (const region of document.querySelectorAll(
      '[aria-live], [role="status"], [role="alert"]',
    )) {
      const message = (region.textContent ?? '').trim();
      if (message === 'Sources were removed' && regions.get(region) !== message) {
        host.stressAnnouncements = (host.stressAnnouncements ?? 0) + 1;
      }
      regions.set(region, message);
    }
  };
  scan();
  host.stressAnnouncements = 0;
  new MutationObserver(scan).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
}

/** Runs in the page: checks that the action has a rendered focus ring and the citation closed. */
export function readWithdrawal(): { announcements: number; focusVisible: boolean } {
  const host = window as WithdrawalWindow;
  const active = document.activeElement;
  const shell = document.querySelector('[data-testid="chat-stress-shell"]');
  const style = active === null ? undefined : getComputedStyle(active);
  const hasPaint = (pseudo: '::before' | '::after'): boolean => {
    if (active === null) return false;
    const pseudoStyle = getComputedStyle(active, pseudo);
    const content = pseudoStyle.content;
    const opacity = Number.parseFloat(pseudoStyle.opacity);
    const visibility = pseudoStyle.visibility;
    const display = pseudoStyle.display;
    return (
      content !== 'none' &&
      content !== 'normal' &&
      opacity > 0 &&
      visibility !== 'hidden' &&
      display !== 'none' &&
      (pseudoStyle.boxShadow !== 'none' ||
        pseudoStyle.outlineStyle !== 'none' ||
        pseudoStyle.backgroundColor !== 'rgba(0, 0, 0, 0)')
    );
  };
  const focusPainted =
    style?.boxShadow !== 'none' ||
    style?.outlineStyle !== 'none' ||
    hasPaint('::before') ||
    hasPaint('::after');
  const box = active?.getBoundingClientRect();
  const focusVisible =
    active?.matches('.chat-message-action-button') === true &&
    shell?.contains(active) === true &&
    focusPainted &&
    box !== undefined &&
    box.width > 0 &&
    box.bottom > 0 &&
    box.top < innerHeight &&
    document.querySelector('.cinder-citation__panel') === null;
  return { announcements: host.stressAnnouncements ?? 0, focusVisible };
}

function readApprovalReceiptFits(): boolean {
  const receipt = document.querySelector('.chat-message-status .cinder-approval-card__receipt');
  const card = receipt?.closest('.cinder-approval-card');
  const slot = receipt?.closest('.chat-message-status');
  return (
    card !== null &&
    card !== undefined &&
    slot !== null &&
    slot !== undefined &&
    card.getBoundingClientRect().width >= slot.getBoundingClientRect().width - 1
  );
}

/** Runs in the page: scrolls the transcript, the first scrolling box inside the shell, to an end. */
function scrollTranscript(to: 'top' | 'bottom'): void {
  const shell = document.querySelector('[data-testid="chat-stress-shell"]') ?? document.body;
  for (const element of shell.querySelectorAll('*')) {
    const style = getComputedStyle(element);
    const scrolls = style.overflowY === 'auto' || style.overflowY === 'scroll';
    if (scrolls && element.scrollHeight > element.clientHeight + 1) {
      element.scrollTop = to === 'top' ? 0 : element.scrollHeight;
      return;
    }
  }
}

/** Runs in the page: marks the focused control and says whether it is a new stop inside the shell. */
function readFocusStop(): { inside: boolean; fresh: boolean; name: string } {
  const active = document.activeElement;
  const shell = document.querySelector('[data-testid="chat-stress-shell"]');
  if (active === null || shell === null || !shell.contains(active) || active === shell) {
    return { inside: false, fresh: false, name: '' };
  }
  const fresh = !active.hasAttribute('data-stress-focus-stop');
  active.setAttribute('data-stress-focus-stop', '');
  const name = (
    active.getAttribute('aria-label') ??
    active.textContent ??
    active.getAttribute('placeholder') ??
    active.getAttribute('title') ??
    ''
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return { inside: true, fresh, name: name === '' ? active.tagName.toLowerCase() : name };
}

function callHook(page: Page, name: string, argument: unknown): Promise<void> {
  const argumentsList = Array.isArray(argument)
    ? argument
    : argument === undefined
      ? []
      : [argument];
  return page.evaluate(
    ([hookName, hookArguments]) => {
      const hooks = (window as Window & { corvidaeChatStress?: Hooks }).corvidaeChatStress;
      const hook = hooks?.[hookName];
      if (hook === undefined) throw new Error(`The page has no host operation named ${hookName}.`);
      hook(...(hookArguments as unknown[]));
    },
    [name, argumentsList] as const,
  );
}

export function locate(page: Page, step: Extract<StressStep, { role: string }>) {
  const scope = 'scope' in step ? step.scope : undefined;
  const root = scope === undefined ? page : page.locator(scope);
  return root.getByRole(step.role as Role, { name: step.name }).nth(step.nth ?? 0);
}

export async function runStep(page: Page, step: StressStep): Promise<void> {
  switch (step.action) {
    case 'click':
      await locate(page, step).click({ timeout: DEADLINE });
      return;
    case 'fill':
      await locate(page, step).fill(step.text, { timeout: DEADLINE });
      return;
    case 'focus':
      await locate(page, step).focus({ timeout: DEADLINE });
      return;
    case 'focus-source':
      await page
        .locator('[data-chat-sources-trigger] .cinder-citation__marker')
        .first()
        .focus({ timeout: DEADLINE });
      await page
        .locator('[data-chat-sources-trigger] .cinder-citation__marker')
        .first()
        .evaluate((element) => {
          if (document.activeElement !== element)
            throw new Error('Source marker did not receive focus.');
        });
      return;
    case 'expect-source-open':
      await page.locator('.cinder-citation__panel').first().waitFor({
        state: 'visible',
        timeout: DEADLINE,
      });
      return;
    case 'press':
      await page.keyboard.press(step.key);
      return;
    case 'hook':
      await callHook(page, step.name, step.argument);
      return;
    case 'expect':
      await locate(page, step).waitFor({ state: 'visible', timeout: DEADLINE });
      return;
    case 'expect-text':
      await (step.scope === undefined ? page : page.locator(step.scope))
        .getByText(step.text, { exact: step.exact === true })
        .first()
        .waitFor({ state: 'visible', timeout: DEADLINE });
      return;
    case 'expect-offscreen':
      await page.waitForFunction(
        (selector) => {
          const element = document.querySelector(selector);
          if (element === null) return false;
          const box = element.getBoundingClientRect();
          let left = Math.max(0, box.left);
          let top = Math.max(0, box.top);
          let right = Math.min(innerWidth, box.right);
          let bottom = Math.min(innerHeight, box.bottom);
          let ancestor = element.parentElement;
          while (ancestor !== null) {
            const style = getComputedStyle(ancestor);
            if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflow)) {
              const clip = ancestor.getBoundingClientRect();
              left = Math.max(left, clip.left + ancestor.clientLeft);
              top = Math.max(top, clip.top + ancestor.clientTop);
              right = Math.min(right, clip.left + ancestor.clientWidth);
              bottom = Math.min(bottom, clip.top + ancestor.clientHeight);
            }
            ancestor = ancestor.parentElement;
          }
          return right <= left || bottom <= top;
        },
        step.selector,
        { timeout: DEADLINE },
      );
      return;
    case 'expect-absent':
      await page.locator(step.selector).first().waitFor({ state: 'hidden', timeout: DEADLINE });
      return;
    case 'upload':
      await page
        .locator('input[type="file"]')
        .first()
        .setInputFiles(
          step.files.map((file) => ({
            name: file.name,
            mimeType: file.mimeType,
            buffer: Buffer.alloc(file.bytes),
          })),
          { timeout: DEADLINE },
        );
      return;
    case 'scroll':
      await page.evaluate(scrollTranscript, step.to);
      return;
    default: {
      const unreachable: never = step;
      throw new Error(`Unknown step ${JSON.stringify(unreachable)}.`);
    }
  }
}

/** One page of a case at a profile, with the errors it collected. */
interface OpenCase {
  readonly page: Page;
  readonly errors: string[];
}

async function openCase(
  context: BrowserContext,
  origin: string,
  stressCase: StressCase,
): Promise<OpenCase> {
  const startTime = new Date(STRESS_NOW);
  // Expiry needs both the clock and the deadline callbacks to advance. Its isolated context
  // leaves the ordinary captures on a fixed instant with real browser timers.
  if (
    stressCase.slug === 'approval-expired' ||
    stressCase.slug === 'loading-slow' ||
    stressCase.slug === 'loading-canceled'
  )
    await context.clock.install({ time: startTime });
  else await context.clock.setFixedTime(startTime);
  const page = await context.newPage();
  page.setDefaultTimeout(DEADLINE);
  page.setDefaultNavigationTimeout(DEADLINE);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // The broken-image cases load an address the server does not have on purpose.
    if (stressCase.scenario === 'images' && message.text().includes('Failed to load resource'))
      return;
    errors.push(message.text());
  });
  await page.goto(`${origin}/page/chat-stress?case=${stressCase.id}`, { waitUntil: 'load' });
  await page
    .locator('[data-chat-stress-ready="true"], [data-chat-stress-error]')
    .first()
    .waitFor({ state: 'attached', timeout: DEADLINE });
  const failure = page.locator('[data-chat-stress-error]');
  if ((await failure.count()) > 0) throw new Error(await failure.first().innerText());
  return { page, errors };
}

async function runSteps(opened: OpenCase, stressCase: StressCase, steps: readonly StressStep[]) {
  if (stressCase.slug === 'loading-slow' || stressCase.slug === 'loading-canceled') {
    await opened.page.clock.fastForward(1_000);
  }
  if (stressCase.slug === 'approval-expired') {
    await opened.page
      .getByText('1 waiting for approval', { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: DEADLINE });
    await opened.page.locator('.cinder-approval-card').first().waitFor({
      state: 'visible',
      timeout: DEADLINE,
    });
    await opened.page.clock.fastForward(31_000);
    await opened.page.waitForFunction(
      () => {
        const card = document.querySelector('.cinder-approval-card');
        const summaries = [...document.querySelectorAll('.chat-tool-call-summary')];
        return (
          card?.textContent?.toLowerCase().includes('expired') === true &&
          summaries.some((summary) => summary.textContent?.includes('1 expired')) &&
          summaries.every((summary) => !summary.textContent?.includes('waiting for approval'))
        );
      },
      undefined,
      { timeout: DEADLINE },
    );
  }
  for (const step of steps) {
    // Count announcements from the moment the host withdraws the source, not before.
    if (stressCase.id === 45 && step.action === 'hook' && step.name === 'withdrawSource') {
      await opened.page.evaluate(observeAnnouncements);
    }
    await runStep(opened.page, step);
  }
  if (stressCase.slug === 'approval-expired') {
    await opened.page.getByRole('button', { name: 'Ask again' }).waitFor({
      state: 'visible',
      timeout: DEADLINE,
    });
  }
  await opened.page.waitForFunction(
    () => document.querySelector('[data-cinder-highlight-state="pending"]') === null,
    undefined,
    { timeout: DEADLINE },
  );
}

async function measure(
  opened: OpenCase,
  stressCase: StressCase,
  profile: StressProfile,
): Promise<{ measurement: PageMeasurement; problems: string[] }> {
  const inPage = await opened.page.evaluate(measureInPage, {
    coarse: profile.coarse,
    rtl: stressCase.direction === 'rtl',
    settledApproval:
      stressCase.slug === 'approval-expired' || stressCase.slug === 'approval-receipt',
  });
  const withdrawal = stressCase.id === 45 ? await opened.page.evaluate(readWithdrawal) : undefined;
  const measurement: PageMeasurement = {
    ...inPage,
    geometry: await measureGeometry(opened.page),
    pageErrors: opened.errors,
    ...(withdrawal === undefined ? {} : { withdrawal }),
    ...(stressCase.id === 55
      ? { approvalReceiptFits: await opened.page.evaluate(readApprovalReceiptFits) }
      : {}),
  };
  return { measurement, problems: measurementProblems(measurement, profile, stressCase) };
}

interface RunState {
  readonly directory: string;
  readonly origin: string;
  readonly records: CaptureRecord[];
  readonly errors: string[];
}

function renderInteractionGeometryReport(records: readonly CaptureRecord[]): string {
  const lines = [
    '# Chat stress geometry report',
    '',
    'Metrics are recorded from the same page state as each frame. Bottom-chrome share is evidence only; it is not a universal pass/fail threshold.',
    '',
    '| Frame | Controls (hit → reachable) | Occlusions | Pending highlights | Bottom chrome |',
    '| --- | --- | ---: | ---: | ---: |',
  ];
  for (const record of records) {
    const measurement = record.measurement;
    if (measurement === undefined) continue;
    const occlusions = measurement.occlusions ?? [];
    const chrome = measurement.bottomChrome;
    const details = occlusions.map((entry) => `${entry.target} ← ${entry.overlay}`).join(', ');
    const controls = (measurement.controlGeometry ?? [])
      .map(
        (control) =>
          `${control.name}: ${control.hitWidth}×${control.hitHeight} → ${control.reachableWidth}×${control.reachableHeight}`,
      )
      .join('<br>');
    lines.push(
      `| ${record.file}${details === '' ? '' : ` (${details})`} | ${controls === '' ? 'none' : controls} | ${occlusions.length} | ${measurement.pendingHighlights ?? 0} | ${chrome === undefined ? 'n/a' : `${Math.round(chrome.share * 10000) / 100}% (${chrome.height}px)`} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function renderCraftGeometryArtifacts(records: readonly CaptureRecord[]): {
  readonly report: string;
  readonly findings: object;
} {
  const findings: GeometryFinding[] = [];
  let measured = 0;
  let coarse = 0;
  let unscaled = 0;
  for (const record of records) {
    const facts = record.measurement?.geometry;
    if (facts === undefined) continue;
    measured += 1;
    if (facts.pointerCoarse) coarse += 1;
    if (facts.spaceScale.length < 3) unscaled += 1;
    const capture: GeometryCapture = {
      route: '/chat-stress',
      state: `case ${caseLabel(record.caseId)}${record.variant === undefined ? '' : ` (${record.variant})`}`,
      source: 'chat-stress',
      width: facts.viewport.width,
      colorScheme: record.profile.endsWith('-dark') ? 'dark' : 'light',
      viewport: record.file,
    };
    findings.push(...auditCapture(facts, capture));
  }
  const coverage = { captures: records.length, measured, coarse, unscaled } as const;
  const consolidated = consolidateFindings(findings);
  return {
    report: renderCraftGeometryReport(consolidated, coverage),
    findings: { coverage, thresholds: GEOMETRY_THRESHOLDS, findings: consolidated },
  };
}

/** Takes one image of a case: a fresh page, the steps, the picture and its measurement. */
async function captureImage(
  state: RunState,
  context: BrowserContext,
  profile: StressProfile,
  stressCase: StressCase,
  image: { kind: 'primary' | 'variant'; variant?: string; steps: readonly StressStep[] },
): Promise<number | null> {
  const file =
    image.kind === 'primary'
      ? primaryImageName(profile, stressCase.id)
      : variantImageName(profile, stressCase.id, image.variant ?? '');
  const label = `case ${caseLabel(stressCase.id)} at ${profile.name}${image.variant === undefined ? '' : ` ${image.variant}`}`;
  let problems: string[] = [];
  let edge: number | null = null;
  let measurement: PageMeasurement | undefined;
  let opened: OpenCase | undefined;
  try {
    opened = await openCase(context, state.origin, stressCase);
    await runSteps(opened, stressCase, image.steps);
    const measured = await measure(opened, stressCase, profile);
    problems = measured.problems;
    measurement = measured.measurement;
    edge = measured.measurement.composerEdge;
  } catch (error) {
    problems = [`flow failed: ${error instanceof Error ? error.message : String(error)}`];
  }
  let written = false;
  if (opened !== undefined) {
    try {
      await opened.page.screenshot({
        path: join(state.directory, file),
        animations: 'disabled',
        caret: 'hide',
        timeout: DEADLINE,
      });
      written = true;
    } catch (error) {
      problems = [
        ...problems,
        `screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
    await opened.page.close();
  }
  for (const problem of problems) state.errors.push(`${label}: ${problem}`);
  if (written) {
    state.records.push({
      caseId: stressCase.id,
      profile: profile.name,
      kind: image.kind,
      ...(image.variant === undefined ? {} : { variant: image.variant }),
      file,
      problems,
      ...(measurement === undefined ? {} : { measurement }),
      ...(stressCase.deferred === undefined ? {} : { deferred: stressCase.deferred }),
    });
  }
  return edge;
}

/** Tabs through the case's controls and takes one image per stop, which is the per-control focus sweep. */
async function captureFocusSweep(
  state: RunState,
  context: BrowserContext,
  profile: StressProfile,
  stressCase: StressCase,
): Promise<void> {
  let opened: OpenCase | undefined;
  try {
    opened = await openCase(context, state.origin, stressCase);
    await runSteps(opened, stressCase, stressCase.steps);
    await opened.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (let index = 1; ; index += 1) {
      await opened.page.keyboard.press('Tab');
      const stop = await opened.page.evaluate(readFocusStop);
      if (!stop.inside || !stop.fresh) break;
      const variant = focusVariantName(index);
      const file = variantImageName(profile, stressCase.id, variant);
      const measured = await measure(opened, stressCase, profile);
      if (measured.problems.length > 0) {
        state.errors.push(
          `case ${caseLabel(stressCase.id)} at ${profile.name} ${variant}: ${measured.problems.join('; ')}`,
        );
      }
      await opened.page.screenshot({
        path: join(state.directory, file),
        animations: 'disabled',
        caret: 'hide',
        timeout: DEADLINE,
      });
      state.records.push({
        caseId: stressCase.id,
        profile: profile.name,
        kind: 'focus',
        variant,
        file,
        focus: { index, name: stop.name },
        problems: measured.problems,
        measurement: measured.measurement,
      });
    }
  } catch (error) {
    state.errors.push(
      `case ${caseLabel(stressCase.id)} at ${profile.name} focus sweep: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await opened?.page.close();
  }
}

async function captureProfile(
  state: RunState,
  browser: Browser,
  profile: StressProfile,
  cases: readonly StressCase[],
): Promise<void> {
  async function openContext() {
    const context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
      deviceScaleFactor: 1,
      colorScheme: profile.theme,
      reducedMotion: 'reduce',
      hasTouch: profile.coarse,
      isMobile: profile.coarse,
      locale: 'en-US',
      timezoneId: 'America/Chicago',
      baseURL: state.origin,
    });
    await context.addInitScript(
      ([key, value]) => {
        try {
          localStorage.setItem(key, value);
        } catch {
          // A blocked storage leaves the default theme, which the profile's color scheme matches.
        }
      },
      [THEME_STORAGE_KEY, profile.theme] as const,
    );
    return context;
  }
  const context = await openContext();
  try {
    const edges = new Map<number, number | null>();
    for (const stressCase of cases) {
      const caseContext = stressCase.slug === 'approval-expired' ? await openContext() : context;
      try {
        edges.set(
          stressCase.id,
          await captureImage(state, caseContext, profile, stressCase, {
            kind: 'primary',
            steps: stressCase.steps,
          }),
        );
        for (const variant of stressCase.variants) {
          await captureImage(state, caseContext, profile, stressCase, {
            kind: 'variant',
            variant: variant.name,
            steps: variant.steps,
          });
        }
        if (stressCase.focusSweep) await captureFocusSweep(state, caseContext, profile, stressCase);
      } finally {
        if (caseContext !== context) await caseContext.close();
      }
    }
    state.errors.push(...composerEdgeProblems(cases, profile, edges));
  } finally {
    await context.close();
  }
}

function git(arguments_: string[]): string {
  const result = Bun.spawnSync(['git', ...arguments_], {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.stdout.toString();
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function readIdentity(buildDirectory: string): Promise<SourceIdentity> {
  const entries = await readdir(buildDirectory, { recursive: true });
  const files = entries.map(String).toSorted();
  const index = await Bun.file(join(buildDirectory, 'index.html')).text();
  return sourceIdentity({
    head: git(['rev-parse', 'HEAD']).trim(),
    changesDigest: digest(`${git(['status', '--porcelain'])}\0${git(['diff', 'HEAD'])}`),
    buildDigest: digest(`${files.join('\n')}\0${index}`),
    bunVersion: Bun.version,
  });
}

function usage(message: string): never {
  console.error(
    `${message}\nUsage: capture-chat-stress.ts [--out <directory>] [--cases 9,10,14-15] [--profiles 1440-light]`,
  );
  process.exit(2);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      out: { type: 'string' },
      cases: { type: 'string' },
      profiles: { type: 'string' },
    },
    strict: true,
  });
  const supplemental = environmentConfiguration().chatStressSupplemental;
  const allCases = parseStressCases(casesData);
  let cases: StressCase[];
  try {
    cases = selectCases(allCases, values.cases);
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  let profiles = profilesFor(supplemental);
  if (values.profiles !== undefined) {
    const names = values.profiles.split(',').map((name) => name.trim());
    const unknown = names.filter((name) => !profiles.some((profile) => profile.name === name));
    if (unknown.length > 0) return usage(`Unknown profiles: ${unknown.join(', ')}.`);
    profiles = profiles.filter((profile) => names.includes(profile.name));
  }

  const outputRoot = resolve(values.out ?? join(repositoryRoot, 'tmp', 'chat-stress'));
  await mkdir(outputRoot, { recursive: true });
  const directory = await mkdtemp(join(outputRoot, RUN_DIRECTORY_PREFIX));

  // Build the host into this run's own directory, so no other server's rebuild can change it.
  await prepareManifest();
  const buildDirectory = join(directory, 'build');
  await buildBrowser({
    entrypoints: [resolve(fixtureRoot, 'index.html')],
    outdir: buildDirectory,
    development: false,
  });
  const identity = await readIdentity(buildDirectory);
  await writeFile(
    join(directory, 'source-identity.json'),
    `${JSON.stringify(identity, null, 2)}\n`,
  );

  const server = createFixtureServer({
    port: 0,
    outputDirectory: buildDirectory,
    manifestPath: resolve(fixtureRoot, '.playwright', 'manifest.json'),
    development: false,
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const state: RunState = { directory, origin, records: [], errors: [] };
  let browser: Browser | undefined;
  try {
    // Ready means the host answers and serves the Chat stress page from this build.
    const ready = await fetch(`${origin}/ready`);
    const manifestResponse = await fetch(`${origin}/api/manifest`);
    const manifest = (await manifestResponse.json()) as {
      entries: { slug: string }[];
    };
    if (!ready.ok || !manifest.entries.some((entry) => entry.slug === 'chat-stress')) {
      throw new Error('The fixture host is not ready to serve the Chat stress fixture.');
    }
    browser = await chromium.launch();
    for (const profile of profiles) await captureProfile(state, browser, profile, cases);
  } catch (error) {
    state.errors.push(`run failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await browser?.close();
    await server.stop(true);
  }

  const records = state.records.toSorted(
    (left, right) =>
      left.caseId - right.caseId ||
      left.profile.localeCompare(right.profile) ||
      left.file.localeCompare(right.file),
  );
  const errors = [...state.errors, ...countProblems(records, cases, profiles)];
  const captured = await readdir(directory);
  const files = captured.filter((name) => name.endsWith('.png'));
  const summary: RunSummary = {
    passed: false,
    complete: cases.length === allCases.length && profiles.length >= 4,
    runDirectory: directory,
    identity,
    cases: cases.length,
    profiles: profiles.map((profile) => profile.name),
    counts: {
      primary: records.filter((record) => record.kind === 'primary').length,
      fixedVariants: records.filter((record) => record.kind === 'variant').length,
      focus: records.filter((record) => record.kind === 'focus').length,
      total: records.length,
    },
    deferred: cases
      .filter((stressCase) => stressCase.deferred !== undefined)
      .map((stressCase) => ({ caseId: stressCase.id, reason: stressCase.deferred ?? '' })),
    errors,
  };
  // The gallery is written first so the reconciliation can read back what it shows.
  const provisional = { ...summary, passed: errors.length === 0 };
  const gallery = renderGallery(records, cases, provisional);
  await writeFile(join(directory, 'gallery.html'), gallery);
  const reconciliation = reconciliationProblems(records, files, galleryImageFiles(gallery));
  const allErrors = [...errors, ...reconciliation];
  const finalSummary: RunSummary = {
    ...summary,
    passed: allErrors.length === 0,
    errors: allErrors,
  };
  await writeFile(join(directory, 'gallery.html'), renderGallery(records, cases, finalSummary));
  await writeFile(
    join(directory, 'manifest.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  const craftGeometry = renderCraftGeometryArtifacts(records);
  await writeFile(
    join(directory, 'interaction-geometry-report.md'),
    renderInteractionGeometryReport(records),
  );
  await writeFile(join(directory, 'geometry-report.md'), craftGeometry.report);
  await writeFile(
    join(directory, 'geometry-findings.json'),
    `${JSON.stringify(craftGeometry.findings, null, 2)}\n`,
  );
  await writeFile(join(directory, 'summary.json'), `${JSON.stringify(finalSummary, null, 2)}\n`);

  console.log(
    `${finalSummary.passed ? 'passed' : 'FAILED'}: ${finalSummary.counts.total} images (${finalSummary.counts.primary} primary, ${finalSummary.counts.fixedVariants} variants, ${finalSummary.counts.focus} focus) in ${directory}`,
  );
  for (const error of allErrors) console.error(error);
  return finalSummary.passed ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
