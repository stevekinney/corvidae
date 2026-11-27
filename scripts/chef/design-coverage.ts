#!/usr/bin/env bun
// The coverage ledger a design review keeps before it may approve (`design-review` skill,
// "The coverage ledger").
//
// Usage:
//   bun scripts/chef/design-coverage.ts check --capture <capture directory> --ledger <ledger file>
//
// A review approved milestone 2 of the Temporal UI on 2026-11-26 without opening one of its captures
// (the typed filter left open), with one sentence of cold judgement for six pages, and with no look
// at section rhythm, grouping, column widths or labels. The owner then found eight defects, seven
// of them in captures the review had. Notes saying "judge cold first" had been written down three
// times by then, so the ledger makes the review leave a record a script can hold it to.
//
// The ledger is pipe-separated, one line per entry, no header; a literal `|` becomes `/`:
//
//   screen | <viewport image, relative to the capture> | good|wrong|unsure | <cold verdict>
//   sweep  | <category>                                 | clear|found        | <evidence>
//   state  | <a state one click away>                   | <viewport image, or "not captured">
//
// Every viewport image in the capture (each `.png` that isn't a `.full.png`) needs exactly one
// screen line, with its own verdict of at least `MINIMUM_VERDICT_WORDS` words, written before the
// review looks at the design reference or the departures. Every sweep category needs at least one
// line; a ledger concatenated from area dispatches has one per area, and any `found` blocks. A
// state line names an image in the capture, or says it wasn't captured.
//
// Exit 0: complete, and nothing blocks approval. Exit 1: incomplete or malformed. Exit 3: complete,
// but a screen is wrong or unsure, a sweep found something, or a state wasn't captured, so the review
// cannot approve. Exit 2: invalid usage.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { emitResult, parseOptions, UsageError } from './process-runner.ts';

export { UsageError };

/** The kinds of defect no catalogue covered when the owner found them; each review answers every one. */
export const SWEEP_CATEGORIES = [
  'proximity',
  'rhythm-across-pages',
  'column-sizing',
  'label-clarity',
  'duplicate-actions',
  'hidden-primary-controls',
] as const;

/** The fewest words a cold verdict can say what a screen does and whether it works. */
const MINIMUM_VERDICT_WORDS = 8;

const SCREEN_VERDICTS = ['good', 'wrong', 'unsure'] as const;
const SWEEP_VERDICTS = ['clear', 'found'] as const;
const NOT_CAPTURED = 'not captured';

/** Every viewport image under a capture directory, relative to it and sorted. */
export function viewportCaptures(directory: string): string[] {
  const root = resolve(directory);
  const images: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.png') && !entry.name.endsWith('.full.png'))
        images.push(relative(root, path));
    }
  };
  walk(root);
  return images.toSorted();
}

/** What a ledger lacks (`problems`) and, once it is complete, what stops approval (`blocking`). */
export interface LedgerCheck {
  readonly problems: string[];
  readonly blocking: string[];
  readonly screens: number;
}

