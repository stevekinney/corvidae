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

import { prepareManifest } from '@lostgradient/testing/browser/prepare-manifest';
import { createFixtureServer } from '@lostgradient/testing/browser/server';
import { environmentConfiguration } from '../environment-configuration.ts';
import casesData from '../src/fixtures/chat-stress.json';
import {
  STRESS_NOW,
  caseLabel,
  parseStressCases,
  type StressCase,
  type StressStep,
  type StressStepCondition,
} from '../src/fixtures/chat-stress/stress-cases.ts';
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
import { defaultManifestLayout } from './prepare-manifest.ts';

/** The one deadline every wait of the run shares. */
const DEADLINE = HANG_GUARD_MILLISECONDS;
const expectAttachment = expect.configure({ timeout: DEADLINE });

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
      // A fixed box sits on the viewport: the overflow of what holds it in the tree (a sheet
      // opened from inside the transcript) clips nothing of it.
      if (style.position === 'fixed') break;
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
    lineActionProblems?: string[];
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
      // Chrome's `elementFromPoint` resolves a fractional point within about three quarters of a
      // pixel of a shared edge to the next box (two touching 44px buttons answer the neighbour at
      // 43.25px, with or without a hit pseudo-element). A control whose own box is within a pixel
      // of 44px or more (a two-line row painted at 43.4px touches the row below it) therefore
      // probes one pixel inside its face edge, still well past anything a tap needs.
      const ownBox = element.getBoundingClientRect();
      const reachAlong = (halfExtent: number) =>
        halfExtent >= 21 ? Math.min(reach, halfExtent - 1) : reach;
      const reachX = reachAlong(ownBox.width / 2);
      const reachY = reachAlong(ownBox.height / 2);
      const sides: ['left' | 'right' | 'above' | 'below', number, number][] = [
        ['left', centreX - reachX, centreY],
        ['right', centreX + reachX, centreY],
        ['above', centreX, centreY - reachY],
        ['below', centreX, centreY + reachY],
      ];
      const short: string[] = [];
      for (const [side, x, y] of sides) {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        // A point scrolled out of a scroller's visible box cannot be tapped at all.
        if (reachableBox(element, new DOMRect(x, y, 1, 1), true) === undefined) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit === null || hit === element || element.contains(hit)) continue;
        // A probe inside the control's own painted box that resolves to another control is that
        // neighbour covering this control's face, a real defect, so both exemptions below apply
        // only to a point outside the box.
        const insideOwnBox =
          x >= ownBox.left && x < ownBox.right && y >= ownBox.top && y < ownBox.bottom;
        const nearerToANeighbour =
          !insideOwnBox &&
          controlCentres.some(
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
          !insideOwnBox &&
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
        // The probe sits half a pixel inside the area, so a block that starts within a pixel of
        // the area's far edge (the next row, a hidden line under a question) shares that edge: the
        // engine answers the neighbour there, as it does for two touching controls above.
        const hitBox = hit.getBoundingClientRect();
        const edgeOfHit =
          side === 'left'
            ? hitBox.right - x
            : side === 'right'
              ? x - hitBox.left
              : side === 'above'
                ? hitBox.bottom - y
                : y - hitBox.top;
        if (!insideOwnBox && edgeOfHit >= -0.75 && edgeOfHit <= 0.75) continue;
        short.push(`${side} (reaches ${nameOf(hit) || hit.tagName.toLowerCase()})`);
      }
      return short;
    };
    // Named exception to the 44px rule, for the actions on a message's time-and-actions line on a
    // touch pointer (owner decision of 2026-11-15 on COR-2406): their region is smaller than 44px
    // and stays clear of text. The guard is not loosened: these controls instead must (a) cover no
    // pixel of any text outside the line, above or below, and (b) be at least as tall as the room
    // allows, the line's box down to the next message (at most 44px), so a region that shrinks
    // further than it must still fails. Every other control keeps the 44px probe above.
    let textRectangles: { rect: DOMRect; text: string }[] | undefined;
    const lineActionRegionProblems = (element: HTMLElement, box: DOMRect): string[] => {
      const centreX = box.left + box.width / 2;
      const centreY = box.top + box.height / 2;
      // A point another control takes (a step row's own hit area laid over the gap under the line)
      // is that control's tap, not a shortfall of this one; it counts toward the room the region
      // had, never toward what the region covers.
      const neighbours = 'button, [role="button"], a[href], summary';
      const answers = (x: number, y: number, orNeighbour: boolean): boolean => {
        const hit = document.elementFromPoint(x, y);
        if (hit === null) return false;
        if (hit === element || element.contains(hit)) return true;
        if (!orNeighbour) return false;
        // A point scrolled out of a scroller's visible box cannot be tapped at all.
        if (reachableBox(element, new DOMRect(x, y, 1, 1), true) === undefined) return true;
        if (hit.closest(neighbours) !== null) return true;
        // A fixed or sticky surface (the composer, a docked bar) legitimately covers the area while
        // content scrolls under it, as the 44px probe above allows.
        for (let overlay: Element | null = hit; overlay !== null; overlay = overlay.parentElement) {
          const position = getComputedStyle(overlay).position;
          if ((position === 'fixed' || position === 'sticky') && !overlay.contains(element))
            return true;
        }
        return false;
      };
      // How far past an edge a tap still reaches the control, in whole pixels.
      const reach = (dx: number, dy: number, orNeighbour = false): number => {
        let count = 0;
        while (count < 80) {
          const distance = count + 0.5;
          const x = dx === 0 ? centreX : dx < 0 ? box.left - distance : box.right + distance;
          const y = dy === 0 ? centreY : dy < 0 ? box.top - distance : box.bottom + distance;
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !answers(x, y, orNeighbour))
            break;
          count += 1;
        }
        return count;
      };
      const region = {
        left: box.left - reach(-1, 0),
        right: box.right + reach(1, 0),
        top: box.top - reach(0, -1),
        bottom: box.bottom + reach(0, 1),
      };
      if (textRectangles === undefined) {
        textRectangles = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const holder = node.parentElement;
          const text = (node.textContent ?? '').trim();
          if (holder === null || text === '' || !isVisible(holder)) continue;
          if (holder.closest('.chat-message-line, script, style') !== null) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            if (rect.width > 0 && rect.height > 0) textRectangles.push({ rect, text });
          }
        }
      }
      const problems: string[] = [];
      const covered = new Set<string>();
      for (const { rect, text } of textRectangles) {
        const across = Math.min(rect.right, region.right) - Math.max(rect.left, region.left);
        const down = Math.min(rect.bottom, region.bottom) - Math.max(rect.top, region.top);
        if (across > 0.5 && down > 0.5) covered.add(text.slice(0, 40));
      }
      for (const text of covered) problems.push(`its region covers the text "${text}"`);
      const next = element.closest('.chat-message-wrapper')?.nextElementSibling ?? null;
      const room = next === null ? box.height : next.getBoundingClientRect().top - box.top;
      const required = Math.min(44, room) - 1;
      // The region's own height, with the room a neighbouring control's area took below it.
      const height = box.height + reach(0, -1) + reach(0, 1, true);
      if (room > 0 && height < required) {
        problems.push(
          `its region is ${Math.round(height * 10) / 10} px tall, shorter than the ${Math.round(required * 10) / 10} px the line and the gap below it allow`,
        );
      }
      return problems;
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
      if (element.matches('.chat-message-line .chat-message-action-button')) {
        const lineActionProblems = lineActionRegionProblems(element, box);
        if (lineActionProblems.length > 0) {
          smallTargets.push({
            name: nameOf(element),
            width: Math.round(box.width),
            height: Math.round(box.height),
            shortSides: [],
            lineActionProblems,
          });
        }
        continue;
      }
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
    '.message-content-wide, [data-cinder-markdown-node], .tool-payload-code',
  )) {
    if (!isVisible(node)) continue;
    const frame =
      node.querySelector<HTMLElement>('.cinder-markdown-table-frame, .cinder-code-block') ?? node;
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
      '.cinder-markdown-table-scroller, .cinder-code-block__viewport',
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
    jumpMisplaced:
      transcript !== null &&
      jump !== null &&
      isVisible(jump) &&
      (() => {
        const box = jump.getBoundingClientRect();
        const inside = transcript.getBoundingClientRect();
        const meets = (other: DOMRect): boolean =>
          box.left < other.right &&
          box.right > other.left &&
          box.top < other.bottom &&
          box.bottom > other.top;
        const covered = [
          ...(composerShell === undefined || composerShell === null ? [] : [composerShell]),
          ...document.querySelectorAll<HTMLElement>('.cinder-drawer__panel'),
          ...[...shell.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select')]
            .filter((control) => !transcript.contains(control) && !jump.contains(control))
            .filter((control) => !composerShell?.contains(control)),
        ].filter((element) => isVisible(element) && !element.contains(jump));
        return (
          box.left < inside.left - 1 ||
          box.right > inside.right + 1 ||
          box.top < inside.top - 1 ||
          // The transcript gives up a band under it, of the button's size and offset, while the
          // button shows: the button stands in that band, so its limit is the transcript's box
          // and the band's margin.
          box.bottom >
            inside.bottom + (parseFloat(transcriptStyle?.marginBottom ?? '0') || 0) + 1 ||
          covered.some((element) => meets(element.getBoundingClientRect()))
        );
      })(),
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
      // A fixed box sits on the viewport, so what holds it in the tree clips nothing of it.
      if (style.position === 'fixed') break;
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
    // A control that no scroller clips can still sit under a floating control (the jump pill at
    // the transcript's corner) at this scroll position; scrolling it to the centre clears it.
    const covered = !pointHitsTarget(element, before);
    if (!(initiallyClipped || covered) || before.width <= 0 || before.height <= 0) return [];
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
          // A floating control may cover an edge, so a clipped control is brought to the centre of
          // the visible box (the browser clamps at the scroll limits), where nothing floats over it.
          if (covered || current.top < box.top || current.bottom > box.bottom)
            candidate.scrollTop += current.top + current.height / 2 - (box.top + box.height / 2);
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
          initiallyClipped,
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
      // The last source says the message's own sentence; a withdrawal that leaves other chips says
      // the chip group's.
      const announced = message === 'Sources were removed' || message === 'A source was withdrawn.';
      if (announced && regions.get(region) !== message) {
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
    // Focus lands on the next row that is a link (the list stays open under the line), or on the
    // message action when no row is left (the list is gone).
    (active?.matches('a.cinder-citation__row') === true ||
      (active?.matches('.chat-message-action-button') === true &&
        document.querySelector('.cinder-citation__panel') === null)) &&
    shell?.contains(active) === true &&
    focusPainted &&
    box !== undefined &&
    box.width > 0 &&
    box.bottom > 0 &&
    box.top < innerHeight;
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

/** Runs in the page: where the transcript is on screen and how far it can scroll either way. */
function wheelTarget(): { x: number; y: number; scrollTop: number; remaining: number } | null {
  const shell = document.querySelector('[data-testid="chat-stress-shell"]') ?? document.body;
  for (const element of shell.querySelectorAll('*')) {
    const style = getComputedStyle(element);
    const scrolls = style.overflowY === 'auto' || style.overflowY === 'scroll';
    if (scrolls && element.scrollHeight > element.clientHeight + 1) {
      const box = element.getBoundingClientRect();
      return {
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
        scrollTop: element.scrollTop,
        remaining: element.scrollHeight - element.clientHeight - element.scrollTop,
      };
    }
  }
  return null;
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
    // A coarse control is painted compact and reaches 44px with a positioned hit area, so the
    // 44px is what a tap above and below its centre reaches, not the painted box.
    const centreX = buttonBox.left + buttonBox.width / 2;
    const centreY = buttonBox.top + buttonBox.height / 2;
    const reachesTouchTarget = [-21, 21].every(
      (offset) =>
        document.elementFromPoint(centreX, centreY + offset)?.closest('button') === button,
    );
    return (
      buttonBox.width > 0 &&
      buttonBox.height > 0 &&
      (!requiresTouchTarget || (buttonBox.width >= 44 && reachesTouchTarget)) &&
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

/** Evaluates a step's `when` in the page, at the moment the step runs. */
async function conditionHolds(page: Page, when: StressStepCondition): Promise<boolean> {
  if (when === 'transcript-overflows' || when === 'transcript-fits') {
    const overflows = (await page.evaluate(wheelTarget)) !== null;
    return overflows === (when === 'transcript-overflows');
  }
  return page.evaluate((condition) => {
    const scroller = document.querySelector<HTMLElement>(
      '[data-testid="chat-stress-shell"] .chat-timeline',
    );
    const card = document.querySelector<HTMLElement>(
      '.cinder-approval-card[data-cinder-state="pending"]',
    );
    if (scroller === null || card === null) return false;
    const row =
      card.querySelector<HTMLElement>(
        '.cinder-approval-card__row-actions, .cinder-approval-card__action-row',
      ) ?? card;
    const rowBox = row.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    if (condition === 'approval-row-offscreen') {
      return rowBox.bottom <= box.top || rowBox.top >= box.bottom;
    }
    // 12px is the product's clearance below the card (`--cinder-space-3`).
    return (
      rowBox.top >= box.top &&
      card.getBoundingClientRect().bottom + 12 <= box.bottom &&
      rowBox.left >= box.left &&
      rowBox.right <= box.right
    );
  }, when);
}

export async function runStep(page: Page, step: StressStep): Promise<void> {
  if (step.when !== undefined) {
    if (!(await conditionHolds(page, step.when))) return;
  }
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
      // One list for every entry point: every row is shown (the list may scroll inside its
      // sheet), a linked row is the link with an open glyph at its end and a domain under its
      // title, and nothing pages, counts "N of M" or draws a separate "Open ..." line.
      const list = page.locator('.cinder-citation__panel').first();
      await list.waitFor({ state: 'visible', timeout: DEADLINE });
      const contract = await list.evaluate((panel) => {
        const rows = [...panel.querySelectorAll<HTMLElement>('.cinder-citation__item')];
        const linked = rows.filter((row) => row.querySelector('a.cinder-citation__row') !== null);
        const viewportHeight = innerHeight;
        const inPlace = panel.closest('.chat-message-line') !== null;
        return {
          rows: rows.length,
          linked: linked.length,
          pager: document.querySelector(
            '[aria-label="Next source"], [aria-label="Previous source"]',
          ),
          counter: /\b\d+ of \d+\b/.test(panel.textContent ?? ''),
          openLines: [...panel.querySelectorAll('a')].filter((link) =>
            /^\s*Open\b/.test(link.textContent ?? ''),
          ).length,
          glyphs: linked.filter((row) => {
            const glyph = row.querySelector('a.cinder-citation__row > svg:last-child');
            const title = row.querySelector('.cinder-citation__title');
            if (glyph === null || title === null) return false;
            // The glyph is never taller than the title's line.
            return glyph.getBoundingClientRect().height <= title.getBoundingClientRect().height;
          }).length,
          domains: linked.filter((row) => row.querySelector('.cinder-citation__domain') !== null)
            .length,
          withinHalf: inPlace || panel.getBoundingClientRect().height <= viewportHeight * 0.5 + 1,
        };
      });
      if (contract.rows < 1) throw new Error('The source list has no rows.');
      if (contract.pager !== null || contract.counter) {
        throw new Error(
          `The source list has a pager or an "N of M" count: ${JSON.stringify(contract)}`,
        );
      }
      if (contract.openLines !== 0) {
        throw new Error(`The source list draws a separate Open line: ${JSON.stringify(contract)}`);
      }
      if (contract.glyphs !== contract.linked || contract.domains !== contract.linked) {
        throw new Error(`A linked row lacks its glyph or domain: ${JSON.stringify(contract)}`);
      }
      if (!contract.withinHalf) {
        throw new Error(
          `The source sheet is taller than half the viewport: ${JSON.stringify(contract)}`,
        );
      }
      const internal = list
        .locator('.cinder-citation__item')
        .filter({ hasText: 'Internal refund notes' });
      if ((await internal.count()) === 0) return;
      await expectAttachment(internal.locator('.cinder-citation__note')).toContainText('Internal');
      await expectAttachment(internal.locator('a')).toHaveCount(0);

      const unsafe = list
        .locator('.cinder-citation__item')
        .filter({ hasText: 'Rejected source address' });
      await expectAttachment(unsafe.locator('[data-cinder-link="rejected"]')).toBeVisible();
      await expectAttachment(unsafe.locator('a')).toHaveCount(0);

      const longTitle = list
        .locator('.cinder-citation__title')
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
    case 'expect-source-control': {
      // One control on the message line: the last item of the line, in the time's size and muted
      // colour, reading "N sources" with a chevron no taller than its text, and no row of its own
      // between the prose and the line.
      const control = page.locator('[data-chat-sources-trigger] .cinder-citation__marker').first();
      await control.waitFor({ state: 'visible', timeout: DEADLINE });
      const facts = await control.evaluate((marker) => {
        const line = marker.closest('.chat-message-line');
        const time = line?.querySelector('time');
        const markerStyle = getComputedStyle(marker);
        const chevron = marker.querySelector('svg');
        const items = line === null ? [] : [...line.children];
        const holder = marker.closest('.chat-message-line-sources');
        const markerBox = marker.getBoundingClientRect();
        const lineBox = line?.getBoundingClientRect();
        return {
          inLine: line !== null,
          text: (marker.textContent ?? '').replace(/\s+/g, ' ').trim(),
          last: holder !== null && items.at(-1) === holder,
          sameSize:
            time !== null &&
            time !== undefined &&
            getComputedStyle(time).fontSize === markerStyle.fontSize,
          chevronFits:
            chevron !== null &&
            // The line is measured, not read from style: a `normal` line height has no number.
            chevron.getBoundingClientRect().height <= marker.getBoundingClientRect().height + 1,
          trailing:
            lineBox === undefined
              ? false
              : Math.abs(lineBox.right - markerBox.right) <= 24 ||
                Math.abs(markerBox.left - lineBox.left) <= 24,
          rowBetween:
            document.querySelector('.chat-message-wrapper > .chat-message-sources') !== null,
          legacy:
            document.querySelector('.chat-message-sources-toggle, .chat-message-sources-link') !==
            null,
        };
      });
      if (
        !facts.inLine ||
        !facts.last ||
        !facts.sameSize ||
        !facts.chevronFits ||
        !facts.trailing
      ) {
        throw new Error(
          `The Sources control is not the trailing item of the message line: ${JSON.stringify(facts)}`,
        );
      }
      if (!/^\d+ sources?$/.test(facts.text) || facts.rowBetween || facts.legacy) {
        throw new Error(`The Sources control reads or sits wrong: ${JSON.stringify(facts)}`);
      }
      return;
    }
    case 'expect-question-dock': {
      // The docked question shows every choice with no "N more" count; the panel is within 80% of
      // the viewport; the question, the own-answer area and the actions stay in view while only the
      // list of choices scrolls; the question and the choices are 14px (the question semibold);
      // the submit is compact at the trailing end.
      const dock = page.locator('[data-chat-question-dock]');
      await dock.waitFor({ state: 'visible', timeout: DEADLINE });
      const facts = await dock.evaluate((panel) => {
        const radios = [...panel.querySelectorAll<HTMLElement>('[role="radio"]')];
        const question = panel.querySelector<HTMLElement>('.chat-question-dock-question');
        const scroller = panel.querySelector<HTMLElement>('.chat-question-dock-options-scroll');
        const body = panel.querySelector<HTMLElement>('.chat-question-dock-body');
        const submit = panel.querySelector<HTMLElement>('button[type="submit"]');
        const label = panel.querySelector<HTMLElement>('.chat-question-dock-choice');
        const box = panel.getBoundingClientRect();
        const coarse = matchMedia('(any-pointer: coarse)').matches;
        const actions = panel.querySelector<HTMLElement>('.chat-question-dock-actions');
        const submitBox = submit?.getBoundingClientRect();
        const inView = (element: Element | null): boolean => {
          if (element === null) return false;
          const edges = element.getBoundingClientRect();
          return edges.top >= box.top - 1 && edges.bottom <= box.bottom + 1 && edges.height > 0;
        };
        const hit = (radio: HTMLElement): number => {
          const before = getComputedStyle(radio, '::before');
          return coarse && before.content !== 'none'
            ? Math.max(radio.getBoundingClientRect().height, Number.parseFloat(before.height))
            : radio.getBoundingClientRect().height;
        };
        return {
          radios: radios.length,
          noMoreCount: !/\b\d+ more\b/.test(panel.textContent ?? ''),
          withinEighty: box.height <= innerHeight * 0.8 + 1,
          bodyOverflow: body === null ? '' : getComputedStyle(body).overflowY,
          scrollerOverflow: scroller === null ? '' : getComputedStyle(scroller).overflowY,
          scrollerScrolls: scroller !== null && scroller.scrollHeight > scroller.clientHeight + 1,
          questionInView: inView(question),
          actionsInView: inView(actions),
          questionSize: question === null ? '' : getComputedStyle(question).fontSize,
          questionWeight: question === null ? '' : getComputedStyle(question).fontWeight,
          labelSize: label === null ? '' : getComputedStyle(label).fontSize,
          submitCompact: submitBox !== undefined && submitBox.height <= 40,
          submitTrailing:
            submitBox !== undefined &&
            actions !== null &&
            Math.abs(actions.getBoundingClientRect().right - submitBox.right) <= 24 + 12,
          // The list scrolls inside the panel: it never overflows past the actions below it.
          listAboveActions:
            scroller !== null &&
            actions !== null &&
            scroller.getBoundingClientRect().bottom <= actions.getBoundingClientRect().top + 1,
          hitAreas: radios.every((radio) => hit(radio) >= (coarse ? 44 : 24)),
        };
      });
      const radiosOk = facts.radios === step.choices;
      const sizesOk =
        facts.questionSize === '14px' &&
        facts.labelSize === '14px' &&
        Number(facts.questionWeight) >= 600;
      const scrollOk =
        facts.bodyOverflow !== 'auto' &&
        facts.bodyOverflow !== 'scroll' &&
        (!facts.scrollerScrolls || facts.scrollerOverflow === 'auto');
      if (
        !radiosOk ||
        !facts.noMoreCount ||
        !facts.withinEighty ||
        !sizesOk ||
        !scrollOk ||
        !facts.questionInView ||
        !facts.actionsInView ||
        !facts.submitCompact ||
        !facts.submitTrailing ||
        !facts.hitAreas ||
        !facts.listAboveActions
      ) {
        throw new Error(`The docked question breaks its contract: ${JSON.stringify(facts)}`);
      }
      return;
    }
    case 'expect-question-steps': {
      await page
        .locator('[data-chat-question-dock]')
        .waitFor({ state: 'visible', timeout: DEADLINE });
      const problems = await readQuestionStepsProblems(page, step.position, step.total);
      if (problems.length > 0) {
        throw new Error(`The docked question's header breaks its contract: ${problems.join('; ')}`);
      }
      return;
    }
    case 'expect-approval-review': {
      // The product guarantees one thing the capture waits on: the reminder is on screen if and only
      // if the pending card's row of decision buttons is not wholly inside the transcript's box.
      // Wait for that agreement, with a card present, rather than for a count of frames.
      await page.waitForFunction(
        () => {
          const shell = document.querySelector('[data-testid="chat-stress-shell"]');
          const scroller = shell?.querySelector<HTMLElement>('.chat-timeline');
          const card = shell?.querySelector<HTMLElement>(
            '.cinder-approval-card[data-cinder-state="pending"]',
          );
          if (scroller == null || card == null) return false;
          const row =
            card.querySelector<HTMLElement>(
              '.cinder-approval-card__row-actions, .cinder-approval-card__action-row',
            ) ?? card;
          const rowBox = row.getBoundingClientRect();
          const box = scroller.getBoundingClientRect();
          if (rowBox.height <= 0 || box.height <= 0) return false;
          // The box the transcript has without the reminder: its bottom plus the reminder's block
          // size and margins while the reminder is present, the same box the product judges by.
          const reminderElement = shell?.querySelector<HTMLElement>('[data-chat-approval-drawer]');
          let reclaimable = 0;
          if (reminderElement != null) {
            const style = getComputedStyle(reminderElement);
            reclaimable =
              reminderElement.getBoundingClientRect().height +
              (Number.parseFloat(style.marginTop) || 0) +
              (Number.parseFloat(style.marginBottom) || 0);
          }
          // The product keeps the card's bottom edge plus 12px (`--cinder-space-3`) clear of the
          // composer when the card fits, so its buttons' hit overhang is never under the composer.
          const cardBottom = card.getBoundingClientRect().bottom + 12;
          const fitsWithClearance = cardBottom - rowBox.top <= box.height + reclaimable;
          const visible =
            rowBox.top >= box.top - 1 &&
            (fitsWithClearance ? cardBottom : rowBox.bottom) <= box.bottom + reclaimable + 1 &&
            rowBox.left >= box.left - 1 &&
            rowBox.right <= box.right + 1;
          const reminder = shell?.querySelector('[data-chat-approval-drawer]') != null;
          return reminder === !visible;
        },
        undefined,
        { timeout: DEADLINE },
      );
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
          // The reminder shows only while the decision row is out of view, so the row is measured.
          card: box(
            card?.querySelector<HTMLElement>(
              '.cinder-approval-card__row-actions, .cinder-approval-card__action-row',
            ) ?? card,
          ),
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
    case 'expect-attachment-strip': {
      const strip = page.locator('.chat-input-attachments');
      const chips = strip.locator(':scope > li .chat-attachment-preview');
      await expectAttachment(chips).toHaveCount(step.total);
      // One row: every chip's box starts on the same line, whatever the profile.
      const tops = await chips.evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().top),
      );
      expectAttachment(new Set(tops).size).toBe(1);
      if (step.uploading !== undefined) {
        await expectAttachment(strip.locator('[data-state="uploading"]')).toHaveCount(
          step.uploading,
        );
      }
      if (step.failed !== undefined) {
        await expectAttachment(strip.locator('[data-error]')).toHaveCount(step.failed);
      }
      if (step.cut !== undefined) {
        const overflows = await strip.evaluate(
          (element) => element.scrollWidth > element.clientWidth,
        );
        expectAttachment(overflows).toBe(step.cut);
      }
      const line = page.locator('.chat-input-attachment-reason');
      if (step.line === undefined) {
        await expectAttachment(line).toHaveCount(0);
      } else {
        await expectAttachment(line.locator('.chat-input-attachment-reason-text')).toHaveText(
          step.line,
        );
        if (step.lineAction !== undefined) {
          // One file's action is a glyph whose name starts with the act and then names the file
          // ("Remove report.pdf"); an action for several files is its words ("Retry all").
          const action = line.getByRole('button');
          const single = step.lineAction === 'Retry' || step.lineAction === 'Remove';
          if (single) {
            await expectAttachment(action).toHaveAccessibleName(
              new RegExp(`^${step.lineAction} \\S`, 'u'),
            );
            await expectAttachment(action.locator('svg')).toHaveCount(1);
            await expectAttachment(action).toHaveText('');
          } else {
            // Several actions are joined with " + ", in the order they are drawn.
            const labels = step.lineAction.split(' + ');
            await expectAttachment(action).toHaveText(labels.length === 1 ? labels[0]! : labels);
          }
        }
      }
      // A fine pointer's remove control is 24px painted. A coarse pointer's is compact and reaches
      // 44px by a hit area that may share an edge with the failure line's action, which the page's
      // touch-target guard measures with every control; the strip guard keeps the hit areas of
      // remove controls apart. A chip cut by the trailing edge is scrolled out and not measured.
      const coarse = await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches);
      if (!coarse) {
        const painted = await strip.locator('.chat-input-attachment-remove').evaluateAll((nodes) =>
          nodes.flatMap((node) => {
            const box = node.getBoundingClientRect();
            const edge = node.closest('.chat-input-attachments')!.getBoundingClientRect();
            return box.left >= edge.left && box.right <= edge.right
              ? [{ width: box.width, height: box.height }]
              : [];
          }),
        );
        for (const box of painted) {
          expectAttachment(box.width).toBeGreaterThanOrEqual(24);
          expectAttachment(box.height).toBeGreaterThanOrEqual(24);
        }
      }
      expectAttachment(await readAttachmentStripProblems(page)).toEqual([]);
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
    case 'scroll': {
      if (step.by !== 'wheel') {
        await page.evaluate(scrollTranscript, step.to);
        return;
      }
      // A real wheel over the transcript: the product reads it as the person's own scroll.
      const target = await page.evaluate(wheelTarget);
      if (target === null) throw new Error('No scrolling transcript to wheel over.');
      await page.mouse.move(target.x, target.y);
      // Wheel past the end and let the browser clamp: the distance never depends on a position read
      // before a settle scroll moved it.
      const distance = await page.evaluate(() =>
        Math.max(...[...document.querySelectorAll('*')].map((element) => element.scrollHeight)),
      );
      await page.mouse.wheel(0, step.to === 'top' ? -distance : distance);
      await page.waitForFunction(
        (to) => {
          const shell =
            document.querySelector('[data-testid="chat-stress-shell"]') ?? document.body;
          for (const element of shell.querySelectorAll('*')) {
            const style = getComputedStyle(element);
            if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;
            if (element.scrollHeight <= element.clientHeight + 1) continue;
            return to === 'top'
              ? element.scrollTop <= 1
              : element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
          }
          return false;
        },
        step.to,
        { timeout: DEADLINE },
      );
      return;
    }
    case 'scroll-list': {
      const selector = LIST_SELECTORS[step.target];
      const list = page.locator(selector).first();
      await expectAttachment(list).toBeVisible();
      const scrollTarget = await list.evaluate((element, to) => {
        const inline = element.getAttribute('data-cinder-edge-fade') === 'inline';
        const rtl = getComputedStyle(element).direction === 'rtl';
        const room = inline
          ? element.scrollWidth - element.clientWidth
          : element.scrollHeight - element.clientHeight;
        const distance = to === 'start' ? 0 : to === 'middle' ? room / 2 : room;
        if (inline) element.scrollLeft = rtl ? -distance : distance;
        else element.scrollTop = distance;
        return { inline, distance, room };
      }, step.to);
      // A list that fits has no edge to fade, so an image of it would prove nothing: the variant
      // belongs only to the profiles where the list is cut off.
      if (scrollTarget.room <= 1) {
        throw new Error(`The ${step.target} is not cut off here, so it has no fade to show.`);
      }
      // Settled: the scroll has landed and the fades follow it, so the image shows the state named.
      await page.waitForFunction(
        ({ selector: scroller, ...wanted }) => {
          const element = document.querySelector(scroller);
          if (element === null) return false;
          const position = Math.abs(wanted.inline ? element.scrollLeft : element.scrollTop);
          if (Math.abs(position - wanted.distance) > 1) return false;
          const room = wanted.inline
            ? element.scrollWidth - element.clientWidth
            : element.scrollHeight - element.clientHeight;
          const before = wanted.inline
            ? 'data-cinder-overflows-inline-start'
            : 'data-cinder-overflows-start';
          const after = wanted.inline
            ? 'data-cinder-overflows-inline-end'
            : 'data-cinder-overflows';
          return (
            element.hasAttribute(before) === (room > 1 && position > 1) &&
            element.hasAttribute(after) === (room > 1 && room - position > 1)
          );
        },
        { selector, ...scrollTarget },
        { timeout: DEADLINE },
      );
      return;
    }
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
    // The approval card owns the waiting state on screen, so the step summary does not repeat it
    // (`cardOwnedCallIds`): the card is what to wait for, and the summary must stay silent.
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
          summaries.every(
            (summary) =>
              !summary.textContent?.includes('waiting for approval') &&
              !summary.textContent?.includes('expired'),
          )
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
    try {
      await runStep(opened.page, step);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`step ${step.action}: ${message}`, { cause: error });
    }
  }
  if (stressCase.id === 47) await assertIrreversibleApprovalViewport(opened.page);
  if (stressCase.id === 45) {
    try {
      await opened.page.waitForFunction(
        () =>
          document.querySelector('.cinder-drawer__panel[data-cinder-closing]') === null &&
          document.activeElement?.matches(
            'a.cinder-citation__row, .chat-message-action-button[data-citation-focus]',
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
  await waitForSettledCodeHighlights(opened.page);
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

/** Waits for every language-labelled, settled code block to finish its semantic highlight state. */
async function waitForSettledCodeHighlights(page: Page): Promise<void> {
  // A block that names its language is highlighted once the highlighter answers, and until its
  // effect first runs it reads "plain", as a block that never highlights does. Waiting on "pending"
  // alone passes in that gap and the frame is taken as the highlight starts, so a block that names
  // a language, and is not streaming, must also have left "plain".
  await page.waitForFunction(
    () =>
      document.querySelector('[data-cinder-highlight-state="pending"]') === null &&
      [...document.querySelectorAll('.cinder-code-block')].every(
        (block) =>
          block.querySelector('.cinder-code-block__language') === null ||
          block.getAttribute('aria-busy') === 'true' ||
          block.getAttribute('data-cinder-highlight-state') !== 'plain',
      ),
    undefined,
    { timeout: DEADLINE },
  );
}

/**
 * Settles both physical layout and semantic code rendering immediately before a measurement or
 * screenshot. Layout can virtualize a code block after `runSteps` saw it highlighted, which starts
 * another pending highlighter pass; yielding one frame exposes that pass without retrying capture.
 */
export async function waitForFinalCaptureReadiness(page: Page): Promise<void> {
  await waitForCaptureLayout(page);
  await page.evaluate(
    () => new Promise<void>((complete) => requestAnimationFrame(() => complete())),
  );
  await waitForSettledCodeHighlights(page);
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
  if (stressCase.id !== 47) await waitForFinalCaptureReadiness(opened.page);
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
  if (stressCase.id === 19 || stressCase.id === 83) {
    const spacing = await readStepRowSpacing(opened.page);
    if (spacing !== undefined) {
      console.log(
        `case ${stressCase.id} at ${profile.name}: step row text to answer ${spacing.stepToAnswer.toFixed(2)}px, a message's text to its time ${spacing.betweenParts.toFixed(2)}px`,
      );
    }
    problems.push(...stepRowSpacingProblems(spacing));
  }
  if (stressCase.id === 85) {
    problems.push(...(await readStoppedTurnOrderProblems(opened.page)));
  }
  if (stressCase.id === 48 || stressCase.id === 78) {
    problems.push(...(await readFailureSummaryProblems(opened.page)));
  }
  const foldedNarration = stressCase.params['narration'];
  if (Array.isArray(foldedNarration)) {
    problems.push(...(await readNarrationFoldProblems(opened.page, foldedNarration.map(String))));
  }
  if (stressCase.slug === 'narration-folded-open') {
    problems.push(...(await readNarrationStyleProblems(opened.page)));
  }
  if (stressCase.id === 82) {
    problems.push(...(await readNarrationLineProblems(opened.page, 'bare')));
  }
  if (stressCase.id === 39) {
    problems.push(...(await readNarrationLineProblems(opened.page, 'asking')));
  }
  problems.push(...(await readActionRowProblems(opened.page)));
  problems.push(...(await readComposerNoticeProblems(opened.page)));
  problems.push(...(await readJumpOverlapProblems(opened.page)));
  problems.push(...(await readLabelFitProblems(opened.page)));
  problems.push(...(await readCalloutSpacingProblems(opened.page)));
  const insets = await readCalloutInsets(opened.page);
  for (const inset of insets) {
    console.log(
      `case ${stressCase.id} at ${profile.name}: notice "${inset.label}" ink ${inset.top.toFixed(2)}px under its top border, ${inset.bottom.toFixed(2)}px over its bottom border${inset.glyph === undefined ? '' : `, glyph ${inset.glyph.toFixed(2)}px from a border`}`,
    );
  }
  problems.push(...calloutInsetProblems(insets));
  problems.push(...(await readIconSizeProblems(opened.page)));
  problems.push(...(await readAttachmentStripProblems(opened.page)));
  problems.push(...(await readEdgeFadeProblems(opened.page)));
  problems.push(...(await readIconCentreProblems(opened.page)));
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

/**
 * The containers of a card's or notice's action row. Each ends at the trailing content edge of its
 * parent (the owner decision of 2026-11-13: trailing-edge actions everywhere), so the guard names
 * them here, and a new kind of action row joins this list rather than escaping the guard.
 */
export const ACTION_ROW_SELECTORS: readonly string[] = [
  '.cinder-callout__action',
  '.cinder-approval-card__row-actions',
  '.cinder-approval-card__action-buttons',
  '.cinder-approval-card__editor-actions',
  '.cinder-approval-card__settled-actions',
  '.chat-input-blocked-actions',
  '.chat-question-dock-actions',
  '.cinder-inline-confirm__actions',
  '.chat-message-edit-actions',
  '.chat-message-not-sent-actions',
  '.chat-tool-call-failure-actions',
  '.cinder-docked-action-bar__actions',
  // A control that is itself the row: a question's submit button and its receipt's Change.
  '.chat-question-stack > button[type="submit"]',
  '.chat-question-row > button[type="submit"]',
  '.chat-question-receipt > .cinder-button',
  // A centred empty or error state keeps its centred action (an empty state has only that one
  // layout); the flat and row error layouts end at the trailing edge.
  '.cinder-error-state[data-cinder-variant="flat"] .cinder-error-state-action',
  '.cinder-error-state[data-cinder-variant="row"] .cinder-error-state-action',
];

/** How far the last control of an action row may sit from the trailing content edge, in pixels. */
export const ACTION_ROW_TOLERANCE = 1;

/**
 * Measures that every visible action row ends at its container's trailing content edge: the
 * trailing-most control's outer edge is within one pixel of the edge of the parent's content box
 * (the left edge in a right-to-left row). A Callout that carries a dismiss button ends before it,
 * because the dismiss button owns the callout's trailing track. Rows with no visible control, and
 * controls inside a tooltip, are not measured.
 */
export async function readActionRowProblems(
  page: Page,
  selectors: readonly string[] = ACTION_ROW_SELECTORS,
): Promise<string[]> {
  return page.evaluate(
    (spec) => {
      const problems: string[] = [];
      for (const row of document.querySelectorAll<HTMLElement>(spec.selectors.join(','))) {
        const parent = row.parentElement;
        if (parent === null) continue;
        const own = getComputedStyle(row);
        if (own.display === 'none' || own.visibility === 'hidden') continue;
        const candidates = row.matches('button, a[href]')
          ? [row]
          : [...row.querySelectorAll<HTMLElement>('button, a[href]')];
        const controls = candidates.filter((control) => {
          if (control.closest('[role="tooltip"], .cinder-sr-only') !== null) return false;
          const rectangle = control.getBoundingClientRect();
          return rectangle.width > 0 && rectangle.height > 0;
        });
        if (controls.length === 0) continue;
        const style = getComputedStyle(parent);
        const rtl = getComputedStyle(row).direction === 'rtl';
        const box = parent.getBoundingClientRect();
        let edge = rtl
          ? box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)
          : box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
        const dismiss = parent.querySelector<HTMLElement>(':scope > .cinder-callout__dismiss');
        if (dismiss !== null) {
          const dismissBox = dismiss.getBoundingClientRect();
          const gap = parseFloat(getComputedStyle(dismiss).marginInlineStart);
          edge = rtl ? dismissBox.right + gap : dismissBox.left - gap;
        }
        // The last control in reading order is the primary action: it must be the one that ends
        // the row, so an earlier control touching the edge never excuses a primary left behind.
        const last = controls[controls.length - 1]!.getBoundingClientRect();
        const trailing = rtl ? last.left : last.right;
        const distance = Math.abs(trailing - edge);
        if (distance > spec.tolerance) {
          const label = (row.className.split(/\s+/)[0] ?? row.tagName).trim();
          problems.push(
            `action row .${label} ends ${distance.toFixed(1)}px from the trailing content edge`,
          );
        }
      }
      return problems;
    },
    { selectors: [...selectors], tolerance: ACTION_ROW_TOLERANCE },
  );
}

/**
 * Measures the docked question's header when several questions were asked together: it reads
 * `Question <position> of <total>`; the tag comes first in the document, then the progress, the
 * previous button, the next button and the choices; the progress is a muted 12px eyebrow with its
 * two compact buttons directly after it, one row of their own above the tag and the question, at
 * the leading edge where the question starts; the tag shares the question's line when the question
 * fits beside it, and otherwise the question has the full width on the line under the tag, which
 * stands at the leading end; previous is off on the first question and next on the last.
 */
export async function readQuestionStepsProblems(
  page: Page,
  position: number,
  total: number,
): Promise<string[]> {
  return page.evaluate(
    (spec) => {
      const problems: string[] = [];
      const dock = document.querySelector<HTMLElement>('[data-chat-question-dock]');
      if (dock === null) return ['the question dock is missing'];
      const find = (selector: string): HTMLElement | null => dock.querySelector(selector);
      const heading = find('[data-chat-question-heading]');
      const tag = find('[data-chat-question-needs]');
      const progress = find('[data-chat-question-progress]');
      const previous = find('[data-chat-question-previous]') as HTMLButtonElement | null;
      const next = find('[data-chat-question-next]') as HTMLButtonElement | null;
      const question = find('.chat-question-dock-question');
      const firstChoice = find('[role="radio"]');
      if (heading === null || tag === null) return ['the dock has no heading or no tag'];
      if (progress === null || previous === null || next === null) {
        return ['the header has no progress or no previous and next buttons'];
      }
      const expected = `Question ${spec.position} of ${spec.total}`;
      if (progress.textContent?.trim() !== expected) {
        problems.push(
          `the progress reads ${JSON.stringify(progress.textContent?.trim())}, not ${expected}`,
        );
      }
      if (previous.disabled !== (spec.position === 1)) {
        problems.push(
          `previous is ${previous.disabled ? 'off' : 'on'} at question ${spec.position}`,
        );
      }
      if (next.disabled !== (spec.position === spec.total)) {
        problems.push(`next is ${next.disabled ? 'off' : 'on'} at question ${spec.position}`);
      }
      const ordered = [tag, progress, previous, next, firstChoice].filter(
        (element): element is HTMLElement => element !== null,
      );
      for (let index = 1; index < ordered.length; index += 1) {
        const before = ordered[index - 1]!;
        const after = ordered[index]!;
        if ((before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) {
          problems.push('the tag, progress, buttons and choices are not in that order');
          break;
        }
      }
      const rtl = getComputedStyle(dock).direction === 'rtl';
      const box = (element: HTMLElement): DOMRect => element.getBoundingClientRect();
      const gap = (row: HTMLElement): number => parseFloat(getComputedStyle(row).columnGap) || 0;
      const headingBox = box(heading);
      const lineOf = (element: HTMLElement): number => box(element).top + box(element).height / 2;
      const pager = [progress, previous, next];
      if (pager.some((element) => Math.abs(lineOf(element) - lineOf(progress)) > 2)) {
        problems.push('the progress and the buttons are not on one line');
      }
      if (box(tag).height > 30) problems.push('the tag wraps or stretches');
      for (const button of [previous, next]) {
        const face = box(button);
        if (face.height > 40 || face.width > 40)
          problems.push('a navigation button is not compact');
      }
      // The pager is the row that starts where the question starts: the words at the leading
      // edge, the buttons directly after them (previous, then next), and nothing before them.
      const words = box(progress);
      const leadingOffset = rtl ? headingBox.right - words.right : words.left - headingBox.left;
      if (Math.abs(leadingOffset) > 1) {
        problems.push(
          `the pager does not start at the leading edge (${leadingOffset.toFixed(1)}px in)`,
        );
      }
      const afterWords = rtl ? words.left - box(previous).right : box(previous).left - words.right;
      // The count is set apart from the pair (8px), and the two buttons stay together (4px), so the
      // count never reads as part of the button group.
      if (afterWords < -1 || afterWords > 12) {
        problems.push(
          `the buttons are ${afterWords.toFixed(1)}px from the words, not directly after`,
        );
      } else if (Math.abs(afterWords - 8) > 1) {
        problems.push(
          `the words are ${afterWords.toFixed(1)}px from the buttons, not the 8px that sets the count apart`,
        );
      }
      const betweenButtons = rtl
        ? box(previous).left - box(next).right
        : box(next).left - box(previous).right;
      if (betweenButtons < -1 || betweenButtons > 12) {
        problems.push('next does not follow previous directly');
      } else if (Math.abs(betweenButtons - 4) > 1) {
        problems.push(`the two buttons are ${betweenButtons.toFixed(1)}px apart, not 4px`);
      }
      const wordsStyle = getComputedStyle(progress);
      if (wordsStyle.fontSize !== '12px') {
        problems.push(`the progress is ${wordsStyle.fontSize}, not a 12px eyebrow`);
      }
      if (question !== null && wordsStyle.color === getComputedStyle(question).color) {
        problems.push('the progress is not muted: it has the question’s colour');
      }
      for (const other of [tag, question]) {
        if (
          other !== null &&
          box(other).top < Math.max(box(progress).bottom, box(next).bottom) - 1
        ) {
          problems.push('the pager shares a line with the tag or the question');
          break;
        }
      }
      if (question !== null) {
        if ((question.textContent ?? '').trim() === '') problems.push('the question is empty');
        // The question's own width on one line: it is held at its natural size for a moment.
        const held = { flex: question.style.flex, width: question.style.width };
        question.style.flex = 'none';
        question.style.width = 'max-content';
        const naturalWidth = box(question).width;
        question.style.flex = held.flex;
        question.style.width = held.width;
        const questionBox = box(question);
        const fits = naturalWidth + box(tag).width + gap(heading) <= headingBox.width + 0.5;
        if (fits) {
          if (Math.abs(lineOf(question) - lineOf(tag)) > 2) {
            problems.push('the question fits beside the tag but the tag is not on its line');
          }
        } else {
          if (questionBox.top < box(tag).bottom - 1) {
            problems.push('the question is not under the tag');
          }
          if (questionBox.width < headingBox.width - 1) {
            problems.push('the question does not use the full width');
          }
          const leadingGap = rtl
            ? headingBox.right - box(tag).right
            : box(tag).left - headingBox.left;
          if (Math.abs(leadingGap) > 1) problems.push('the tag is not at the leading end');
        }
      } else {
        problems.push('the question is missing');
      }
      return problems;
    },
    { position, total },
  );
}

/**
 * The action rows whose control gives up its words for its icon only when the row cannot hold them
 * on one line: the row, the control, the attribute that makes it icon-only, and the parts that are
 * meant to take a line of their own. A new row of this kind joins this list.
 */
export const LABEL_FIT_ROWS: readonly {
  readonly row: string;
  readonly control: string;
  readonly attribute: string;
  readonly ignore: string;
}[] = [
  {
    row: '.cinder-approval-card__row-actions',
    control: '.cinder-approval-card__note-toggle',
    attribute: 'data-cinder-note-compact',
    ignore: '.cinder-inline-confirm__two-press-hint',
  },
  {
    row: '.chat-question-dock-actions',
    control: '.chat-question-dock-reply-tip',
    attribute: 'data-chat-reply-compact',
    ignore: '[hidden]',
  },
];

/**
 * Measures that a control shows its words exactly when its row has room for them. The check does
 * not use the helper's own test (items sharing a line): it puts the words back, adds the widths of
 * the row's items and their gaps, and compares the sum with the row's width. A control that is
 * icon-only with room to spare, or that keeps its words while the row cannot hold them, is a problem.
 * The attribute is restored before returning.
 */
export async function readLabelFitProblems(
  page: Page,
  rows: typeof LABEL_FIT_ROWS = LABEL_FIT_ROWS,
): Promise<string[]> {
  return page.evaluate((specs) => {
    const problems: string[] = [];
    for (const spec of specs) {
      for (const row of document.querySelectorAll<HTMLElement>(spec.row)) {
        const control = row.querySelector<HTMLElement>(spec.control);
        if (control === null || row.clientWidth === 0) continue;
        const items = (parent: Element): HTMLElement[] =>
          [...parent.children].flatMap((child) => {
            if (!(child instanceof HTMLElement) || child.matches(spec.ignore)) return [];
            const style = getComputedStyle(child);
            if (style.display === 'none' || style.position === 'absolute') return [];
            if (style.display === 'contents') return items(child);
            return child.getBoundingClientRect().width > 0 ? [child] : [];
          });
        const compact = control.hasAttribute(spec.attribute);
        control.removeAttribute(spec.attribute);
        const laidOut = items(row);
        const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
        const needed =
          laidOut.reduce((sum, item) => sum + item.getBoundingClientRect().width, 0) +
          gap * Math.max(0, laidOut.length - 1);
        if (compact) control.setAttribute(spec.attribute, '');
        const fits = needed <= row.clientWidth + 0.5;
        const label = (row.className.split(/\s+/)[0] ?? row.tagName).trim();
        if (compact && fits) {
          problems.push(
            `${spec.control} in .${label} is icon-only with room for its words (${needed.toFixed(1)}px of ${row.clientWidth}px)`,
          );
        }
        if (!compact && !fits) {
          problems.push(
            `${spec.control} in .${label} keeps its words while the row cannot hold them (${needed.toFixed(1)}px of ${row.clientWidth}px)`,
          );
        }
      }
    }
    return problems;
  }, rows);
}

/** How far apart the two gaps around a notice's progress line may be, in pixels (owner decision of 2026-11-13). */
export const CALLOUT_SPACING_TOLERANCE = 1;

/** The two gaps around one notice's progress line, measured in the page. */
export interface CalloutGaps {
  /** From the bottom of the last text line's letters to the top of the progress line. */
  readonly textToBar: number;
  /** From the bottom of the progress line to the top of the action row. */
  readonly barToAction: number;
}

/**
 * Measures, for every visible notice that holds text, a progress line and an action row, the
 * distance from the last text line's letters to the bar and from the bar to the action row's top.
 * The letters' extent is the text's own client rectangle (the font's content area), not the line
 * box, so the leading below the line is part of the distance a person sees.
 */
export async function readCalloutGaps(page: Page): Promise<CalloutGaps[]> {
  return page.evaluate(() => {
    const gaps: { textToBar: number; barToAction: number }[] = [];
    for (const callout of document.querySelectorAll<HTMLElement>('.cinder-callout')) {
      const progress = callout.querySelector<HTMLElement>('.cinder-callout__progress');
      const action = callout.querySelector<HTMLElement>('.cinder-callout__action');
      const content = callout.querySelector<HTMLElement>('.cinder-callout__content');
      if (progress === null || action === null || content === null) continue;
      if (getComputedStyle(action).display === 'none') continue;
      const bar = progress.querySelector<HTMLElement>('[role="progressbar"]') ?? progress;
      const barBox = bar.getBoundingClientRect();
      const actionBox = action.getBoundingClientRect();
      if (barBox.height === 0 || actionBox.height === 0) continue;
      // An action beside the text, not under the bar, has no gap to compare.
      if (actionBox.top < barBox.bottom) continue;
      let lastLineBottom: number | undefined;
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node.textContent?.trim() === '' || progress.contains(node)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rectangles = [...range.getClientRects()].filter((rectangle) => rectangle.height > 0);
        const last = rectangles[rectangles.length - 1];
        if (last !== undefined) lastLineBottom = last.bottom;
      }
      if (lastLineBottom === undefined) continue;
      gaps.push({
        textToBar: barBox.top - lastLineBottom,
        barToAction: actionBox.top - barBox.bottom,
      });
    }
    return gaps;
  });
}

/** A notice's progress line sits as far from the text above it as from the action row below it. */
export async function readCalloutSpacingProblems(page: Page): Promise<string[]> {
  const gaps = await readCalloutGaps(page);
  return gaps
    .filter((gap) => Math.abs(gap.textToBar - gap.barToAction) > CALLOUT_SPACING_TOLERANCE)
    .map(
      (gap) =>
        `notice progress line is ${gap.textToBar.toFixed(1)}px under the text but ${gap.barToAction.toFixed(1)}px above the action row`,
    );
}

/** How far a notice's top and bottom ink insets may differ, in pixels (owner review, 2026-11-14). */
export const CALLOUT_INSET_TOLERANCE = 1;

/** One notice's distance from its border to the first ink and from the last ink to its border. */
export interface CalloutInsets {
  readonly label: string;
  /** From the inside of the top border to the highest ink: capitals or a button face. */
  readonly top: number;
  /** From the lowest ink, a baseline, a button face or the progress line, to the inside of the bottom border. */
  readonly bottom: number;
  /** The least distance from the glyph's drawing to the inside of either border, when there is a glyph. */
  readonly glyph?: number;
}

/** How near a border a notice's glyph may stand, in pixels: it is taller than the letters, so it overhangs them. */
export const CALLOUT_GLYPH_CLEARANCE = 8;

/**
 * Measures, for every visible notice, how far its ink stands from its border above and below
 * (owner review of 2026-11-14: a notice read heavier on top). Ink is what is drawn: a line of
 * text runs from the top of its capitals to its baseline (read from the font's ascent and the
 * height of an `H`, as {@link readStepRowSpacing} does); a button is its face, and its label is
 * not measured again; the progress line is its bar. The dismiss button is a corner control and is
 * left out. A box's air (the leading of a line, the room round a glyph) is not ink. The glyph
 * beside the letters (its drawing, from `getBBox` with the stroke, or the box of a spinner) is
 * taller than they are and overhangs them above and below, so it is measured on its own: it
 * must not come within {@link CALLOUT_GLYPH_CLEARANCE} of a border.
 */
export async function readCalloutInsets(page: Page): Promise<CalloutInsets[]> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas').getContext('2d');
    if (canvas === null) return [];
    const skipped = '.cinder-sr-only, [role="tooltip"], [hidden], .cinder-callout__dismiss';
    const result: { label: string; top: number; bottom: number; glyph?: number }[] = [];
    for (const callout of document.querySelectorAll<HTMLElement>('.cinder-callout')) {
      const box = callout.getBoundingClientRect();
      if (box.height === 0 || getComputedStyle(callout).display === 'none') continue;
      const style = getComputedStyle(callout);
      const innerTop = box.top + parseFloat(style.borderTopWidth);
      const innerBottom = box.bottom - parseFloat(style.borderBottomWidth);
      const spans: [number, number][] = [];
      const visible = (element: Element): boolean =>
        element.closest(skipped) === null && element.getClientRects().length > 0;
      for (const button of callout.querySelectorAll<HTMLElement>('button, a')) {
        if (!visible(button)) continue;
        const face = button.getBoundingClientRect();
        spans.push([face.top, face.bottom]);
      }
      for (const bar of callout.querySelectorAll<HTMLElement>('[role="progressbar"]')) {
        if (!visible(bar)) continue;
        const face = bar.getBoundingClientRect();
        spans.push([face.top, face.bottom]);
      }
      const glyphs: [number, number][] = [];
      for (const glyph of callout.querySelectorAll<SVGSVGElement>('svg')) {
        if (!visible(glyph) || glyph.closest('button, a, [role="progressbar"]') !== null) continue;
        const drawn = glyph.getBBox({ fill: true, stroke: true });
        const frame = glyph.getBoundingClientRect();
        const view = glyph.viewBox.baseVal;
        const scale = view.height > 0 ? frame.height / view.height : 1;
        const top = frame.top + (drawn.y - view.y) * scale;
        glyphs.push([top, top + drawn.height * scale]);
      }
      // A glyph that is not an `svg`, such as a spinner, is its box.
      for (const wrapper of callout.querySelectorAll<HTMLElement>(
        '.cinder-callout__icon > :not(svg)',
      )) {
        if (!visible(wrapper)) continue;
        const face = wrapper.getBoundingClientRect();
        glyphs.push([face.top, face.bottom]);
      }
      const walker = document.createTreeWalker(callout, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const holder = node.parentElement;
        if (holder === null || (node.textContent ?? '').trim() === '') continue;
        if (!visible(holder) || holder.closest('button, a, [role="progressbar"]') !== null)
          continue;
        const holderStyle = getComputedStyle(holder);
        canvas.font = `${holderStyle.fontStyle} ${holderStyle.fontWeight} ${holderStyle.fontSize} ${holderStyle.fontFamily}`;
        const measured = canvas.measureText('H');
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const line of range.getClientRects()) {
          if (line.height === 0) continue;
          const baseline = line.top + measured.fontBoundingBoxAscent;
          spans.push([baseline - measured.actualBoundingBoxAscent, baseline]);
        }
      }
      if (spans.length === 0) continue;
      const highest = Math.min(...spans.map(([top]) => top));
      const lowest = Math.max(...spans.map(([, bottom]) => bottom));
      const glyphInset =
        glyphs.length === 0
          ? undefined
          : Math.min(...glyphs.flatMap(([top, bottom]) => [top - innerTop, innerBottom - bottom]));
      result.push({
        label: (callout.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
        top: highest - innerTop,
        bottom: innerBottom - lowest,
        ...(glyphInset === undefined ? {} : { glyph: glyphInset }),
      });
    }
    return result;
  });
}

/** A notice's ink stands as far under its top border as over its bottom one. */
export function calloutInsetProblems(insets: readonly CalloutInsets[]): string[] {
  return insets.flatMap((inset) => {
    const problems: string[] = [];
    if (Math.abs(inset.top - inset.bottom) > CALLOUT_INSET_TOLERANCE) {
      problems.push(
        `notice "${inset.label}" has ${inset.top.toFixed(1)}px from its top border to the first ink but ${inset.bottom.toFixed(1)}px from the last ink to its bottom border`,
      );
    }
    if (inset.glyph !== undefined && inset.glyph < CALLOUT_GLYPH_CLEARANCE) {
      problems.push(
        `notice "${inset.label}" has its glyph ${inset.glyph.toFixed(1)}px from a border, nearer than ${CALLOUT_GLYPH_CLEARANCE}px`,
      );
    }
    return problems;
  });
}

/** How far a glyph may exceed the line height of the text beside it, in pixels. */
export const ICON_SIZE_TOLERANCE = 0.5;

/**
 * Measures that an icon is never larger than the text beside it (owner decision of 2026-11-13): an
 * `svg` that shares a row with text inside a flex or grid container is no taller than that text's
 * line height. The row is the nearest flex or grid ancestor, within three levels, that holds visible
 * text outside the glyph's own wrapper and whose first line overlaps the glyph vertically; a glyph
 * stacked above its text, or a large illustration with no text beside it, is not a row. Tooltips and
 * screen-reader-only text are not measured.
 */
export async function readIconSizeProblems(page: Page): Promise<string[]> {
  return page.evaluate((tolerance) => {
    const problems: string[] = [];
    const hidden = '[role="tooltip"], .cinder-sr-only, [hidden], [aria-hidden="true"] svg *';
    const textOf = (node: Node): string => (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    const firstLine = (node: Node): DOMRect | undefined => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].find((rectangle) => rectangle.height > 0);
    };
    for (const glyph of document.querySelectorAll<SVGElement>('svg')) {
      if (glyph.closest(hidden) !== null) continue;
      const box = glyph.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      let wrapper: Element = glyph;
      for (let level = 0; level < 3; level += 1) {
        // The text beside a glyph is its own control's text: a button's neighbour is another
        // control, whose label says nothing about this glyph's size.
        if (wrapper.matches('button, a[href], summary, [role="button"]')) break;
        const container = wrapper.parentElement;
        if (container === null || container === document.body) break;
        const display = getComputedStyle(container).display;
        if (/^(inline-)?(flex|grid)$/.test(display)) {
          const beside = [...container.childNodes].find((node) => {
            if (node === wrapper || node.contains(glyph)) return false;
            if (node.nodeType === Node.ELEMENT_NODE) {
              const element = node as Element;
              if (element.closest(hidden) !== null || getComputedStyle(element).display === 'none')
                return false;
              if (element.querySelector('svg') !== null && textOf(element) === '') return false;
            } else if (node.nodeType !== Node.TEXT_NODE) {
              return false;
            }
            // Text clipped to a pixel is a visually hidden label (an icon-only button's name).
            return textOf(node) !== '' && (firstLine(node)?.width ?? 0) > 1;
          });
          const line = beside === undefined ? undefined : firstLine(beside);
          if (beside !== undefined && line !== undefined) {
            const overlap = Math.min(line.bottom, box.bottom) - Math.max(line.top, box.top);
            if (overlap > 0) {
              const source =
                beside.nodeType === Node.ELEMENT_NODE ? (beside as Element) : container;
              const style = getComputedStyle(source);
              const size = parseFloat(style.fontSize);
              const lineHeight =
                style.lineHeight === 'normal' ? size * 1.2 : parseFloat(style.lineHeight);
              if (box.height > lineHeight + tolerance) {
                const name = ((container.getAttribute('class') ?? '').split(/\s+/)[0] ?? '').trim();
                problems.push(
                  `icon is ${box.height.toFixed(1)}px tall beside ${size}px text with a ${lineHeight.toFixed(1)}px line (in ${container.tagName.toLowerCase()}${name === '' ? '' : `.${name}`})`,
                );
              }
              break;
            }
          }
        }
        wrapper = container;
      }
    }
    return problems;
  }, ICON_SIZE_TOLERANCE);
}

/**
 * The tolerance of the attachment strip guards: one layout unit, 1/64 of a pixel, which is how
 * finely the browser places a box. A guard that compares two edges the same CSS puts on one line
 * must see them equal to the unit; it must not carry the pixel of slack the old shelf's measurement
 * did, which hid a real 1px miss and then failed intermittently.
 */
export const ATTACHMENT_STRIP_TOLERANCE = 1 / 64;

/** The tolerance for a glyph's centre against its text's first line (owner decision of 2026-11-13). */
export const ICON_CENTRE_TOLERANCE = 0.5;

/**
 * Measures the composer's attachment strip: every chip is one height; no chip's name is cut in the
 * middle (the extension is whole, the stem is the only part that shortens, and it shortens at its
 * end, so the text in the page is the file's whole name); no two remove controls' hit areas
 * overlap, a coarse pointer's being 44px square about the control's centre; the strip does not clip
 * a hit area; and the failure line's action ends at the line's trailing content edge (the left edge
 * in a right-to-left line).
 */
export async function readAttachmentStripProblems(page: Page): Promise<string[]> {
  return page.evaluate((tolerance) => {
    const problems: string[] = [];
    const coarse = matchMedia('(any-pointer: coarse)').matches;
    for (const strip of document.querySelectorAll<HTMLElement>('.chat-input-attachments')) {
      const chips = [...strip.querySelectorAll<HTMLElement>('.chat-attachment-preview')];
      const heights = chips.map((chip) => chip.getBoundingClientRect().height);
      if (heights.some((height) => Math.abs(height - (heights[0] ?? 0)) > tolerance)) {
        problems.push(
          `attachment chips are not one height (${[...new Set(heights)].join(', ')}px)`,
        );
      }
      for (const chip of chips) {
        const name = chip.querySelector<HTMLElement>('.chat-attachment-preview-name');
        const stem = chip.querySelector<HTMLElement>('.chat-attachment-preview-stem');
        const extension = chip.querySelector<HTMLElement>('.chat-attachment-preview-extension');
        if (name === null || stem === null || extension === null) {
          problems.push('an attachment chip has no name made of a stem and an extension');
          continue;
        }
        const text = name.textContent ?? '';
        const label = text.length > 24 ? `${text.slice(0, 24)}…` : text;
        // The chip shows the file's own name, or a start of its stem, one ellipsis, and its whole
        // extension with nothing between them. The full name is in the chip's title either way.
        const title = chip.getAttribute('title') ?? '';
        const stemText = stem.textContent ?? '';
        const extensionText = extension.textContent ?? '';
        const shortened = stemText.endsWith('…');
        const shownStart = shortened ? stemText.slice(0, -1) : stemText;
        const ownName = shortened
          ? shownStart.length > 0 &&
            !shownStart.includes('…') &&
            title.startsWith(shownStart) &&
            title.includes(extensionText) &&
            stem.hasAttribute('data-fitted')
          : !text.includes('…') && title.indexOf(text) === 0;
        if (!ownName) {
          problems.push(`attachment chip "${label}" shows a name that is not the file's own`);
        }
        // A shortened stem's ellipsis touches the extension: no gap reads as a detached fragment.
        if (shortened) {
          const gap =
            getComputedStyle(name).direction === 'rtl'
              ? stem.getBoundingClientRect().left - extension.getBoundingClientRect().right
              : extension.getBoundingClientRect().left - stem.getBoundingClientRect().right;
          if (Math.abs(gap) > 1) {
            problems.push(
              `attachment chip "${label}" leaves ${gap.toFixed(2)}px between its ellipsis and its extension`,
            );
          }
        }
        const nameBox = name.getBoundingClientRect();
        const extensionBox = extension.getBoundingClientRect();
        const rtl = getComputedStyle(name).direction === 'rtl';
        const insideInline = rtl
          ? extensionBox.left >= nameBox.left - tolerance
          : extensionBox.right <= nameBox.right + tolerance;
        if ((extension.textContent ?? '') !== '' && (!insideInline || extensionBox.width === 0)) {
          problems.push(`attachment chip "${label}" is cut inside its extension`);
        }
        if (stem.scrollWidth > stem.clientWidth) {
          // The stem is cut: it must be cut at its end with an ellipsis and keep a visible part.
          if (getComputedStyle(stem).textOverflow !== 'ellipsis') {
            problems.push(`attachment chip "${label}" is cut with no ellipsis`);
          }
          if (stem.getBoundingClientRect().width < 1) {
            problems.push(`attachment chip "${label}" shows none of its name before the extension`);
          }
        }
      }
      const stripBox = strip.getBoundingClientRect();
      const hits = [...strip.querySelectorAll<HTMLElement>('.chat-input-attachment-remove')].map(
        (button) => {
          const box = button.getBoundingClientRect();
          const width = coarse ? Math.max(box.width, 44) : box.width;
          const height = coarse ? Math.max(box.height, 44) : box.height;
          const centreX = box.left + box.width / 2;
          const centreY = box.top + box.height / 2;
          return {
            left: centreX - width / 2,
            right: centreX + width / 2,
            top: centreY - height / 2,
            bottom: centreY + height / 2,
          };
        },
      );
      hits.forEach((hit, index) => {
        const other = hits[index + 1];
        if (other !== undefined) {
          const across = Math.min(hit.right, other.right) - Math.max(hit.left, other.left);
          const down = Math.min(hit.bottom, other.bottom) - Math.max(hit.top, other.top);
          if (across > tolerance && down > tolerance) {
            problems.push(
              `remove controls ${index + 1} and ${index + 2} have overlapping hit areas`,
            );
          }
        }
        if (hit.top < stripBox.top - tolerance || hit.bottom > stripBox.bottom + tolerance) {
          problems.push(`remove control ${index + 1}'s hit area is clipped by the strip`);
        }
      });
    }
    for (const line of document.querySelectorAll<HTMLElement>('.chat-input-attachment-reason')) {
      // The trailing-most action, the last one drawn: with Remove failed and Retry N it is Retry N.
      const action = [...line.querySelectorAll<HTMLElement>('button')].at(-1) ?? null;
      if (action === null) {
        problems.push('the attachment failure line has no action');
        continue;
      }
      const style = getComputedStyle(line);
      const box = line.getBoundingClientRect();
      const rtl = style.direction === 'rtl';
      const edge = rtl
        ? box.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth)
        : box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
      const actionBox = action.getBoundingClientRect();
      const distance = Math.abs((rtl ? actionBox.left : actionBox.right) - edge);
      if (distance > tolerance) {
        problems.push(
          `the attachment failure line's action ends ${distance.toFixed(2)}px from the trailing edge`,
        );
      }
    }
    return problems;
  }, ATTACHMENT_STRIP_TOLERANCE);
}

/** The scroller each list a `scroll-list` step names. */
const LIST_SELECTORS = {
  'attachment-strip': '.chat-input-attachments',
  'question-choices': '.chat-question-dock-options-scroll',
} as const;

/** The scrollers the edge-fade guard requires to carry Cinder's edge fade, with the axis each scrolls on. */
export const EDGE_FADE_SCROLLERS = [
  { selector: '.chat-input-attachments', axis: 'inline', name: 'the attachment strip' },
  { selector: '.chat-question-dock-options-scroll', axis: 'block', name: 'the question choices' },
] as const;

/**
 * Measures the edge fade (owner decision of 2026-11-13): a scroller that is cut off fades the edge
 * past which content is hidden and only that edge. Each scroller the page holds (the strip and the
 * docked choices, and any other that sets `data-cinder-edge-fade`) must paint a mask, fade its
 * leading edge exactly while content is scrolled out of view before it, and its trailing edge
 * exactly while content lies out of view after it. A scroller whose content fits fades neither.
 * The fade of an edge is read from the length the mask gives it, so a mask that is set but has no
 * length on an edge is no fade.
 */
export async function readEdgeFadeProblems(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ known }) => {
      // Read at once, with no wait on a frame: a page that holds its clock still (the armed
      // approval's) never delivers a timer or a frame, so a wait here would never end. A step that
      // moves a list (`scroll-list`) waits for its fades itself.
      const problems: string[] = [];
      const scrollers = new Map<Element, { axis: string; name: string }>();
      for (const entry of known) {
        for (const element of document.querySelectorAll(entry.selector)) {
          scrollers.set(element, { axis: entry.axis, name: entry.name });
        }
      }
      for (const element of document.querySelectorAll('[data-cinder-edge-fade]')) {
        if (scrollers.has(element)) continue;
        scrollers.set(element, {
          axis: element.getAttribute('data-cinder-edge-fade') ?? 'block',
          name: 'a scroller with an edge fade',
        });
      }
      for (const [element, { axis, name }] of scrollers) {
        const style = getComputedStyle(element);
        const inline = axis === 'inline';
        const position = Math.abs(inline ? element.scrollLeft : element.scrollTop);
        const extent = inline ? element.scrollWidth : element.scrollHeight;
        const visible = inline ? element.clientWidth : element.clientHeight;
        const hiddenBefore = position > 1;
        const hiddenAfter = extent - visible - position > 1;
        // The mask's stop lengths are custom properties: `0px` while nothing is hidden, a line
        // length (`1.5lh`) while something is. Any positive number is a fade.
        const lengthOf = (property: string): number => {
          const length = Number.parseFloat(style.getPropertyValue(property));
          return Number.isFinite(length) ? length : 0;
        };
        const fadesBefore = lengthOf('--_cinder-edge-fade-start') > 0;
        const fadesAfter = lengthOf('--_cinder-edge-fade-end') > 0;
        const masked = style.maskImage !== 'none' && style.maskImage !== '';
        if (element.getAttribute('data-cinder-edge-fade') !== axis || !masked) {
          if (hiddenBefore || hiddenAfter)
            problems.push(`${name} is cut off and paints no edge fade`);
          continue;
        }
        const edges = inline ? ['leading', 'trailing'] : ['top', 'bottom'];
        if (hiddenBefore && !fadesBefore)
          problems.push(`${name} hides content past its ${edges[0]} edge and does not fade it`);
        if (!hiddenBefore && fadesBefore)
          problems.push(`${name} fades its ${edges[0]} edge with nothing hidden past it`);
        if (hiddenAfter && !fadesAfter)
          problems.push(`${name} hides content past its ${edges[1]} edge and does not fade it`);
        if (!hiddenAfter && fadesAfter)
          problems.push(`${name} fades its ${edges[1]} edge with nothing hidden past it`);
      }
      return problems;
    },
    { known: EDGE_FADE_SCROLLERS },
  );
}

