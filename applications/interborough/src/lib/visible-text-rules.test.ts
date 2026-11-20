/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import {
  forbiddenVisibleText,
  PATH_ALLOWED_SELECTOR,
  visibleTextOutsideCopyControls,
} from './visible-text-rules.ts';

const ULID = '01M7T2Y5QK3R8V9W0X1Y2Z3A4B';

// Owner, 2026-11-19: Health's header said "Running on SQLite in /var/folders/…", Settings listed
// three temp-folder paths and `workspace:01M7T2Y5…/anthropic-api-key` for four providers, and the
// sweep found `/tmp/interborough-e2e-…` on Health, Workers and a skill's page.
describe('what no page says in its own words', () => {
  test.each([
    'Running on SQLite in /var/folders/x7/interborough-desktop-smoke-home',
    'Saved in /Users/someone/.interborough',
    'Saved in /home/someone/.interborough',
    'Add a file to ~/.interborough/workflows',
    'Saved in C:\\Users\\someone',
    'Running on SQLite in /tmp/interborough-e2e-fJtDEL/home',
    'Running on SQLite in /private/var/folders/x7/home',
  ])('a host path: %s', (text) => {
    expect(forbiddenVisibleText(text).map((finding) => finding.rule)).toContain('host path');
  });

  test('a secret reference, and a ULID on its own', () => {
    expect(
      forbiddenVisibleText(`workspace:${ULID}/anthropic-api-key`).map((finding) => finding.rule),
    ).toEqual(['secret reference', 'ULID']);
    expect(forbiddenVisibleText(`Run ${ULID} finished`).map((finding) => finding.rule)).toEqual([
      'ULID',
    ]);
  });

  test('says nothing about ordinary words, a relative path, or a word that only looks long', () => {
    for (const text of [
      'Running on SQLite',
      'agents/tool-runner.md',
      'Key saved',
      'No key yet',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ is the alphabet',
      `x${ULID}`,
    ]) {
      expect(forbiddenVisibleText(text)).toEqual([]);
    }
  });

  test('reads the page’s own words and leaves out what sits in a copy control or is hidden', () => {
    const window = new Window();
    const document = window.document;
    document.body.innerHTML = `
      <main>
        <h1>Health</h1>
        <p>Running on SQLite</p>
        <span class="cinder-copyable-value">/Users/someone/.interborough</span>
        <span hidden>/tmp/hidden</span>
        <span aria-hidden="true">/tmp/decorative</span>
      </main>`;
    const text = visibleTextOutsideCopyControls(
      document.querySelector('main') as unknown as Element,
      PATH_ALLOWED_SELECTOR,
    );
    expect(text).toContain('Running on SQLite');
    expect(forbiddenVisibleText(text)).toEqual([]);
    window.happyDOM.close();
  });
});
