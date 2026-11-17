/**
 * COR-2439: the deferred built-in strings of Chat's content read the one `labels` object (built
 * under COR-2438), and the broken-image placeholder draws Cinder's ImageOff icon.
 *
 * Asserts, by criterion:
 *   AC2  (COR-2259) the Sources panel's name, its count, and the no-link and unsafe-link notes
 *        render the values passed in Chat's `labels`.
 *   AC3  (COR-2257 X6) Chat passes those words through to Citation's own `labels`.
 *   AC12 (COR-2279 X5) the broken-image placeholder draws the ImageOff icon.
 *   AC13 (COR-2279) its "didn't load" and Retry words render the values passed in `labels`.
 *   AC17 (COR-2276) an open code fence's Writing status renders the value passed in `labels`.
 *   AC18 (COR-2261) a wide table's "Scrollable table", "+N columns" and "Scroll to see all
 *        columns" render the values passed in `labels`.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tick } from 'svelte';

import type { CitationSource } from '@lostgradient/cinder';
import { setupHappyDom } from '@lostgradient/testing';
import {
  appendAssistantMessage,
  appendUserMessage,
  createConversationHistory,
} from './builders.ts';

setupHappyDom();

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const originalResizeObserver = globalThis.ResizeObserver;
globalThis.ResizeObserver = TestResizeObserver;

class TestIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
const originalIntersectionObserver = globalThis.IntersectionObserver;
globalThis.IntersectionObserver =
  TestIntersectionObserver as unknown as typeof IntersectionObserver;
afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.IntersectionObserver = originalIntersectionObserver;
});

const { render, fireEvent, cleanup, waitFor } = await import('@testing-library/svelte');
const { default: Chat } = await import('./chat.svelte');
const { default: WithLabels } = await import('./chat-labels-context.fixture.svelte');
const { default: MessageAttachments } = await import('./message/message-attachments.svelte');
const { default: MessageContent } = await import('./message/message-content.svelte');
const { default: MarkdownTableScroller } = await import('./message/markdown-table-scroller.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const SPANISH_SOURCES = {
  sources: 'Fuentes',
  sourcesCount: (count: number) => `${count} fuentes`,
  internalDocument: 'Documento interno, sin enlace público',
  unsafeLink: 'Enlace oculto: la dirección no es segura',
};

async function openSources(): Promise<HTMLElement> {
  let conversation = appendUserMessage(createConversationHistory({ id: 'deferred' }), 'Q');
  conversation = appendAssistantMessage(conversation, 'Answer.');
  const assistantId = conversation.ids.at(-1)!;
  const sources: readonly CitationSource[] = [
    { label: 'Board minutes' },
    { label: 'Unsafe source', url: 'javascript:alert(1)' },
  ];
  const { container } = render(Chat, {
    id: 'deferred',
    conversation,
    sourcesByMessageId: new Map([[assistantId, sources]]),
    labels: SPANISH_SOURCES,
  });
  await tick();
  const marker = container.querySelector<HTMLButtonElement>(
    '[data-chat-sources-trigger] .cinder-citation__marker',
  )!;
  await fireEvent.click(marker);
  await tick();
  return container;
}

describe('COR-2439 deferred criteria', () => {
  test('AC2: the Sources panel, its count and its notes read Chat’s labels', async () => {
    const container = await openSources();

    expect(
      container.querySelector('[data-chat-sources-trigger] .cinder-citation__marker')?.textContent,
    ).toContain('2 fuentes');
    expect(container.querySelector('.cinder-citation__panel')?.getAttribute('aria-label')).toBe(
      'Fuentes',
    );
  });

  test('AC3: Chat passes its words through to Citation’s own labels', async () => {
    const container = await openSources();

    expect(
      Array.from(container.querySelectorAll('.cinder-citation__note'), (note) =>
        note.textContent?.trim(),
      ),
    ).toEqual([SPANISH_SOURCES.internalDocument, SPANISH_SOURCES.unsafeLink]);
  });

  async function brokenImage(labels: Record<string, unknown>) {
    const { container } = render(WithLabels, {
      labels,
      component: MessageAttachments,
      childProps: {
        images: [
          { type: 'image', source: { kind: 'remote-url', url: 'missing.png' }, alt: 'receipt.png' },
        ],
      },
    });
    const image = container.querySelector('.message-attachment-image')!;
    await fireEvent.error(image);
    await waitFor(() =>
      expect(container.querySelector('.message-attachment[data-unavailable]')).not.toBeNull(),
    );
    return container;
  }

  test('AC12: the broken-image placeholder draws the ImageOff icon', async () => {
    const container = await brokenImage({});
    const icon = container.querySelector('.message-attachment-unavailable-icon');
    expect(icon?.tagName.toLowerCase()).toBe('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    const source = readFileSync(
      join(import.meta.dir, 'message/message-attachments.svelte'),
      'utf8',
    );
    expect(source).toMatch(/import \{[^}]*\bImageOff\b[^}]*\} from '@lostgradient\/cinder'/);
    expect(source).toContain('<ImageOff class="message-attachment-unavailable-icon');
  });

  test('AC13: the placeholder’s didn’t-load and Retry words read Chat’s labels', async () => {
    const container = await brokenImage({
      imageDidNotLoad: 'no se cargó',
      retryImage: (name: string) => `Reintentar ${name}`,
    });
    expect(container.querySelector('.message-attachment-unavailable-text')?.textContent).toMatch(
      /receipt\.png\s+no se cargó/,
    );
    expect(container.querySelector('.message-attachment-retry')?.getAttribute('aria-label')).toBe(
      'Reintentar receipt.png',
    );
  });

  test('AC17: an open fence’s Writing status reads Chat’s labels', () => {
    const { container } = render(WithLabels, {
      labels: { codeWriting: 'Escribiendo…' },
      component: MessageContent,
      childProps: { content: 'Here is the query:\n\n```sql\nSELECT id', streaming: true },
    });
    expect(container.querySelector('.cinder-code-block__status')?.textContent).toBe('Escribiendo…');
  });

  test('AC18: a wide table’s region name and column cue read Chat’s labels', async () => {
    const { container } = render(WithLabels, {
      labels: {
        scrollableTable: 'Tabla desplazable',
        hiddenColumns: (count: number) => `+${count} columnas`,
        scrollToSeeAllColumns: 'Desplace para ver todas las columnas',
      },
      component: MarkdownTableScroller,
      childProps: {
        html: '<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody><tr><td>1</td><td>2</td><td>3</td></tr></tbody></table>',
      },
    });
    const scroller = container.querySelector<HTMLElement>('.message-markdown-table-scroller')!;
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 100, 20);
    scroller.querySelectorAll('thead th').forEach((cell, index) => {
      cell.getBoundingClientRect = () => new DOMRect(index * 80, 0, 80, 20);
    });
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 240 });
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 100 });
    Object.defineProperty(scroller, 'scrollLeft', { configurable: true, value: 0 });
    await fireEvent.scroll(scroller);

    await waitFor(() => expect(scroller.getAttribute('aria-label')).toBe('Tabla desplazable'));
    const cue = container.querySelector('.message-markdown-table-cue');
    expect(cue?.querySelector('[aria-hidden="true"]')?.textContent).toBe('+2 columnas');
    expect(cue?.querySelector('.cinder-sr-only')?.textContent).toBe(
      'Desplace para ver todas las columnas',
    );
  });
});