/**
 * Measures that a glyph and the text it shares a row with are centred on one line (owner decision
 * of 2026-11-13): for an `svg` in a flex or grid row that holds visible text, inside a control or a
 * labelled row, the vertical centre of the glyph's box and of the text's first line box differ by
 * at most half a pixel. The line box is the text's own (its block's content top plus half its line
 * height), not the font's content area, because the browser floors a line's half-leading to a
 * whole pixel and draws 13px text on a 19.5px line 0.75px above the line's centre however the
 * row is aligned. The row is found as {@link readIconSizeProblems} finds it. A glyph that is the
 * only content of its control, a glyph stacked above its text, and tooltips are not measured.
 */
export async function readIconCentreProblems(page: Page): Promise<string[]> {
  return page.evaluate((tolerance) => {
    const problems: string[] = [];
    const hidden = '[role="tooltip"], .cinder-sr-only, [hidden], [aria-hidden="true"] svg *';
    const inControlOrLabelledRow =
      'button, a[href], summary, [role="button"], [aria-label], [aria-labelledby], label, li';
    const textOf = (node: Node): string => (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    /** The first line of the text itself: a range over an element also answers the boxes of its children. */
    const firstLine = (node: Node): DOMRect | undefined => {
      const texts: Node[] = [];
      if (node.nodeType === Node.TEXT_NODE) texts.push(node);
      else {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        for (let next = walker.nextNode(); next !== null; next = walker.nextNode())
          texts.push(next);
      }
      for (const text of texts) {
        if (textOf(text) === '' || text.parentElement?.closest(hidden) != null) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        const line = [...range.getClientRects()].find((rectangle) => rectangle.height > 0);
        if (line !== undefined) return line;
      }
      return undefined;
    };
    /**
     * The vertical centre of the first line of the text beside a glyph: the first line box, not the
     * font's content area. The browser floors a line's half-leading to a whole pixel, so a 13px text
     * on a 19.5px line draws its letters 0.75px above the line's centre however the row is
     * aligned, and a glyph centred on the line would read as off by that much. A text that is
     * itself a flex or grid item has no line box of its own to read, and its client rectangle is
     * used.
     */
    const lineBoxCentre = (beside: Node, container: Element, line: DOMRect): number => {
      const walker = document.createTreeWalker(beside, NodeFilter.SHOW_TEXT);
      let text: Node | null = beside.nodeType === Node.TEXT_NODE ? beside : walker.nextNode();
      while (text !== null && textOf(text) === '') text = walker.nextNode();
      let block = text?.parentElement ?? null;
      while (
        block !== null &&
        block !== container &&
        getComputedStyle(block).display.startsWith('inline') &&
        !/^inline-(flex|grid)$/.test(getComputedStyle(block).display)
      ) {
        block = block.parentElement;
      }
      if (block === null || block === container) {
        // Text that is a flex or grid item itself: its rectangle is the font's content area, placed
        // a floored half-leading below the top of its line box.
        const lineHeight = parseFloat(getComputedStyle(container).lineHeight);
        if (!Number.isFinite(lineHeight)) return line.top + line.height / 2;
        const lineTop = line.top - Math.floor((lineHeight - line.height) / 2);
        return lineTop + lineHeight / 2;
      }
      // A block trimmed to its capitals (`text-box-trim`) starts at its first line's capitals, not
      // at its line box, so its top says nothing about where the line stands: the line's centre is
      // the capitals' centre, from the baseline the font's ascent puts under the text's own
      // rectangle, as `readCalloutInsets` measures a notice's ink.
      for (
        let ancestor: Element | null = block;
        ancestor !== null && ancestor !== container;
        ancestor = ancestor.parentElement
      ) {
        const trim = getComputedStyle(ancestor).getPropertyValue('text-box-trim');
        if (trim === '' || trim === 'none') continue;
        const holder = getComputedStyle(text?.parentElement ?? block);
        const canvas = document.createElement('canvas').getContext('2d');
        if (canvas === null) return line.top + line.height / 2;
        canvas.font = `${holder.fontStyle} ${holder.fontWeight} ${holder.fontSize} ${holder.fontFamily}`;
        const measured = canvas.measureText('H');
        return line.top + measured.fontBoundingBoxAscent - measured.actualBoundingBoxAscent / 2;
      }
      const style = getComputedStyle(block);
      const lineHeight = parseFloat(style.lineHeight);
      if (!Number.isFinite(lineHeight)) return line.top + line.height / 2;
      const top =
        block.getBoundingClientRect().top +
        parseFloat(style.borderTopWidth) +
        parseFloat(style.paddingTop);
      return top + lineHeight / 2;
    };
    for (const glyph of document.querySelectorAll<SVGElement>('svg')) {
      if (glyph.closest(hidden) !== null) continue;
      const box = glyph.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      let wrapper: Element = glyph;
      for (let level = 0; level < 3; level += 1) {
        if (wrapper.matches('button, a[href], summary, [role="button"]')) break;
        const container = wrapper.parentElement;
        if (container === null || container === document.body) break;
        if (/^(inline-)?(flex|grid)$/.test(getComputedStyle(container).display)) {
          const beside = [...container.childNodes].find((node) => {
            if (node === wrapper || node.contains(glyph)) return false;
            if (node.nodeType === Node.ELEMENT_NODE) {
              const element = node as Element;
              if (element.closest(hidden) !== null || getComputedStyle(element).display === 'none')
                return false;
              if (element.querySelector('svg') !== null && textOf(element) === '') return false;
            } else if (node.nodeType !== Node.TEXT_NODE) {
              return false;
            }
            // A label visually hidden by a 1px clip box (a button that shows only its glyph) is
            // text no one sees, though its letters keep their layout width.
            const owner = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : null;
            if (owner !== null) {
              const clip = owner.getBoundingClientRect();
              if (clip.width <= 1 || clip.height <= 1) return false;
            }
            return textOf(node) !== '' && (firstLine(node)?.width ?? 0) > 1;
          });
          const line = beside === undefined ? undefined : firstLine(beside);
          if (beside !== undefined && line !== undefined) {
            const overlap = Math.min(line.bottom, box.bottom) - Math.max(line.top, box.top);
            if (overlap > 0) {
              if (container.closest(inControlOrLabelledRow) !== null) {
                const difference = Math.abs(
                  box.top + box.height / 2 - lineBoxCentre(beside, container, line),
                );
                if (difference > tolerance) {
                  const name = (
                    (container.getAttribute('class') ?? '').split(/\s+/)[0] ?? ''
                  ).trim();
                  problems.push(
                    `glyph centre is ${difference.toFixed(2)}px off its text's first line (in ${container.tagName.toLowerCase()}${name === '' ? '' : `.${name}`})`,
                  );
                }
              }
              break;
            }
          }
        }
        wrapper = container;
      }
    }
    return problems;
  }, ICON_CENTRE_TOLERANCE);
}

/** How far the two spacings of the step row may differ, in pixels (owner decision of 2026-11-13). */
export const STEP_ROW_SPACING_TOLERANCE = 1;

/** The two distances the step row's spacing is judged by, in pixels, measured between drawn ink. */
export interface StepRowSpacing {
  /** From the baseline of the collapsed step row's text to the top of the capitals of the answer's first line. */
  readonly stepToAnswer: number;
  /** From the baseline of an assistant message's last text line to the top of the capitals of its time. */
  readonly betweenParts: number;
}

/**
 * Measures how far the answer stands under a collapsed step row, and how far an assistant
 * message's text stands over its time, from the letters' ink: a baseline above, the top of the
 * capitals below. A box edge is not ink: the leading of a line puts air above and below the
 * letters, so two gaps between boxes can differ by many pixels where the letters are the same
 * distance apart. A text rectangle starts at the font's ascent, so a line's baseline is its top
 * plus the font's ascent and its capitals' top is the baseline less the height of an `H`, both read
 * from the font the text is drawn in. `undefined` when the page has no collapsed step row, no
 * answer after it, or no assistant message with a time.
 */
export async function readStepRowSpacing(page: Page): Promise<StepRowSpacing | undefined> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas').getContext('2d');
    if (canvas === null) return undefined;
    /** The baseline and capital top of one line of text, from its rectangle and its font. */
    const ink = (
      root: Element,
      which: 'first' | 'last',
    ): { baseline: number; capTop: number } | undefined => {
      let found: { rectangle: DOMRect; holder: Element } | undefined;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const holder = node.parentElement;
        if (holder === null || (node.textContent ?? '').trim() === '') continue;
        if (holder.closest('.cinder-sr-only, [role="tooltip"], [hidden]') !== null) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rectangles = [...range.getClientRects()].filter((rectangle) => rectangle.height > 0);
        const rectangle = which === 'first' ? rectangles[0] : rectangles.at(-1);
        if (rectangle === undefined) continue;
        // The first line is the highest one found, and the last line the lowest.
        const better =
          found === undefined ||
          (which === 'first'
            ? rectangle.top < found.rectangle.top
            : rectangle.bottom > found.rectangle.bottom);
        if (better) found = { rectangle, holder };
      }
      if (found === undefined) return undefined;
      const style = getComputedStyle(found.holder);
      canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const ascent = canvas.measureText('H').fontBoundingBoxAscent;
      const capital = canvas.measureText('H').actualBoundingBoxAscent;
      const baseline = found.rectangle.top + ascent;
      return { baseline, capTop: baseline - capital };
    };
    const toggle = document.querySelector<HTMLElement>(
      '.chat-tool-call-toggle[aria-expanded="false"]',
    );
    if (toggle === null) return undefined;
    const bodies = [...document.querySelectorAll<HTMLElement>('.chat-message-body')];
    const answer = bodies.find(
      (body) => (toggle.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    );
    // The message whose text and time are compared: the answer itself when it has a time, and
    // otherwise any assistant message that does.
    const assistants = [
      ...document.querySelectorAll<HTMLElement>('.chat-message-wrapper[data-role="assistant"]'),
    ];
    const timed = assistants.filter((wrapper) => wrapper.querySelector('.chat-message-line time'));
    const message =
      timed.find((wrapper) => wrapper.contains(answer ?? null)) ??
      timed.find((wrapper) => wrapper.querySelector('.chat-message-body') !== null);
    const body = message?.querySelector('.chat-message-body');
    const time = message?.querySelector('.chat-message-line time');
    if (answer === undefined || body == null || time == null) return undefined;
    const step = ink(toggle, 'last');
    const answerFirst = ink(answer, 'first');
    const messageLast = ink(body, 'last');
    const timeTop = ink(time, 'first');
    if (
      step === undefined ||
      answerFirst === undefined ||
      messageLast === undefined ||
      timeTop === undefined
    ) {
      return undefined;
    }
    return {
      stepToAnswer: answerFirst.capTop - step.baseline,
      betweenParts: timeTop.capTop - messageLast.baseline,
    };
  });
}

