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
import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
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
  composerTopProblems,
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
// CSSOM scrollport edges are integer-rounded while getBoundingClientRect() preserves fractional
// layout coordinates. Allow only that subpixel rounding at a row edge; controls must still fit.
const ROW_EDGE_EPSILON = 0.5;
const expectAttachment = expect.configure({ timeout: DEADLINE });

/** The capture contract, kept here so it independently checks the responsive component contract. */
function expectedAttachmentShelfCap(width: number, height: number): number {
  if (width <= 480 && height <= 700) return 1;
  if (width <= 480 && height <= 860) return 2;
  return 2;
}

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
  const reachableBox = (
    element: Element,
    box: DOMRect,
    scrollersOnly = false,
  ): DOMRect | undefined => {
    if (modalBackground(element)) return undefined;
    // A hit-area probe skips only what a person can scroll out of view; a parent that clips with
    // `overflow: hidden` or `clip` really cuts the hit area off.
    const clippingValues = scrollersOnly
      ? ['auto', 'scroll']
      : ['hidden', 'clip', 'auto', 'scroll'];
    let left = Math.max(0, box.left);
    let top = Math.max(0, box.top);
    let right = Math.min(innerWidth, box.right);
    let bottom = Math.min(innerHeight, box.bottom);
    let ancestor = element.parentElement;
    while (ancestor !== null && ancestor !== shell.parentElement) {
      const style = getComputedStyle(ancestor);
      const clipX =
        clippingValues.includes(style.overflow) || clippingValues.includes(style.overflowX);
      const clipY =
        clippingValues.includes(style.overflow) || clippingValues.includes(style.overflowY);
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

  const smallTargets: {
    name: string;
    width: number;
    height: number;
    shortSides: string[];
  }[] = [];
  const controlGeometry: {
    controlId: string;
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
    // Every visible control's centre, disabled ones too: adjacent compact controls overlap their
    // hit areas by design, so a probe nearer to a neighbour's centre belongs to the neighbour.
    const controlCentres = controls
      .filter((element) => isVisible(element))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { element, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
    // Cinder and Chat paint a control compact and extend its hit area with a positioned
    // pseudo-element that takes no layout, so the touch target is what a tap reaches, not the box.
    const probeHitArea = (element: HTMLElement, centreX: number, centreY: number): string[] => {
      // A 44px hit area ends exactly 22px from the centre and its far edge is exclusive, so the
      // probe sits half a pixel inside it.
      const reach = 21.5;
      const sides: ['left' | 'right' | 'above' | 'below', number, number][] = [
        ['left', centreX - reach, centreY],
        ['right', centreX + reach, centreY],
        ['above', centreX, centreY - reach],
        ['below', centreX, centreY + reach],
      ];
      const short: string[] = [];
      for (const [side, x, y] of sides) {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        // A point scrolled out of a scroller's visible box cannot be tapped at all.
        if (reachableBox(element, new DOMRect(x, y, 1, 1), true) === undefined) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit === null || hit === element || element.contains(hit)) continue;
        const nearerToANeighbour = controlCentres.some(
          (other) =>
            other.element !== element &&
            !other.element.contains(element) &&
            !element.contains(other.element) &&
            Math.hypot(other.x - x, other.y - y) < reach,
        );
        if (nearerToANeighbour) continue;
        // A point that reaches another control (its face or its own hit area) is that control's
        // tap, which its own probe covers. The distance test above is centre to centre and a
        // neighbour's area is wider than the probe radius, so it stays only as the cheap case.
        const reachedControl = hit.closest(
          'button, [role="button"], [role="radio"], [role="checkbox"], a[href], textarea, select, summary',
        );
        if (
          reachedControl !== null &&
          reachedControl !== element &&
          !reachedControl.contains(element) &&
          !element.contains(reachedControl)
        ) {
          continue;
        }
        // A fixed or sticky surface (the composer, a docked bar) legitimately covers part of the
        // area while content scrolls under it; the occlusion guard owns that case.
        let overlay: Element | null = hit;
        let coveredByOverlay = false;
        while (overlay !== null && overlay !== document.body) {
          const position = getComputedStyle(overlay).position;
          if ((position === 'fixed' || position === 'sticky') && !overlay.contains(element)) {
            coveredByOverlay = true;
            break;
          }
          overlay = overlay.parentElement;
        }
        if (coveredByOverlay) continue;
        short.push(`${side} (reaches ${nameOf(hit) || hit.tagName.toLowerCase()})`);
      }
      return short;
    };
    for (const [index, element] of controls.entries()) {
      if (!isVisible(element) || element.getAttribute('aria-hidden') === 'true') continue;
      if ((element as HTMLButtonElement).disabled) continue;
      // A link inside a sentence is sized by its text, not by the touch target rule.
      if (element.matches('a') && element.closest('p, li, td') !== null) continue;
      const box = element.getBoundingClientRect();
      if (box.bottom <= 0 || box.top >= innerHeight) continue;
      const reachable = reachableBox(element, box);
      if (reachable === undefined) continue;
      const controlId = `control-${index}`;
      element.dataset['chatStressControlId'] = controlId;
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
        controlId,
        name: nameOf(element),
        hitWidth: Math.round(box.width * 100) / 100,
        hitHeight: Math.round(box.height * 100) / 100,
        paintedWidth: Math.round(painted.width * 100) / 100,
        paintedHeight: Math.round(painted.height * 100) / 100,
        reachableWidth: Math.round(reachable.width * 100) / 100,
        reachableHeight: Math.round(reachable.height * 100) / 100,
        // A partially clipped control still needs a real hit-test. The points are based on the
        // reachable intersection above, so an offscreen portion cannot make the evidence vanish.
        samples: samplePoints.map(([x, y]) => ({
          x: Math.round(x * 100) / 100,
          y: Math.round(y * 100) / 100,
          top: topAt(x, y),
          hitsTarget: hitTargetAt(element, x, y),
        })),
      });
      // A control whose own centre does not reach it is covered whole; the sample and occlusion
      // evidence above names that, and no side of it can be probed.
      const centreX = box.left + box.width / 2;
      const centreY = box.top + box.height / 2;
      if (!hitTargetAt(element, centreX, centreY)) continue;
      const shortSides = probeHitArea(element, centreX, centreY);
      if (shortSides.length > 0) {
        smallTargets.push({
          name: nameOf(element),
          width: Math.round(box.width),
          height: Math.round(box.height),
          shortSides,
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

  const composer = shell.querySelector<HTMLElement>('.chat-input-area');
  const visibleQuestionDock = [
    ...shell.querySelectorAll<HTMLElement>('[data-chat-question-dock]'),
  ].find(isVisible);
  const visibleInputShell = [...shell.querySelectorAll<HTMLElement>('.chat-input-shell')].find(
    isVisible,
  );
  const composerShell = visibleQuestionDock ?? visibleInputShell ?? composer;
  const composerForm = shell.querySelector<HTMLElement>('.chat-input-area form.chat-input');
  const transcript = shell.querySelector('.chat-timeline');
  const jump = shell.querySelector('.chat-jump-button, .chat-new-indicator');
  const transcriptBox = transcript?.getBoundingClientRect();
  const transcriptStyle = transcript === null ? undefined : getComputedStyle(transcript);
  const composerBox = composerShell?.getBoundingClientRect();
  const readingEdges =
    transcriptBox !== undefined &&
    transcriptStyle !== undefined &&
    composerBox !== undefined &&
    composer !== null &&
    isVisible(composer) &&
    transcript !== null &&
    isVisible(transcript) &&
    transcriptBox.width > 0
      ? {
          transcriptLeft:
            Math.round(
              (transcriptBox.left + Number.parseFloat(transcriptStyle.paddingLeft)) * 100,
            ) / 100,
          transcriptRight:
            Math.round(
              (transcriptBox.right - Number.parseFloat(transcriptStyle.paddingRight)) * 100,
            ) / 100,
          composerLeft: Math.round(composerBox.left * 100) / 100,
          composerRight: Math.round(composerBox.right * 100) / 100,
        }
      : undefined;
  const wideLayout: NonNullable<InPageMeasurement['wideLayout']>[number][] = [];
  for (const node of shell.querySelectorAll<HTMLElement>(
    '.message-content-wide, .tool-payload-code',
  )) {
    if (!isVisible(node)) continue;
    const frame =
      node.querySelector<HTMLElement>('.message-markdown-table-frame, .cinder-code-block') ?? node;
    const frameBox = frame.getBoundingClientRect();
    const clippingAncestors: string[] = [];
    let ancestor = node.parentElement;
    while (ancestor !== null && ancestor !== shell.parentElement) {
      const style = getComputedStyle(ancestor);
      const clipsInline = ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX);
      if (clipsInline) {
        const clip = ancestor.getBoundingClientRect();
        const left = clip.left + ancestor.clientLeft;
        const right = left + ancestor.clientWidth;
        if (frameBox.left < left - 1 || frameBox.right > right + 1) {
          const label = `${ancestor.tagName.toLowerCase()}${ancestor.className ? `.${ancestor.className.split(/\s+/u).join('.')}` : ''}`;
          clippingAncestors.push(label);
        }
      }
      ancestor = ancestor.parentElement;
    }
    const scroller = node.querySelector<HTMLElement>(
      '.message-markdown-table-scroller, .cinder-code-block__viewport',
    );
    const scrollerBox = scroller?.getBoundingClientRect();
    const firstCell = scroller?.querySelector<HTMLElement>('tr > :first-child');
    const details = node.closest<HTMLElement>('.chat-tool-call-details');
    const detailsStyle = details === null ? undefined : getComputedStyle(details);
    const detailsContentWidth =
      details === null || detailsStyle === undefined
        ? undefined
        : details.clientWidth -
          Number.parseFloat(detailsStyle.paddingInlineStart) -
          Number.parseFloat(detailsStyle.paddingInlineEnd);
    wideLayout.push({
      node:
        node.dataset['cinderMarkdownNode'] ??
        (node.classList.contains('tool-payload-code') ? 'tool-payload-code' : 'wide-content'),
      ancestors: [
        node.parentElement,
        node.parentElement?.parentElement,
        node.parentElement?.parentElement?.parentElement,
      ]
        .filter((element): element is HTMLElement => element instanceof HTMLElement)
        .map((element) => ({
          name: element.className || element.tagName.toLowerCase(),
          width: Math.round(element.getBoundingClientRect().width * 100) / 100,
        })),
      frame: {
        left: Math.round(frameBox.left * 100) / 100,
        right: Math.round(frameBox.right * 100) / 100,
        width: Math.round(frameBox.width * 100) / 100,
      },
      ...(detailsContentWidth === undefined
        ? {}
        : {
            contentWidthGap: Math.max(
              0,
              Math.round((detailsContentWidth - frameBox.width) * 100) / 100,
            ),
          }),
      ...(scrollerBox === undefined || scroller === null
        ? {}
        : {
            scroller: {
              left: Math.round(scrollerBox.left * 100) / 100,
              right: Math.round(scrollerBox.right * 100) / 100,
              scrollLeft: Math.round(scroller.scrollLeft * 100) / 100,
            },
          }),
      clippingAncestors,
      leadingColumnClipped:
        scroller !== null &&
        firstCell != null &&
        scrollerBox !== undefined &&
        scroller.scrollLeft <= 1 &&
        firstCell.getBoundingClientRect().left < scrollerBox.left - 1,
    });
  }
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
      composerShell === null
        ? null
        : Math.round(composerShell.getBoundingClientRect().bottom * 100) / 100,
    composerTop:
      composerForm === null
        ? null
        : Math.round(composerForm.getBoundingClientRect().top * 100) / 100,
    ...(composer === null
      ? {}
      : (() => {
          const composerStyle = getComputedStyle(composer);
          const override = Number.parseFloat(
            composerStyle.getPropertyValue('--_cinder-chat-safe-area-inset-bottom'),
          );
          return {
            safeArea: {
              inset: Number.isFinite(override) ? override : 0,
              paddingBottom: Number.parseFloat(composerStyle.paddingBlockEnd),
            },
          };
        })()),
    ...(readingEdges === undefined ? {} : { readingEdges }),
    wideLayout,
  };
}

/** Proves a partially clipped control can be revealed and hit without changing the saved frame. */
export function revealScrollableControls(controlIds: readonly string[] = []): {
  controlId: string;
  name: string;
  initiallyClipped: boolean;
  originalBox: { left: number; top: number; right: number; bottom: number };
  revealedBox: { left: number; top: number; right: number; bottom: number };
  revealed: boolean;
  samplesHitTarget: boolean;
}[] {
  const controls = [
    ...document.querySelectorAll<HTMLElement>('[data-chat-stress-control-id]'),
  ].filter((element) => controlIds.includes(element.dataset['chatStressControlId'] ?? ''));
  const nameOf = (element: Element): string =>
    (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().replace(/\s+/gu, ' ');
  const clippingAncestors = (element: HTMLElement): HTMLElement[] => {
    const result: HTMLElement[] = [];
    let ancestor = element.parentElement;
    while (ancestor !== null) {
      const style = getComputedStyle(ancestor);
      if (
        ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY) ||
        ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX)
      )
        result.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    return result;
  };
  const axes = (element: HTMLElement) => {
    const style = getComputedStyle(element);
    return {
      x: ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX),
      y: ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY),
      scrollX:
        ['auto', 'scroll'].includes(style.overflowX) && element.scrollWidth > element.clientWidth,
      scrollY:
        ['auto', 'scroll'].includes(style.overflowY) && element.scrollHeight > element.clientHeight,
    };
  };
  const scrollportBox = (element: HTMLElement): DOMRect => {
    const box = element.getBoundingClientRect();
    return new DOMRect(
      box.left + element.clientLeft,
      box.top + element.clientTop,
      element.clientWidth,
      element.clientHeight,
    );
  };
  const serializedBox = (box: DOMRect) => ({
    left: Math.round(box.left * 100) / 100,
    top: Math.round(box.top * 100) / 100,
    right: Math.round(box.right * 100) / 100,
    bottom: Math.round(box.bottom * 100) / 100,
  });
  const pointHitsTarget = (element: HTMLElement, box: DOMRect): boolean => {
    const points: readonly [number, number][] = [
      [box.left + box.width / 2, box.top + box.height / 2],
      [box.left + Math.min(8, box.width / 2), box.top + box.height / 2],
      [box.right - Math.min(8, box.width / 2), box.top + box.height / 2],
      [box.left + box.width / 2, box.top + Math.min(8, box.height / 2)],
      [box.left + box.width / 2, box.bottom - Math.min(8, box.height / 2)],
    ];
    return points.every(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit === element || (hit instanceof Element && element.contains(hit));
    });
  };
  return controls.flatMap((element) => {
    if ((element as HTMLButtonElement).disabled || element.getAttribute('aria-hidden') === 'true')
      return [];
    const ancestors = clippingAncestors(element);
    const before = element.getBoundingClientRect();
    const initiallyClipped = ancestors.some((candidate) => {
      const box = scrollportBox(candidate);
      const candidateAxes = axes(candidate);
      return (
        (candidateAxes.y && (before.top < box.top || before.bottom > box.bottom)) ||
        (candidateAxes.x && (before.left < box.left || before.right > box.right))
      );
    });
    if (!initiallyClipped || before.width <= 0 || before.height <= 0) return [];
    const previouslyFocused = document.activeElement;
    const positions = ancestors.map((candidate) => ({
      candidate,
      top: candidate.scrollTop,
      left: candidate.scrollLeft,
    }));
    const controlId = element.dataset['chatStressControlId'] ?? 'unknown-control';
    const originalBox = serializedBox(before);
    let after = before;
    let revealed = false;
    let samplesHitTarget = false;
    try {
      element.focus({ preventScroll: true });
      for (const candidate of ancestors) {
        const candidateAxes = axes(candidate);
        const box = scrollportBox(candidate);
        const current = element.getBoundingClientRect();
        if (candidateAxes.scrollY) {
          if (current.top < box.top) candidate.scrollTop -= box.top - current.top;
          else if (current.bottom > box.bottom) candidate.scrollTop += current.bottom - box.bottom;
        }
        if (candidateAxes.scrollX) {
          if (current.left < box.left) candidate.scrollLeft -= box.left - current.left;
          else if (current.right > box.right) candidate.scrollLeft += current.right - box.right;
        }
      }
      after = element.getBoundingClientRect();
      revealed =
        ancestors.every((candidate) => {
          const box = scrollportBox(candidate);
          const candidateAxes = axes(candidate);
          return (
            (!candidateAxes.y || (after.top >= box.top - 1 && after.bottom <= box.bottom + 1)) &&
            (!candidateAxes.x || (after.left >= box.left - 1 && after.right <= box.right + 1))
          );
        }) &&
        after.top >= -1 &&
        after.bottom <= innerHeight + 1 &&
        after.left >= -1 &&
        after.right <= innerWidth + 1;
      samplesHitTarget = revealed && pointHitsTarget(element, after);
      return [
        {
          controlId,
          name: nameOf(element),
          initiallyClipped: true,
          originalBox,
          revealedBox: serializedBox(after),
          revealed,
          samplesHitTarget,
        },
      ];
    } finally {
      for (const position of positions) {
        position.candidate.scrollTop = position.top;
        position.candidate.scrollLeft = position.left;
      }
      if (previouslyFocused instanceof HTMLElement)
        previouslyFocused.focus({ preventScroll: true });
    }
  });
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
  return {
    announcements: host.stressAnnouncements ?? 0,
    focusVisible,
  };
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