function normalised(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Checks a ledger's text against the viewport images in a capture directory. */
export function checkLedger(directory: string, text: string): LedgerCheck {
  const captures = viewportCaptures(directory);
  const known = new Set(captures);
  const problems: string[] = [];
  const blocking: string[] = [];
  if (captures.length === 0) problems.push('the capture has no viewport images to judge');
  const judged = new Map<string, string>();
  const verdictTexts = new Map<string, string>();
  const swept = new Set<string>();
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    const label = `ledger line ${index + 1}`;
    const fields = line.split('|').map((field) => field.trim());
    const [kind = '', subject = '', verdict = '', evidence = ''] = fields;
    if (kind === 'screen') {
      if (fields.length !== 4) {
        problems.push(`${label}: expected "screen | image | verdict | cold verdict"`);
        continue;
      }
      if (!known.has(subject)) problems.push(`${subject} is not a viewport capture here`);
      if (judged.has(subject)) problems.push(`${label}: ${subject} is judged twice`);
      if (!(SCREEN_VERDICTS as readonly string[]).includes(verdict))
        problems.push(`${label}: "${verdict}" is not one of ${SCREEN_VERDICTS.join(', ')}`);
      const words = evidence.split(/\s+/).filter(Boolean).length;
      if (words < MINIMUM_VERDICT_WORDS)
        problems.push(
          `${label}: the cold verdict for ${subject} needs at least ${MINIMUM_VERDICT_WORDS} words saying what the screen does and whether it works`,
        );
      const key = normalised(evidence);
      const earlier = verdictTexts.get(key);
      if (key !== '' && earlier !== undefined)
        problems.push(
          `${label}: ${subject} repeats the verdict written for ${earlier}; judge each screen on its own`,
        );
      else verdictTexts.set(key, subject);
      judged.set(subject, verdict);
    } else if (kind === 'sweep') {
      if (fields.length !== 4) {
        problems.push(`${label}: expected "sweep | category | clear or found | evidence"`);
        continue;
      }
      if (!(SWEEP_CATEGORIES as readonly string[]).includes(subject))
        problems.push(`${label}: "${subject}" is not one of ${SWEEP_CATEGORIES.join(', ')}`);
      swept.add(subject);
      if (!(SWEEP_VERDICTS as readonly string[]).includes(verdict))
        problems.push(`${label}: "${verdict}" is not one of ${SWEEP_VERDICTS.join(', ')}`);
      if (evidence === '') problems.push(`${label}: sweep ${subject} needs evidence`);
      // A capture reviewed in several area dispatches has one sweep line per area for each
      // category; any area that found something blocks, once.
      if (verdict === 'found' && !blocking.includes(`sweep ${subject}: found`))
        blocking.push(`sweep ${subject}: found`);
    } else if (kind === 'state') {
      if (fields.length !== 3 || subject === '') {
        problems.push(`${label}: expected "state | description | image or not captured"`);
        continue;
      }
      if (verdict === NOT_CAPTURED) blocking.push(`state ${subject}: not captured`);
      else if (!known.has(verdict))
        problems.push(`state ${subject} names ${verdict}, which is not a viewport capture here`);
    } else {
      problems.push(`${label}: starts with "${kind}", not screen, sweep or state`);
    }
  }
  for (const capture of captures)
    if (!judged.has(capture))
      problems.push(`no cold verdict for ${capture}: open it and judge it before any comparison`);
  for (const category of SWEEP_CATEGORIES)
    if (!swept.has(category)) problems.push(`sweep category ${category} is not answered`);
  const screenBlocks = captures.flatMap((capture) => {
    const verdict = judged.get(capture);
    if (verdict === 'wrong') return [`${capture}: wrong`];
    if (verdict === 'unsure') return [`${capture}: unsure, show the owner`];
    return [];
  });
  return { problems, blocking: [...screenBlocks, ...blocking], screens: judged.size };
}

export function run(argv: string[]): { code: number; output: string } {
  const parsed = parseOptions(argv, { values: ['capture', 'ledger'] });
  if (parsed.positionals[0] !== 'check' || parsed.positionals.length !== 1)
    throw new UsageError(
      'Usage: design-coverage.ts check --capture <capture directory> --ledger <ledger file>',
    );
  const capture = parsed.values['capture'];
  const ledger = parsed.values['ledger'];
  if (capture === undefined || ledger === undefined)
    throw new UsageError('--capture and --ledger are required.');
  const result = checkLedger(capture, readFileSync(resolve(ledger), 'utf8'));
  if (result.problems.length > 0)
    return { code: 1, output: `incomplete ledger:\n${result.problems.join('\n')}` };
  const summary = `${result.screens} screens judged`;
  if (result.blocking.length > 0)
    return {
      code: 3,
      output: `${summary}; approval blocked:\n${result.blocking.join('\n')}`,
    };
  return { code: 0, output: `${summary}; nothing blocks approval` };
}

if (import.meta.main) {
  try {
    const result = run(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), result);
    process.exitCode = result.code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