/** The step row's two spacings as problems: none when they are within {@link STEP_ROW_SPACING_TOLERANCE}. */
export function stepRowSpacingProblems(spacing: StepRowSpacing | undefined): string[] {
  if (spacing === undefined)
    return ['the step row, its answer and a message with a time were not found'];
  const difference = Math.abs(spacing.stepToAnswer - spacing.betweenParts);
  return difference <= STEP_ROW_SPACING_TOLERANCE
    ? []
    : [
        `the answer is ${spacing.stepToAnswer.toFixed(2)}px under the step row's text but a message's text is ${spacing.betweenParts.toFixed(2)}px above its time`,
      ];
}

/**
 * A turn that stopped or failed after only narration reads in the order it happened (owner
 * decision of 2026-11-13): the narration, the step row, then the notice with the time under it. A
 * notice between the narration and the step row makes the step row look like a new turn. Judged by
 * where each is painted: the step row sits below the narration and above the notice, and the time
 * sits below the notice.
 */
export async function readStoppedTurnOrderProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const painted = (selector: string): DOMRect | undefined =>
      document.querySelector(selector)?.getBoundingClientRect();
    const narration = painted('.chat-message-wrapper[data-narration] .chat-message-body');
    const stepRow = painted('.chat-tool-call-timeline');
    const notice = painted('.chat-turn-outcome');
    const time = painted('.chat-turn-outcome ~ .chat-message-line time');
    const missing = [
      narration === undefined ? 'the narration' : undefined,
      stepRow === undefined ? 'the step row' : undefined,
      notice === undefined ? 'the notice' : undefined,
      time === undefined ? 'the time under the notice' : undefined,
    ].filter((name) => name !== undefined);
    if (missing.length > 0) return [`${missing.join(', ')} not found in the stopped turn`];
    const problems: string[] = [];
    if (stepRow!.top < narration!.bottom) {
      problems.push('the step row is above the narration');
    }
    if (stepRow!.top >= notice!.top) {
      problems.push('the step row comes after the notice, so it reads as a new turn');
    }
    if (time!.top < notice!.bottom) problems.push('the time is above the notice');
    // The notice is a box with no leading above its first ink, so the step row's spacing to an
    // answer's text (a pull of its own) must not reach it: it keeps at least a row gap.
    const crowding = notice!.top - stepRow!.bottom;
    if (stepRow!.top < notice!.top && crowding < 6) {
      problems.push(
        `the notice is ${crowding.toFixed(1)}px under the step row, crowded against it`,
      );
    }
    return problems;
  });
}

