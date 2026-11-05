/**
 * What each problem on `bureau.health.attention` says on the Health page: one glyph per kind, a
 * title, a second line that names the times, and the buttons that go and look. The list keeps the
 * Bureau's order, which is most recent first, so nothing here sorts. A row states no capacity or
 * threshold figure: only what was measured.
 */
import type { AttentionItem } from '../../lib/bureau-attention.ts';
import { hookPath } from '../../lib/identifier-paths.ts';
import { scheduleDetailPath } from '../../lib/router.svelte.ts';
import { providerDisplayName } from '../settings/models/format-model.ts';
import { HEALTH_ATTENTION_COPY as copy } from './health-copy.ts';
import { clockTime, dayLabel, joinWords } from './health-times.ts';

/** The glyph a row draws in its tile. */
export type AttentionGlyph = 'provider' | 'storage' | 'schedule' | 'hook' | 'plugin' | 'alert';

/** A button at the end of a row. */
export interface AttentionAction {
  readonly label: string;
  /** Where it goes. */
  readonly href: string;
}

/** One row of the Needs attention list. */
export interface AttentionRow {
  /** Stable across reads, so the list keeps a row's place when another changes. */
  readonly id: string;
  readonly glyph: AttentionGlyph;
  readonly title: string;
  readonly description: string;
  readonly actions: readonly AttentionAction[];
}

/** Where Advanced opens for a section, or for none. */
export function diagnosticsPath(section?: 'metrics' | 'alerts' | 'checks' | 'realms'): string {
  return section === undefined ? '/health?advanced=open' : `/health?advanced=${section}`;
}

const STATUS_WORDS: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  410: 'Gone',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/** A status as the receiver said it: "410 Gone", or the bare number for one with no common name. */
export function statusWords(status: number | null): string | null {
  if (status === null) return null;
  const word = Object.hasOwn(STATUS_WORDS, status) ? STATUS_WORDS[status] : undefined;
  return word === undefined ? String(status) : `${String(status)} ${word}`;
}

/** The words of a plugin's name: its identifier with the separators opened and the first letter raised. */
function pluginName(plugin: string): string {
  const spaced = plugin.replaceAll(/[-_]+/g, ' ').trim();
  return spaced === '' ? plugin : `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

/** The row for one problem. */
export function attentionRow(item: AttentionItem): AttentionRow {
  switch (item.kind) {
    case 'no-provider':
      return {
        id: 'no-provider',
        glyph: 'provider',
        title: copy.provider.title,
        description: copy.provider.line(
          item.provider === null ? null : providerDisplayName(item.provider),
          item.at === null ? null : clockTime(item.at),
        ),
        actions: [{ label: copy.provider.action, href: '/settings/models' }],
      };
    case 'alert':
      if (item.metric === 'storage.size') {
        return {
          id: `alert:${item.metric}`,
          glyph: 'storage',
          title: copy.storage.title(item.currentValue),
          description: copy.storage.line(clockTime(item.at)),
          actions: [
            { label: copy.storage.view, href: '/health/storage' },
            { label: copy.storage.retention, href: '/settings/data-and-retention' },
          ],
        };
      }
      return {
        id: `alert:${item.metric}`,
        glyph: 'alert',
        title:
          item.metric === 'workflow.failure_rate'
            ? copy.failureRate.title(item.currentValue)
            : item.metric === 'activity.p99_duration'
              ? copy.slowSteps.title(item.currentValue)
              : copy.otherAlert.title(item.metric),
        description: copy.otherAlert.line(clockTime(item.at)),
        actions: [{ label: copy.otherAlert.action, href: diagnosticsPath('alerts') }],
      };
    case 'missed-runs': {
      const due = item.occurrences.map((occurrence) => dayLabel(occurrence.occurrence));
      return {
        id: `missed-runs:${item.scheduleId}`,
        glyph: 'schedule',
        title: copy.missedRuns.title(
          item.scheduleName ?? copy.missedRuns.unnamed,
          item.count,
          dayLabel(item.since),
        ),
        description: copy.missedRuns.line(joinWords(due)),
        actions: [{ label: copy.missedRuns.action, href: scheduleDetailPath(item.scheduleId) }],
      };
    }
    case 'hook-failed': {
      const name = item.hookName ?? copy.hook.unnamed;
      const status = statusWords(item.status);
      return {
        id: `hook-failed:${item.hookId}`,
        glyph: 'hook',
        title: item.gaveUp
          ? copy.hook.gaveUpTitle(name, status)
          : copy.hook.failedTitle(name, status),
        description: item.gaveUp
          ? copy.hook.gaveUpLine(item.attempts, dayLabel(item.at))
          : item.status === null && item.error !== null
            ? copy.hook.errorLine(item.error, clockTime(item.at))
            : copy.hook.failedLine(item.host, status, clockTime(item.at)),
        actions: [{ label: copy.hook.action, href: hookPath(item.hookId) }],
      };
    }
    case 'plugin-not-loaded':
      return {
        id: `plugin-not-loaded:${item.plugin}`,
        glyph: 'plugin',
        title: copy.plugin.title(pluginName(item.plugin)),
        description: copy.plugin.line(item.at === null ? null : clockTime(item.at)),
        actions: [{ label: copy.plugin.action, href: '/settings/plugins' }],
      };
  }
}

/** The rows for every problem, in the order the Bureau lists them. */
export function attentionRows(items: readonly AttentionItem[]): readonly AttentionRow[] {
  return items.map(attentionRow);
}