/** Case 47's first press must leave both the armed action and its reset hint inside the transcript viewport. */
async function assertIrreversibleApprovalViewport(page: Page): Promise<void> {
  const valid = await page.evaluate(() => {
    const timeline = document.querySelector<HTMLElement>('.chat-timeline');
    const button = [...document.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Press again to refund $42.00'),
    );
    const label = button?.querySelector<HTMLElement>('.cinder-button__label');
    const hint = document.querySelector<HTMLElement>('.cinder-approval-card__arm-hint');
    const card = button?.closest<HTMLElement>('.cinder-approval-card');
    if (timeline === null || button === undefined || label == null || hint === null || card == null)
      return false;
    const viewport = timeline.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    const labelBox = label.getBoundingClientRect();
    const hintBox = hint.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    const requiresTouchTarget = matchMedia('(pointer: coarse)').matches;
    return (
      buttonBox.width > 0 &&
      buttonBox.height > 0 &&
      (!requiresTouchTarget || (buttonBox.width >= 44 && buttonBox.height >= 44)) &&
      labelBox.width > 0 &&
      labelBox.height > 0 &&
      labelBox.left >= buttonBox.left - 1 &&
      labelBox.right <= buttonBox.right + 1 &&
      labelBox.top >= buttonBox.top - 1 &&
      labelBox.bottom <= buttonBox.bottom + 1 &&
      buttonBox.top >= viewport.top &&
      buttonBox.bottom <= viewport.bottom &&
      hintBox.top >= viewport.top &&
      hintBox.bottom <= viewport.bottom &&
      buttonBox.left >= cardBox.left &&
      buttonBox.right <= cardBox.right &&
      hintBox.left >= cardBox.left &&
      hintBox.right <= cardBox.right &&
      buttonBox.top >= 0 &&
      hintBox.bottom <= innerHeight
    );
  });
  if (!valid)
    throw new Error('armed approval action or reset hint is clipped or has no visible face');
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
    case 'hover':
      {
        const trigger = locate(page, step);
        // Detached Cinder tooltips bind their real mouse/focus listeners from an effect after the
        // panel hydrates. Wait for that mounted panel before hovering so the witness exercises the
        // real tooltip rather than racing hydration or relying on a source-only contract.
        await page
          .locator('[role="tooltip"]')
          .first()
          .waitFor({ state: 'attached', timeout: DEADLINE });
        await trigger.focus({ timeout: DEADLINE });
        await trigger.hover({ timeout: DEADLINE });
      }
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
    case 'expect-tooltip':
      try {
        await page.waitForFunction(
          (expected) =>
            [...document.querySelectorAll<HTMLElement>('[role="tooltip"]')].some((tooltip) => {
              const box = tooltip.getBoundingClientRect();
              const style = getComputedStyle(tooltip);
              return (
                tooltip.textContent?.trim() === expected &&
                tooltip.getAttribute('aria-hidden') === 'false' &&
                tooltip.getAttribute('data-cinder-visible') !== null &&
                tooltip.getAttribute('data-cinder-position-ready') === 'true' &&
                box.width > 0 &&
                box.height > 0 &&
                style.visibility !== 'hidden' &&
                style.display !== 'none'
              );
            }),
          step.text,
          { timeout: DEADLINE },
        );
      } catch (error) {
        const state = await page.evaluate((expected) => {
          const tooltips = [...document.querySelectorAll<HTMLElement>('[role="tooltip"]')]
            .filter((tooltip) => tooltip.textContent?.trim() === expected)
            .map((tooltip) => {
              const box = tooltip.getBoundingClientRect();
              const style = getComputedStyle(tooltip);
              return {
                hidden: tooltip.getAttribute('aria-hidden'),
                visible: tooltip.hasAttribute('data-cinder-visible'),
                positioned: tooltip.getAttribute('data-cinder-position-ready'),
                box: { width: box.width, height: box.height, top: box.top, bottom: box.bottom },
                visibility: style.visibility,
                display: style.display,
              };
            });
          const active = document.activeElement;
          return {
            active:
              active instanceof HTMLElement
                ? {
                    name: active.getAttribute('aria-label') ?? active.textContent?.trim(),
                    describedBy: active.getAttribute('aria-describedby'),
                  }
                : null,
            coarse: matchMedia('(pointer: coarse)').matches,
            anyCoarse: matchMedia('(any-pointer: coarse)').matches,
            tooltips,
          };
        }, step.text);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; tooltip diagnostic ${JSON.stringify(state)}`,
          { cause: error },
        );
      }
      return;
    case 'expect-source-contract': {
      const list = page.locator('.chat-message-sources-list');
      await list.waitFor({ state: 'visible', timeout: DEADLINE });
      const internal = list
        .locator('.chat-message-sources-item')
        .filter({ hasText: 'Internal refund notes' });
      await expectAttachment(internal.locator('.chat-message-sources-note')).toContainText(
        'Internal',
      );
      await expectAttachment(internal.locator('a')).toHaveCount(0);

      const unsafe = list
        .locator('.chat-message-sources-item')
        .filter({ hasText: 'Rejected source address' });
      await expectAttachment(unsafe.locator('[data-link="rejected"]')).toBeVisible();
      await expectAttachment(unsafe.locator('a')).toHaveCount(0);

      const longTitle = list
        .locator('.chat-message-sources-title')
        .filter({ hasText: 'deliberately long source title' });
      await expectAttachment(longTitle).toBeVisible();
      const [titleBox, titleMetrics] = await Promise.all([
        longTitle.boundingBox(),
        longTitle.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            lineHeight: Number.parseFloat(style.lineHeight),
            height: element.getBoundingClientRect().height,
            lineClamp: style.webkitLineClamp,
          };
        }),
      ]);
      if (
        titleBox === null ||
        !Number.isFinite(titleMetrics.lineHeight) ||
        titleMetrics.lineHeight <= 0
      ) {
        throw new Error('Source contract title did not expose measurable line geometry.');
      }
      if (titleMetrics.height > titleMetrics.lineHeight * 2 + 1) {
        throw new Error(`Long source title exceeded two lines (${titleMetrics.height}px).`);
      }
      if (titleMetrics.lineClamp !== '2') {
        throw new Error(
          `Long source title did not expose a two-line clamp (got ${titleMetrics.lineClamp}).`,
        );
      }
      return;
    }
    case 'expect-approval-review': {
      const state = await page.evaluate(() => {
        const shell = document.querySelector('[data-testid="chat-stress-shell"]');
        const scroller = shell?.querySelector<HTMLElement>('.chat-timeline');
        const cards = [
          ...(shell?.querySelectorAll<HTMLElement>(
            '.cinder-approval-card[data-cinder-state="pending"]',
          ) ?? []),
        ];
        const card = cards[0] ?? null;
        const article = card?.closest<HTMLElement>('article');
        const drawer = shell?.querySelector<HTMLElement>('[data-chat-approval-drawer]') ?? null;
        const box = (element: HTMLElement | null) => {
          if (element === null) return null;
          const rect = element.getBoundingClientRect();
          return {
            top: Math.round(rect.top * 100) / 100,
            bottom: Math.round(rect.bottom * 100) / 100,
            left: Math.round(rect.left * 100) / 100,
            right: Math.round(rect.right * 100) / 100,
          };
        };
        return {
          approvalWaiting: [...(shell?.querySelectorAll('.chat-tool-call-summary') ?? [])].some(
            (summary) => summary.textContent?.includes('waiting for approval'),
          ),
          pendingCards: cards.length,
          drawer: drawer !== null,
          card: box(card),
          article: box(article ?? null),
          scroller: box(scroller ?? null),
          viewport: { top: 0, bottom: innerHeight, left: 0, right: innerWidth },
          scrollerOverflow:
            scroller === undefined || scroller === null
              ? null
              : getComputedStyle(scroller).overflow,
        };
      });
      if (state.pendingCards !== 1 || state.card === null || state.scroller === null) {
        throw new Error(
          `Approval review did not expose one measurable pending card: ${JSON.stringify(state)}`,
        );
      }
      const visibleLeft = Math.max(state.scroller.left, state.viewport.left);
      const visibleRight = Math.min(state.scroller.right, state.viewport.right);
      const visibleTop = Math.max(state.scroller.top, state.viewport.top);
      const visibleBottom = Math.min(state.scroller.bottom, state.viewport.bottom);
      const cardFits =
        state.card.left >= visibleLeft - 1 &&
        state.card.right <= visibleRight + 1 &&
        state.card.top >= visibleTop - 1 &&
        state.card.bottom <= visibleBottom + 1;
      if (!cardFits && !state.drawer) {
        throw new Error(
          `Clipped approval has no Review fallback after Sources opened: ${JSON.stringify(state)}`,
        );
      }
      const pendingCard = page.locator('.cinder-approval-card[data-cinder-state="pending"]');
      const deny = pendingCard.getByRole('button', { name: /^Deny$/ });
      const approve = pendingCard.getByRole('button', { name: /\$42\.00/ });
      await deny.waitFor({ state: 'visible', timeout: DEADLINE });
      await approve.waitFor({ state: 'visible', timeout: DEADLINE });
      if (!cardFits) {
        await page.getByRole('button', { name: 'Review approval' }).click({ timeout: DEADLINE });
        await expectAttachment(pendingCard).toBeFocused();
        const focusableCount = await pendingCard
          .locator('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')
          .count();
        let reached = false;
        for (let index = 0; index <= focusableCount + 1; index += 1) {
          await page.keyboard.press('Tab');
          if (await approve.evaluate((element) => element === document.activeElement)) {
            reached = true;
            break;
          }
        }
        if (!reached) throw new Error('Normal tab traversal did not reach the approval decision.');
        await expectAttachment(approve).toBeFocused();
      }
      await expectAttachment(deny).toBeInViewport({ ratio: 1 });
      await expectAttachment(approve).toBeInViewport({ ratio: 1 });
      const decisionIntersection = await Promise.all(
        [deny, approve].map((locator) =>
          locator.evaluate((button) => {
            const scroller = document.querySelector<HTMLElement>('.chat-timeline');
            if (scroller === null) return { error: 'missing chat scroller' } as const;
            const box = button.getBoundingClientRect();
            const scrollerBox = scroller.getBoundingClientRect();
            const left = Math.max(0, scrollerBox.left);
            const right = Math.min(innerWidth, scrollerBox.right);
            const top = Math.max(0, scrollerBox.top);
            const bottom = Math.min(innerHeight, scrollerBox.bottom);
            return {
              label: button.textContent?.trim(),
              fullyVisible:
                box.left >= left - 1 &&
                box.right <= right + 1 &&
                box.top >= top - 1 &&
                box.bottom <= bottom + 1,
            };
          }),
        ),
      );
      if (
        decisionIntersection.some(
          (decision) => !('fullyVisible' in decision) || !decision.fullyVisible,
        )
      ) {
        throw new Error(
          `Approval decisions are not fully inside the live scroller viewport: ${JSON.stringify(decisionIntersection)}`,
        );
      }
      return;
    }
    case 'expect-question-layout': {
      const coarse = await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches);
      if (coarse) {
        await expectAttachment(page.locator('[data-chat-question-dock]')).toBeVisible();
        await expectAttachment(page.getByText('Which environment?', { exact: true })).toBeVisible();
      } else {
        await expectAttachment(
          page.getByRole('heading', { name: 'Which environment?', exact: true }),
        ).toBeVisible();
      }
      return;
    }
    case 'expect-attachment-shelf': {
      const list = page.locator('.chat-input-attachments');
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const expectedVisible = Math.min(
        step.total,
        expectedAttachmentShelfCap(viewport.width, viewport.height),
      );
      await expectAttachment(page.locator('.chat-input-attachment-summary')).toContainText(
        `${step.total} files`,
      );
      await expectAttachment(list.locator(':scope > li')).toHaveCount(expectedVisible);
      const more = step.total - expectedVisible;
      if (more > 0) {
        await expectAttachment(
          page.getByRole('button', { name: `${more} more below` }),
        ).toBeVisible();
      }
      const rows = list.locator(':scope > li');
      const coarse = await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches);
      const minimumTarget = coarse ? 44 : 24;
      for (let index = 0; index < expectedVisible; index += 1) {
        const row = rows.nth(index);
        const rowMain = row.locator('.chat-attachment-preview-main');
        const actions = row.locator('.chat-attachment-preview-actions');
        const filename = row.locator('.chat-attachment-preview-name');
        const [mainBox, actionsBox] = await Promise.all([
          rowMain.boundingBox(),
          actions.boundingBox(),
        ]);
        expectAttachment(mainBox).not.toBeNull();
        expectAttachment(actionsBox).not.toBeNull();
        expectAttachment(Math.abs((mainBox?.y ?? 0) - (actionsBox?.y ?? 0))).toBeLessThanOrEqual(2);
        const filenameBox = await filename.boundingBox();
        expectAttachment(filenameBox).not.toBeNull();
        const filenameRange = await filename.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const rect = range.getBoundingClientRect();
          return { width: rect.width, text: element.textContent ?? '' };
        });
        expectAttachment(filenameRange.width).toBeGreaterThan(0);
        expectAttachment(filenameRange.width).toBeLessThanOrEqual(
          (filenameBox?.width ?? 0) + ROW_EDGE_EPSILON,
        );
        const filenameText = filenameRange.text;
        const fullFilename = (await filename.getAttribute('title')) ?? '';
        expectAttachment(filenameText).toContain(
          fullFilename.endsWith('.pdf') ? '.pdf' : fullFilename,
        );
        if (filenameText !== fullFilename) {
          expectAttachment(filenameText.match(/…/g)?.length ?? 0).toBe(1);
        }
        for (const button of await row.locator('button').all()) {
          const box = await button.boundingBox();
          expectAttachment(box?.width).toBeGreaterThanOrEqual(minimumTarget);
          expectAttachment(box?.height).toBeGreaterThanOrEqual(minimumTarget);
        }
      }
      if (step.reveal === true && more > 0) {
        await page.getByRole('button', { name: `${more} more below` }).click();
        await expectAttachment(list.locator(':scope > li')).toHaveCount(step.total);
        await expectAttachment
          .poll(async () => list.evaluate((element) => getComputedStyle(element).overflowY))
          .toBe('auto');
        const hasOverflow = await list.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        );
        if (hasOverflow) {
          expectAttachment(await list.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
            await list.evaluate((element) => element.clientHeight),
          );
        }
        for (let index = 0; index < step.total; index += 1) {
          const row = list.locator(':scope > li').nth(index);
          await row.scrollIntoViewIfNeeded();
          const [listBox, rowBox] = await Promise.all([list.boundingBox(), row.boundingBox()]);
          expectAttachment(listBox).not.toBeNull();
          expectAttachment(rowBox).not.toBeNull();
          expectAttachment(rowBox?.y ?? 0).toBeGreaterThanOrEqual(
            (listBox?.y ?? 0) - ROW_EDGE_EPSILON,
          );
          expectAttachment((rowBox?.y ?? 0) + (rowBox?.height ?? 0)).toBeLessThanOrEqual(
            (listBox?.y ?? 0) + (listBox?.height ?? 0) + ROW_EDGE_EPSILON,
          );
          const mainBox = await row.locator('.chat-attachment-preview-main').boundingBox();
          const actionsBox = await row.locator('.chat-attachment-preview-actions').boundingBox();
          const filename = row.locator('.chat-attachment-preview-name');
          expectAttachment(mainBox).not.toBeNull();
          expectAttachment(actionsBox).not.toBeNull();
          expectAttachment(Math.abs((mainBox?.y ?? 0) - (actionsBox?.y ?? 0))).toBeLessThanOrEqual(
            2,
          );
          const filenameBox = await filename.boundingBox();
          expectAttachment(filenameBox).not.toBeNull();
          const filenameRange = await filename.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const rect = range.getBoundingClientRect();
            return { width: rect.width, text: element.textContent ?? '' };
          });
          expectAttachment(filenameRange.width).toBeGreaterThan(0);
          expectAttachment(filenameRange.width).toBeLessThanOrEqual(
            (filenameBox?.width ?? 0) + ROW_EDGE_EPSILON,
          );
          const filenameText = filenameRange.text;
          const fullFilename = (await filename.getAttribute('title')) ?? '';
          expectAttachment(filenameText).toContain(
            fullFilename.endsWith('.pdf') ? '.pdf' : fullFilename,
          );
          if (filenameText !== fullFilename) {
            expectAttachment(filenameText.match(/…/g)?.length ?? 0).toBe(1);
          }
          if ((await row.getAttribute('data-attachment-state')) === 'error') {
            await expectAttachment(row.locator('[data-attachment-error]')).toBeVisible();
          }
          for (const button of await row.locator('button').all()) {
            const box = await button.boundingBox();
            expectAttachment(box?.width).toBeGreaterThanOrEqual(minimumTarget);
            expectAttachment(box?.height).toBeGreaterThanOrEqual(minimumTarget);
            expectAttachment(box?.y ?? 0).toBeGreaterThanOrEqual(listBox?.y ?? 0);
            expectAttachment((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
              (listBox?.y ?? 0) + (listBox?.height ?? 0),
            );
          }
        }
        await list.evaluate((element) => {
          element.scrollTop = 0;
        });
        await expectAttachment.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0);
      }
      return;
    }
    case 'measure-composer-top':
      await waitForCaptureLayout(page);
      await page.evaluate((name) => {
        const composer =
          document.querySelector<HTMLElement>('.chat-input-area form.chat-input') ??
          document.querySelector<HTMLElement>('.chat-input-area');
        const host = window as typeof window & {
          chatStressComposerTop?: Partial<Record<'before' | 'after', number | null>>;
        };
        host.chatStressComposerTop = {
          ...host.chatStressComposerTop,
          [name]:
            composer === null ? null : Math.round(composer.getBoundingClientRect().top * 100) / 100,
        };
      }, step.name);
      return;
    case 'expect-empty-streaming-assistant':
      await page.waitForFunction(
        () => {
          const shell = document.querySelector('[data-testid="chat-stress-shell"]');
          const typing = shell?.querySelector<HTMLElement>(
            '.chat-typing-indicator[aria-label="Assistant is typing"]',
          );
          const stop = shell?.querySelector<HTMLButtonElement>('[data-stop]');
          return (
            shell?.getAttribute('data-chat-stress-streaming') === 'true' &&
            shell?.getAttribute('data-chat-stress-stream-content') === '' &&
            typing !== null &&
            typing !== undefined &&
            typing.getBoundingClientRect().height > 0 &&
            stop !== null &&
            stop !== undefined &&
            stop.getBoundingClientRect().height > 0
          );
        },
        undefined,
        { timeout: DEADLINE },
      );
      return;
    case 'expect-streaming-assistant-text':
      await page.waitForFunction(
        (expected) => {
          const messages = [
            ...document.querySelectorAll<HTMLElement>(
              '.chat-message[data-message-role="assistant"][aria-busy="true"]',
            ),
          ];
          const assistant = messages.at(-1);
          return assistant?.querySelector('.chat-message-body')?.textContent?.trim() === expected;
        },
        step.text,
        { timeout: DEADLINE },
      );
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
  else if (stressCase.id === 47) {
    await context.clock.install({ time: new Date() });
    await context.clock.setFixedTime(startTime);
  } else await context.clock.setFixedTime(startTime);
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
  if (stressCase.id === 47) {
    await waitForCaptureLayout(opened.page);
    // Freeze immediately before the real first press, after the page's layout has settled. This
    // preserves the armed state for the evidence frame without changing InlineConfirm's 3-second
    // product timer.
    await opened.page.clock.pauseAt(new Date());
  }
  for (const step of steps) {
    // Count announcements from the moment the host withdraws the source, not before.
    if (stressCase.id === 45 && step.action === 'hook' && step.name === 'withdrawSource') {
      await opened.page.evaluate(observeAnnouncements);
    }
    await runStep(opened.page, step);
  }
  if (stressCase.id === 47) await assertIrreversibleApprovalViewport(opened.page);
  if (stressCase.id === 45) {
    try {
      await opened.page.waitForFunction(
        () =>
          document.querySelector('.cinder-drawer__panel[data-cinder-closing]') === null &&
          document.activeElement?.matches(
            '.cinder-citation__marker, .chat-message-action-button[data-citation-focus]',
          ) === true,
        undefined,
        { timeout: DEADLINE },
      );
    } catch (error) {
      const state = await opened.page.evaluate(() => ({
        active: document.activeElement?.outerHTML.slice(0, 240) ?? null,
        closing: document.querySelector('.cinder-drawer__panel[data-cinder-closing]') !== null,
      }));
      throw new Error(`source withdrawal never settled: ${JSON.stringify(state)}`, {
        cause: error,
      });
    }
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

async function readComposerTransition(
  page: Page,
): Promise<Pick<NonNullable<PageMeasurement['composerTransition']>, 'before' | 'after'>> {
  return page.evaluate(() => {
    const host = window as typeof window & {
      chatStressComposerTop?: Partial<Record<'before' | 'after', number | null>>;
    };
    return {
      before: host.chatStressComposerTop?.before ?? null,
      after: host.chatStressComposerTop?.after ?? null,
    };
  });
}

/** Waits for font metrics and the composer's first post-font layout delivery before reading it. */
export async function waitForCaptureLayout(page: Page): Promise<void> {
  await page.evaluate(() => {
    const windowWithCaptureState = window as typeof window & {
      cinderCaptureLayoutReady?: boolean;
      cinderCaptureLayoutCleanup?: (() => void) | undefined;
    };
    windowWithCaptureState.cinderCaptureLayoutCleanup?.();
    windowWithCaptureState.cinderCaptureLayoutReady = false;
    let observer: ResizeObserver | undefined;
    let cancelled = false;
    let pagehideHandler: (() => void) | undefined;
    const cleanup = (): void => {
      cancelled = true;
      observer?.disconnect();
      observer = undefined;
      if (pagehideHandler !== undefined) {
        window.removeEventListener('pagehide', pagehideHandler);
        pagehideHandler = undefined;
      }
      delete windowWithCaptureState.cinderCaptureLayoutCleanup;
    };
    windowWithCaptureState.cinderCaptureLayoutCleanup = cleanup;
    void document.fonts.ready.then(() => {
      if (cancelled) return undefined;
      const targets = [...document.querySelectorAll<HTMLElement>('.chat-input-area, .chat-input')];
      if (targets.length === 0 || typeof ResizeObserver === 'undefined') {
        windowWithCaptureState.cinderCaptureLayoutReady = true;
        cleanup();
        return undefined;
      }
      observer = new ResizeObserver(() => {
        windowWithCaptureState.cinderCaptureLayoutReady = true;
        cleanup();
      });
      for (const target of targets) observer.observe(target);
      return undefined;
    });
    pagehideHandler = cleanup;
    window.addEventListener('pagehide', pagehideHandler, { once: true });
  });
  try {
    await page.waitForFunction(
      () =>
        (window as typeof window & { cinderCaptureLayoutReady?: boolean })
          .cinderCaptureLayoutReady === true,
      undefined,
      { timeout: DEADLINE },
    );
  } finally {
    await page.evaluate(() => {
      const windowWithCaptureState = window as typeof window & {
        cinderCaptureLayoutReady?: boolean;
        cinderCaptureLayoutCleanup?: (() => void) | undefined;
      };
      windowWithCaptureState.cinderCaptureLayoutCleanup?.();
      delete windowWithCaptureState.cinderCaptureLayoutReady;
    });
  }
}

/** Waits for the real Cinder tooltip panel before capturing icon-action focus states. */
async function waitForFocusedTooltip(page: Page, name: string): Promise<void> {
  if (name !== 'Copy' && name !== 'Quote message' && name !== 'Regenerate') return;
  await page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll<HTMLElement>('[role="tooltip"]')].some((tooltip) => {
        const box = tooltip.getBoundingClientRect();
        const style = getComputedStyle(tooltip);
        return (
          tooltip.textContent?.trim() === expected &&
          tooltip.getAttribute('aria-hidden') === 'false' &&
          tooltip.getAttribute('data-cinder-visible') !== null &&
          tooltip.getAttribute('data-cinder-position-ready') === 'true' &&
          box.width > 0 &&
          box.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none'
        );
      }),
    name,
    { timeout: DEADLINE },
  );
}

async function measure(
  opened: OpenCase,
  stressCase: StressCase,
  profile: StressProfile,
  composerTransition?: PageMeasurement['composerTransition'],
): Promise<{ measurement: PageMeasurement; problems: string[] }> {
  if (stressCase.id !== 47) await waitForCaptureLayout(opened.page);
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
    ...(composerTransition === undefined ? {} : { composerTransition }),
  };
  const problems = measurementProblems(measurement, profile, stressCase);
  if (stressCase.id === 19 || stressCase.id === 59) {
    problems.push(...(await readRepeatedSummaryProblems(opened.page)));
  }
  if (stressCase.id === 48 || stressCase.id === 78) {
    problems.push(...(await readFailureSummaryProblems(opened.page)));
  }
  return { measurement, problems };
}

/** One element a layout guard requires to be fully painted: present, with the expected text. */
export interface PaintedItem {
  readonly name: string;
  readonly selector: string;
  /** A regular expression source the element's trimmed text must match. */
  readonly pattern: string;
}

/** A layout guard: every scope found must paint each item and keep each `apart` pair separate. */
export interface PaintGuard {
  readonly label: string;
  /** Selector for the containers to check; each match is measured on its own. */
  readonly scope: string;
  readonly items: readonly PaintedItem[];
  /** Pairs of item names whose painted text must not intersect on both axes. */
  readonly apart: readonly (readonly [string, string])[];
}

/**
 * Measures that each item's text is really painted, not merely present in the DOM: it has a box,
 * is not `display: none` or `visibility: hidden`, sits inside the viewport, and is not cut off by
 * the element itself or any ancestor up to its scope that clips overflow (an ellipsis included).
 * Items that must stay apart fail when their painted text rectangles intersect on both axes, so
 * two items on different rows never collide however their horizontal ranges relate.
 */
export async function readPaintProblems(page: Page, guard: PaintGuard): Promise<string[]> {
  return page.evaluate((spec) => {
    const problems: string[] = [];
    const scopes = [...document.querySelectorAll<HTMLElement>(spec.scope)];
    if (scopes.length === 0) {
      return [`${spec.label} is missing`];
    }
    const textBox = (element: HTMLElement): DOMRect => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect();
    };
    for (const scope of scopes) {
      const painted = new Map<string, DOMRect>();
      for (const item of spec.items) {
        const element = scope.querySelector<HTMLElement>(item.selector);
        if (element === null) {
          problems.push(`${spec.label} ${item.name} is missing`);
          continue;
        }
        const text = (element.textContent ?? '').trim();
        if (!new RegExp(item.pattern).test(text)) {
          problems.push(`${spec.label} ${item.name} reads "${text}"`);
          continue;
        }
        const rectangle = textBox(element);
        const own = getComputedStyle(element);
        if (
          own.display === 'none' ||
          own.visibility === 'hidden' ||
          rectangle.width <= 0 ||
          rectangle.height <= 0
        ) {
          problems.push(`${spec.label} ${item.name} is not painted`);
          continue;
        }
        if (
          rectangle.left < -1 ||
          rectangle.top < -1 ||
          rectangle.right > innerWidth + 1 ||
          rectangle.bottom > innerHeight + 1
        ) {
          problems.push(`${spec.label} ${item.name} is outside the viewport`);
          continue;
        }
        let clipped = false;
        for (
          let ancestor: HTMLElement | null = element;
          ancestor !== null;
          ancestor = ancestor === scope ? null : ancestor.parentElement
        ) {
          const style = getComputedStyle(ancestor);
          if (style.overflowX === 'visible' && style.overflowY === 'visible') {
            continue;
          }
          const clip = ancestor.getBoundingClientRect();
          if (
            rectangle.left < clip.left - 1 ||
            rectangle.right > clip.right + 1 ||
            rectangle.top < clip.top - 1 ||
            rectangle.bottom > clip.bottom + 1
          ) {
            clipped = true;
          }
        }
        if (clipped) {
          problems.push(`${spec.label} ${item.name} is clipped`);
          continue;
        }
        painted.set(item.name, rectangle);
      }
      for (const [first, second] of spec.apart) {
        const a = painted.get(first);
        const b = painted.get(second);
        if (a === undefined || b === undefined) {
          continue;
        }
        const horizontal = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5;
        const vertical = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
        if (horizontal && vertical) {
          problems.push(`${spec.label} ${first} overlaps ${second}`);
        }
      }
    }
    return problems;
  }, guard);
}

/** The repeated-rollup guard: twenty identical calls keep their tool/count and duration painted. */
export const repeatedSummaryGuard: PaintGuard = {
  label: 'repeated summary',
  scope: '.chat-tool-call-timeline[data-cinder-tool-call-count="20"] .chat-tool-call-summary',
  items: [
    {
      name: 'tool/count',
      selector: '.chat-tool-call-summary-tools',
      pattern: '^lookup_order ×20$',
    },
    {
      name: 'duration',
      selector: '.chat-tool-call-summary-duration',
      pattern: '^\\d+(?:ms|s|m|h)(?: \\d+(?:s|m))?$',
    },
  ],
  apart: [['tool/count', 'duration']],
};

/** The failed-step guard: a failed step row keeps its tool name and its duration apart. The row no longer carries a separate "Failed" word (the title and the cause line say it once). */
export const failedStepGuard: PaintGuard = {
  label: 'failed step',
  scope: '.chat-tool-call-item[data-cinder-tool-call-status="failed"] .chat-tool-call-row',
  items: [
    { name: 'tool', selector: '.chat-tool-call-name', pattern: '^\\S.*$' },
    { name: 'duration', selector: '.chat-tool-call-duration', pattern: '^\\S.*$' },
  ],
  apart: [['tool', 'duration']],
};

/** The repeated-call board row must keep its complete work identity and duration visibly painted. */
export async function readRepeatedSummaryProblems(page: Page): Promise<string[]> {
  return readPaintProblems(page, repeatedSummaryGuard);
}

/** A failed step's tool name and duration must stay separate, painted facts. */
export async function readFailureSummaryProblems(page: Page): Promise<string[]> {
  return readPaintProblems(page, failedStepGuard);
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
    '| Frame | Controls (hit / painted / reachable) | Occlusions | Pending highlights | Bottom chrome |',
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
          `${control.name}: hit ${control.hitWidth}×${control.hitHeight} / paint ${control.paintedWidth}×${control.paintedHeight} / reachable ${control.reachableWidth}×${control.reachableHeight}`,
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
): Promise<{ bottom: number | null; top: number | null; safeAreaPadding: number | null }> {
  const file =
    image.kind === 'primary'
      ? primaryImageName(profile, stressCase.id)
      : variantImageName(profile, stressCase.id, image.variant ?? '');
  const label = `case ${caseLabel(stressCase.id)} at ${profile.name}${image.variant === undefined ? '' : ` ${image.variant}`}`;
  let problems: string[] = [];
  let edge: number | null = null;
  let top: number | null = null;
  let measurement: PageMeasurement | undefined;
  let opened: OpenCase | undefined;
  let composerTransition: PageMeasurement['composerTransition'];
  try {
    opened = await openCase(context, state.origin, stressCase);
    const transition =
      stressCase.id === 10 && image.variant === 'waiting-to-streaming'
        ? { from: 'waiting', to: 'streaming' }
        : stressCase.id === 18 && image.variant === 'stopped-to-failed'
          ? { from: 'stopped', to: 'failed' }
          : undefined;
    await runSteps(opened, stressCase, image.steps);
    if (transition !== undefined) {
      const endpoints = await readComposerTransition(opened.page);
      composerTransition = { ...transition, ...endpoints };
    }
    const measured = await measure(opened, stressCase, profile, composerTransition);
    problems.push(...measured.problems);
    if (stressCase.id === 60 && measured.measurement.safeArea !== undefined) {
      const expectedInset = image.variant === 'safe-area-override' ? 24 : 0;
      if (Math.abs(measured.measurement.safeArea.inset - expectedInset) > 0.5)
        problems.push(
          `${label}: expected safe-area inset ${expectedInset}px, measured ${measured.measurement.safeArea.inset}px`,
        );
    }
    measurement = measured.measurement;
    edge = measured.measurement.composerEdge;
    top = measured.measurement.composerTop;
  } catch (error) {
    problems = [`flow failed: ${error instanceof Error ? error.message : String(error)}`];
  }
  let written = false;
  if (opened !== undefined) {
    try {
      if (stressCase.id !== 47) await waitForCaptureLayout(opened.page);
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
    if (written) {
      const partialControls =
        measurement?.controlGeometry
          ?.filter(
            (control) =>
              control.reachableWidth < control.hitWidth ||
              control.reachableHeight < control.hitHeight,
          )
          .map((control) => control.controlId) ?? [];
      const proof = await opened.page.evaluate(revealScrollableControls, partialControls);
      measurement =
        measurement === undefined ? undefined : { ...measurement, scrollableRevealProof: proof };
      const proofIds = new Set(proof.map((entry) => entry.controlId));
      for (const controlId of partialControls) {
        if (!proofIds.has(controlId)) {
          problems.push(`scroll reveal proof missing for ${controlId}`);
        }
      }
      for (const entry of proof) {
        const control = measurement?.controlGeometry?.find(
          (candidate) => candidate.controlId === entry.controlId,
        );
        const prefix = `hit region sample missed ${entry.controlId}: ${control?.name ?? entry.name}`;
        if (entry.revealed && entry.samplesHitTarget) {
          const problemIndex = problems.indexOf(prefix);
          if (problemIndex >= 0) problems.splice(problemIndex, 1);
        } else problems.push(`${entry.name} remained clipped or unhit after scroll reveal`);
      }
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
  return { bottom: edge, top, safeAreaPadding: measurement?.safeArea?.paddingBottom ?? null };
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
      await waitForFocusedTooltip(opened.page, stop.name);
      const measured = await measure(opened, stressCase, profile);
      if (measured.problems.length > 0) {
        state.errors.push(
          `case ${caseLabel(stressCase.id)} at ${profile.name} ${variant}: ${measured.problems.join('; ')}`,
        );
      }
      await waitForCaptureLayout(opened.page);
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
    const tops = new Map<number, number | null>();
    let safeAreaBaseline: number | null = null;
    for (const stressCase of cases) {
      const caseContext =
        stressCase.slug === 'approval-expired' || stressCase.id === 47
          ? await openContext()
          : context;
      try {
        const captured = await captureImage(state, caseContext, profile, stressCase, {
          kind: 'primary',
          steps: stressCase.steps,
        });
        edges.set(stressCase.id, captured.bottom);
        tops.set(stressCase.id, captured.top);
        if (stressCase.id === 60) safeAreaBaseline = captured.safeAreaPadding;
        for (const variant of stressCase.variants) {
          if (variant.profiles !== undefined && !variant.profiles.includes(profile.name)) continue;
          const variantCapture = await captureImage(state, caseContext, profile, stressCase, {
            kind: 'variant',
            variant: variant.name,
            steps: variant.steps,
          });
          if (stressCase.id === 60 && variant.name === 'safe-area-override') {
            if (safeAreaBaseline === null || variantCapture.safeAreaPadding === null) {
              state.errors.push(
                `case ${caseLabel(stressCase.id)} at ${profile.name}: safe-area baseline missing`,
              );
            } else if (Math.abs(variantCapture.safeAreaPadding - safeAreaBaseline - 24) > 0.5) {
              state.errors.push(
                `case ${caseLabel(stressCase.id)} at ${profile.name}: safe-area padding changed by ${variantCapture.safeAreaPadding - safeAreaBaseline}px, expected 24px`,
              );
            }
          }
        }
        if (stressCase.focusSweep) await captureFocusSweep(state, caseContext, profile, stressCase);
      } finally {
        if (caseContext !== context) await caseContext.close();
      }
    }
    state.errors.push(...composerEdgeProblems(cases, profile, edges));
    state.errors.push(...composerTopProblems(cases, profile, tops));
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