/**
 * A settled turn is its step row and its answer (owner decision of 2026-11-13): the agent's lines
 * between steps live inside the row. Proves it from the page: exactly one step row, every line of
 * `narration` present inside that row, and none of them visible anywhere outside it.
 */
export async function readNarrationFoldProblems(
  page: Page,
  narration: readonly string[],
): Promise<string[]> {
  return page.evaluate((lines) => {
    const problems: string[] = [];
    const rows = document.querySelectorAll('.chat-tool-call-timeline').length;
    if (rows !== 1) problems.push(`a settled turn shows ${rows} step rows, not one`);
    for (const line of lines) {
      let inside = 0;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const holder = node.parentElement;
        if (holder === null || !(node.textContent ?? '').includes(line)) continue;
        if (holder.closest('.chat-tool-call-timeline') !== null) {
          inside += 1;
        } else if (
          holder.closest('.cinder-sr-only, [role="tooltip"]') === null &&
          holder.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })
        ) {
          problems.push(`the narration "${line}" is visible outside the step row`);
        }
      }
      if (inside === 0) problems.push(`the narration "${line}" is not inside the step row`);
    }
    return problems;
  }, narration);
}

/**
 * In the opened step row, narration reads quieter than the answer: its text colour and its size
 * differ from the answer's, and it is the smaller. Compared on the elements that hold the letters,
 * so a wrapper's inherited value cannot stand in for what is painted.
 */
