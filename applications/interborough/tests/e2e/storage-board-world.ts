/**
 * The keys the Storage design draws (`PageStorage`, rows 80g, 80k and 80q), answered in place of
 * the host's own for the frames that show them. The sample world's store is what the engine and the
 * Bureau really wrote (thousands of keys, in key order, under the prefixes they use), so it cannot
 * list ten chosen keys in a chosen order with chosen sizes and times. A frame that reads the board's
 * rows answers the page's reads of `/v1/storage` from this list instead, and the rest of the page
 * (the scopes, the groups, the pane, the writes) is the real one.
 *
 * A key's group is told by its prefix (`storage-groups.ts`), so a key the board names with a prefix
 * the application does not write ("memory:", "goal:", "task:", "run:") is given the prefix the
 * application does write for the same thing, which keeps the group's own word in the table.
 */
import type { Page } from '@playwright/test';

/** One key the design draws: its name, the size and write time its row says, and what it holds. */
export interface BoardKey {
  readonly key: string;
  /** The size the row says, in bytes: the stored text is padded with spaces to this length. */
  readonly bytes: number;
  /** When it was written, in epoch milliseconds. */
  readonly updatedAt: number;
  /** What it holds, as JSON. */
  readonly value: unknown;
}

/** A clock time on a day of Nov 2026, in Central time (UTC−6). */
const central = (day: number, hour: number, minute: number): number =>
  Date.UTC(2026, 10, day, hour + 6, minute);

const REFUND_CHAT = '415b1fd8-77c2-4f0e-9a6d-2b1c0e5f3a11';
const FIRST_RUN = 'run-1-12b71b8b-3c2d-4e5f-8a9b-0c1d2e3f4a5b';

/** The ten rows of the table, in the order the board lists them (row 80g). */
export const BOARD_KEYS: readonly BoardKey[] = [
  {
    key: 'agent-session:summary-index',
    bytes: 1229,
    updatedAt: central(2, 10, 44),
    value: {
      formatVersion: 3,
      chat: 'Refund order 4471',
      agent: 'Tool runner',
      messages: 14,
      summarized: '2026-11-02T16:44:00Z',
    },
  },
  {
    key: `agent-session:${REFUND_CHAT}:messages`,
    bytes: 310,
    updatedAt: central(2, 10, 42),
    value: { formatVersion: 3, messages: 14 },
  },
  {
    key: 'app:preferences',
    bytes: 64,
    updatedAt: central(2, 9, 40),
    value: { summaries: 'long' },
  },
  {
    key: 'app:goals',
    bytes: 410,
    updatedAt: central(2, 9, 0),
    value: { goals: ['Say hello'] },
  },
  {
    key: 'audit:2026-11-02T16:33:08Z',
    bytes: 220,
    updatedAt: central(2, 10, 33),
    value: { type: 'review.tool-approval.approved' },
  },
  {
    key: 'bureau-goal:seeded-goal',
    bytes: 880,
    updatedAt: central(2, 9, 0),
    value: { title: 'Say hello' },
  },
  {
    key: `bureau-task:${FIRST_RUN}`,
    bytes: 540,
    updatedAt: central(2, 9, 0),
    value: { status: 'done' },
  },
  {
    key: `bureau-catalog-run:${FIRST_RUN}`,
    bytes: 2458,
    updatedAt: central(2, 9, 0),
    value: { status: 'completed' },
  },
  {
    key: `steering-log:${REFUND_CHAT}:0001`,
    bytes: 180,
    updatedAt: central(2, 10, 42),
    value: { kind: 'message' },
  },
  {
    key: 'schedule:daily-summary',
    bytes: 360,
    updatedAt: central(2, 10, 40),
    value: { name: 'Daily summary' },
  },
];

/** The three audit keys the range frame lists (row 80q). */
export const BOARD_RANGE_KEYS: readonly BoardKey[] = [
  {
    key: 'audit:2026-11-01T22:12:31Z',
    bytes: 210,
    updatedAt: central(1, 16, 12),
    value: { type: 'session.deleted' },
  },
  {
    key: 'audit:2026-11-02T15:00:02Z',
    bytes: 224,
    updatedAt: central(2, 9, 0),
    value: { type: 'host.started' },
  },
  {
    key: 'audit:2026-11-02T16:33:08Z',
    bytes: 220,
    updatedAt: central(2, 10, 33),
    value: { type: 'review.tool-approval.approved' },
  },
];

/** The text a key holds: its JSON, padded with spaces (which JSON ignores) to the size its row says. */
export function storedTextOf(entry: BoardKey): string {
  const text = JSON.stringify(entry.value);
  if (text.length > entry.bytes) throw new Error(`${entry.key} holds more than ${entry.bytes} B.`);
  return text.padEnd(entry.bytes, ' ');
}

/** The keys a scan asks for, from the bounds in its query. */
function scanned(keys: readonly BoardKey[], query: URLSearchParams): readonly BoardKey[] {
  const prefix = query.get('prefix') ?? '';
  const at = (name: string): string | null => query.get(name);
  const limit = Number(query.get('limit') ?? keys.length);
  const inBounds = keys.filter(
    (entry) =>
      entry.key.startsWith(prefix) &&
      (at('gte') === null || entry.key >= (at('gte') ?? '')) &&
      (at('gt') === null || entry.key > (at('gt') ?? '')) &&
      (at('lte') === null || entry.key <= (at('lte') ?? '')) &&
      (at('lt') === null || entry.key < (at('lt') ?? '')),
  );
  // The groups are found by reading one key at a time in key order; the table lists the board's order.
  const ordered =
    limit === 1 ? inBounds.toSorted((a, b) => (a.key < b.key ? -1 : 1)) : [...inBounds];
  return (query.get('reverse') === 'true' ? ordered.toReversed() : ordered).slice(0, limit);
}

/** Answers the page's reads of the key store from `keys`, and leaves every write to the host. */
export async function answerStorageFrom(page: Page, keys: readonly BoardKey[]): Promise<void> {
  await page.route(
    (url) => url.pathname === '/v1/storage' || url.pathname.startsWith('/v1/storage/'),
    async (route) => {
      const request = route.request();
      if (request.method() !== 'GET') {
        await route.fallback();
        return;
      }
      const url = new URL(request.url());
      if (url.pathname === '/v1/storage') {
        const body = scanned(keys, url.searchParams)
          .map((entry) =>
            JSON.stringify({
              key: entry.key,
              value: Buffer.from(storedTextOf(entry)).toString('base64'),
              updatedAt: entry.updatedAt,
            }),
          )
          .join('\n');
        await route.fulfill({ contentType: 'application/x-ndjson', body });
        return;
      }
      const key = decodeURIComponent(url.pathname.slice('/v1/storage/'.length));
      const entry = keys.find((held) => held.key === key);
      if (entry === undefined) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        contentType: 'application/octet-stream',
        body: storedTextOf(entry),
      });
    },
  );
}