export async function readNarrationStyleProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const textHolder = (root: Element): HTMLElement | undefined => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if ((node.textContent ?? '').trim() !== '') return node.parentElement ?? undefined;
      }
      return undefined;
    };
    const narration = [...document.querySelectorAll('.chat-tool-call-narration')].filter((line) =>
      line.checkVisibility({ visibilityProperty: true }),
    );
    if (narration.length === 0) return ['no narration line is visible in the opened step row'];
    const answerBody = [...document.querySelectorAll('.chat-message-body')]
      .filter((body) => body.closest('.chat-tool-call-timeline') === null)
      .at(-1);
    const answer = answerBody === undefined ? undefined : textHolder(answerBody);
    if (answer === undefined) return ['the answer has no text to compare the narration with'];
    const answerStyle = getComputedStyle(answer);
    const problems: string[] = [];
    for (const line of narration) {
      const holder = textHolder(line);
      if (holder === undefined) continue;
      const style = getComputedStyle(holder);
      const label = (line.textContent ?? '').trim().slice(0, 40);
      if (style.color === answerStyle.color) {
        problems.push(`the narration "${label}" has the answer's colour ${style.color}`);
      }
      if (style.fontSize === answerStyle.fontSize) {
        problems.push(`the narration "${label}" has the answer's size ${style.fontSize}`);
      } else if (parseFloat(style.fontSize) > parseFloat(answerStyle.fontSize)) {
        problems.push(
          `the narration "${label}" is ${style.fontSize}, larger than the answer's ${answerStyle.fontSize}`,
        );
      }
    }
    return problems;
  });
}

/**
 * What sits under an assistant line that was written while the agent works (owner decision of
 * 2026-11-14). Bare narration, text the agent wrote and then kept working, has no message line: no
 * time and no Copy, Quote or Regenerate. Narration that asks, directly before a pending approval,
 * question or tool input, is the agent talking to the person and keeps its time and its actions.
 * Judged from the DOM under every narration wrapper, so a hidden or absent control cannot pass as
 * the other kind.
 *
 * @param page - The captured page
 * @param kind - `'bare'` expects no time and no action buttons; `'asking'` expects both
 */
export async function readNarrationLineProblems(
  page: Page,
  kind: 'bare' | 'asking',
): Promise<string[]> {
  return page.evaluate((expected) => {
    const wrappers = [...document.querySelectorAll('.chat-message-wrapper[data-narration]')].filter(
      (wrapper) => wrapper.closest('.chat-tool-call-timeline') === null,
    );
    if (wrappers.length === 0) return ['no narration message was found on the page'];
    const problems: string[] = [];
    for (const wrapper of wrappers) {
      const label = (wrapper.querySelector('.chat-message-body')?.textContent ?? '')
        .trim()
        .slice(0, 40);
      const times = wrapper.querySelectorAll('.chat-message-line time').length;
      const buttons = wrapper.querySelectorAll('.chat-message-line-actions button').length;
      if (expected === 'bare') {
        if (times > 0) problems.push(`the narration "${label}" has a time under it`);
        if (buttons > 0) {
          problems.push(`the narration "${label}" has ${buttons} action buttons under it`);
        }
      } else {
        if (times === 0) problems.push(`the asking text "${label}" has no time under it`);
        if (buttons === 0) problems.push(`the asking text "${label}" has no action buttons`);
        // It reads as a message, not as narration: the letters' colour and size equal an answer's.
        // The answer's value is measured on a hidden copy of the same wrapper with the narration
        // marks removed, in the same place, so the page's own rules say what an answer is.
        const holderOf = (root: Element): HTMLElement | undefined => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            if ((node.textContent ?? '').trim() !== '') return node.parentElement ?? undefined;
          }
          return undefined;
        };
        const ownHolder = holderOf(wrapper.querySelector('.chat-message-body') ?? wrapper);
        const probe = wrapper.cloneNode(true) as HTMLElement;
        probe.removeAttribute('data-narration');
        probe.removeAttribute('data-asking');
        probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
        wrapper.after(probe);
        const answerHolder = holderOf(probe.querySelector('.chat-message-body') ?? probe);
        if (ownHolder !== undefined && answerHolder !== undefined) {
          const own = getComputedStyle(ownHolder);
          const answer = getComputedStyle(answerHolder);
          if (own.color !== answer.color) {
            problems.push(
              `the asking text "${label}" is ${own.color}, not an answer's ${answer.color}`,
            );
          }
          if (own.fontSize !== answer.fontSize) {
            problems.push(
              `the asking text "${label}" is ${own.fontSize}, not an answer's ${answer.fontSize}`,
            );
          }
        }
        probe.remove();
      }
    }
    return problems;
  }, kind);
}

/**
 * Measures that no composer notice (the blocked, archived and read-only bars, and the drawers
 * above the composer) loses a word of its text: none is cut by the notice's own edge or by a
 * clipping ancestor, and none lies under a control of the same notice. A drawn word is a line
 * rectangle of its text, so a word painted behind a button or past the border is found where a box
 * comparison would pass it ("Archived N" under a New chat button).
 *
 * @param page - The captured page
 */
export async function readComposerNoticeProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const roots = document.querySelectorAll<HTMLElement>(
      '.chat-input-blocked, [data-chat-composer-drawer]',
    );
    for (const root of roots) {
      const rootStyle = getComputedStyle(root);
      if (rootStyle.display === 'none' || rootStyle.visibility === 'hidden') continue;
      const rootBox = root.getBoundingClientRect();
      if (rootBox.width === 0 || rootBox.height === 0) continue;
      const name =
        root.getAttribute('data-chat-composer-status') ??
        root.getAttribute('data-chat-composer-drawer') ??
        'blocked';
      const controls = [...root.querySelectorAll<HTMLElement>('button, a[href]')]
        .filter((control) => control.closest('[role="tooltip"], .cinder-sr-only') === null)
        .map((control) => ({ control, box: control.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && box.height > 0);
      // The drawn ink of the bar: the capitals of its words and the faces of its controls. The
      // capitals of a line stand `1cap` tall about the middle of its line, so a word's ink is the
      // line rectangle's centre plus and minus half of that, never the box of the text.
      let inkTop = Number.POSITIVE_INFINITY;
      let inkBottom = Number.NEGATIVE_INFINITY;
      for (const { box } of controls) {
        inkTop = Math.min(inkTop, box.top);
        inkBottom = Math.max(inkBottom, box.bottom);
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const holder = node.parentElement;
        const words = (node.textContent ?? '').trim();
        if (
          holder === null ||
          words === '' ||
          holder.closest('button, a[href], [role="tooltip"], .cinder-sr-only, [hidden]') !== null
        ) {
          continue;
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        const lines = [...range.getClientRects()].filter(
          (rect) => rect.width > 0 && rect.height > 0,
        );
        if (root.classList.contains('chat-input-blocked') && lines.length > 0) {
          const probe = document.createElement('span');
          probe.style.cssText = 'position:absolute;visibility:hidden;block-size:1cap;inline-size:0';
          holder.append(probe);
          const capitals = probe.getBoundingClientRect().height;
          probe.remove();
          for (const rect of lines) {
            const middle = rect.top + rect.height / 2;
            inkTop = Math.min(inkTop, middle - capitals / 2);
            inkBottom = Math.max(inkBottom, middle + capitals / 2);
          }
        }
        const label = `${name} notice "${words.slice(0, 40)}"`;
        const outside = lines.some(
          (rect) =>
            rect.left < rootBox.left - 1 ||
            rect.right > rootBox.right + 1 ||
            rect.top < rootBox.top - 1 ||
            rect.bottom > rootBox.bottom + 1,
        );
        let clipped = outside;
        for (let up: HTMLElement | null = holder; up !== null && up !== root && !clipped;) {
          const style = getComputedStyle(up);
          if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
            const box = up.getBoundingClientRect();
            clipped = lines.some((rect) => rect.right > box.right + 1 || rect.left < box.left - 1);
          }
          up = up.parentElement;
        }
        if (clipped) problems.push(`the ${label} is cut off by its own edge or a clipping parent`);
        for (const { control, box } of controls) {
          const covered = lines.some(
            (rect) =>
              Math.min(rect.right, box.right) - Math.max(rect.left, box.left) > 1 &&
              Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top) > 1,
          );
          if (covered) {
            const controlName = (control.getAttribute('aria-label') ?? control.textContent ?? '')
              .trim()
              .slice(0, 30);
            problems.push(`the ${label} lies under the control "${controlName}"`);
          }
        }
      }
      if (root.classList.contains('chat-input-blocked') && Number.isFinite(inkTop)) {
        const above = inkTop - rootBox.top;
        const below = rootBox.bottom - inkBottom;
        if (Math.abs(above - below) > 1) {
          problems.push(
            `the ${name} notice's ink stands ${Math.round(above * 10) / 10}px under its top border and ${Math.round(below * 10) / 10}px over its bottom one`,
          );
        }
      }
    }
    return problems;
  });
}

/**
 * Measures that Jump to latest lies on no text of the transcript at rest: no drawn line of a word
 * that shows inside the transcript's own box is met by the painted circle of the button. A word is
 * a line rectangle of its text and the button a circle, so a line that only shares a corner of the
 * button's box passes, and a word under the button (the duration of a step row) fails.
 *
 * @param page - The captured page
 */
export async function readJumpOverlapProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const transcript = document.querySelector<HTMLElement>('.chat-timeline');
    const button = [...document.querySelectorAll<HTMLElement>('.chat-jump-button')].find(
      (candidate) => {
        const style = getComputedStyle(candidate);
        const box = candidate.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0;
      },
    );
    if (transcript === null || button === undefined) return problems;
    const visible = transcript.getBoundingClientRect();
    const circle = button.getBoundingClientRect();
    const radius = Math.min(circle.width, circle.height) / 2;
    const centreX = circle.left + circle.width / 2;
    const centreY = circle.top + circle.height / 2;
    const walker = document.createTreeWalker(transcript, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const holder = node.parentElement;
      const words = (node.textContent ?? '').trim();
      if (holder === null || words === '') continue;
      if (holder.closest('[hidden], [aria-hidden="true"], .cinder-sr-only, script, style'))
        continue;
      const style = getComputedStyle(holder);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        const left = Math.max(rect.left, visible.left);
        const right = Math.min(rect.right, visible.right);
        const top = Math.max(rect.top, visible.top);
        const bottom = Math.min(rect.bottom, visible.bottom);
        if (right - left <= 0 || bottom - top <= 0) continue;
        const nearestX = Math.min(Math.max(centreX, left), right);
        const nearestY = Math.min(Math.max(centreY, top), bottom);
        const depth = radius - Math.hypot(centreX - nearestX, centreY - nearestY);
        if (depth > 1) {
          problems.push(`Jump to latest lies on the text "${words.slice(0, 40)}"`);
          break;
        }
      }
    }
    return problems;
  });
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
      if (stressCase.id !== 47) await waitForFinalCaptureReadiness(opened.page);
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
              control.reachableHeight < control.hitHeight ||
              control.samples.some((sample) => !sample.hitsTarget),
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
      await waitForFinalCaptureReadiness(opened.page);
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
  await prepareManifest(defaultManifestLayout);
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
