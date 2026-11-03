import { formatDate, formatTimeOfDay, formatTimeZoneLabel } from '../../utilities/format-date.ts';

/**
 * The connection presets of {@link Banner}, in the order the design lists them. Every preset is
 * non-dismissible and labels its retry "Retry now".
 */
export const BANNER_PRESETS = [
  'offline',
  'unreachable',
  'stopped',
  'refresh-failed',
  'restarting',
  'reconnecting',
  'restart-failed',
  'back-online',
] as const;

/**
 * Ready-made banner configurations. Each one fixes its tone, its accessible name, its copy and its
 * actions, so no page words its own:
 *
 * - `offline` (warning): the browser is offline; clears itself when the connection returns.
 * - `unreachable` (warning): the server does not answer and retries back off, up to 8 tries.
 * - `stopped` (warning): the retries ran out; Retry now is the primary action.
 * - `refresh-failed` (warning): the server answered but this page's read failed; changes stay on.
 * - `restarting` (info): the person confirmed Restart now; no action.
 * - `reconnecting` (info): the second stage of restarting, counting the reconnect attempts.
 * - `restart-failed` (warning): the restart did not come back; Restart again and Open Health.
 * - `back-online` (success): the connection returned. The design draws this as a toast; the banner
 *   form carries the same words for a surface that cannot show a toast.
 */
export type BannerPreset = (typeof BANNER_PRESETS)[number];

/** How many attempts the connection and restart presets count to. */
export const BANNER_MAX_ATTEMPTS = 8;

/** The words of the `back-online` preset, shared with the toast that announces the same event. */
export const BANNER_BACK_ONLINE_COPY = 'Back online. Updated just now.';

/** The facts a preset turns into its copy. Every field is optional; a preset leaves out what it has no fact for. */
export type BannerPresetFacts = {
  /**
   * When the data still on screen was loaded. The copy names it as an absolute time with its zone
   * ("as of 10:44 AM CST"), never as an age, and adds the day when it is not today.
   */
  asOf?: Date | string | number | undefined;
  /** What the page is showing, completing "Showing … as of …". Defaults to "what loaded". */
  subject?: string | undefined;
  /** Seconds until the next automatic retry. Adds "Retrying in 4 s". */
  retryInSeconds?: number | undefined;
  /** The attempt that is under way, counted from 1. Adds "(attempt 3 of 8)" to a countdown. */
  attempt?: number | undefined;
  /** How many attempts there are. Defaults to {@link BANNER_MAX_ATTEMPTS}. */
  maxAttempts?: number | undefined;
  /**
   * The sentence that says what is off while the banner shows, replacing the preset's own
   * ("Changes are off until it’s back."). Pass `false` to leave the sentence out. A page that
   * names its controls writes them here.
   */
  consequence?: string | false | undefined;
  /** Replaces the preset's lead, the bold words that start the banner. Include its punctuation. */
  title?: string | undefined;
  /** IANA time zone of the "as of" time. Defaults to the viewer's zone. */
  timeZone?: string | undefined;
  /** Locale of the "as of" time. Defaults to `en-US`. */
  locale?: Intl.LocalesArgument | undefined;
  /** The reference time for "today". Defaults to now. */
  now?: Date | number | undefined;
};

/** The words a preset writes: a bold lead and the sentence after it. */
export type BannerPresetCopy = {
  /** The lead, written in bold. Absent when the preset opens with plain words. */
  title?: string;
  /** The rest of the banner's words. */
  text: string;
};

const SAVED =
  'Your changes are saved. Running work picks up where it stopped; reviews stay waiting.';

function sameCalendarDay(first: Date, second: Date, timeZone: string | undefined): boolean {
  const key = (date: Date) =>
    formatDate(date, 'en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' });
  return key(first) === key(second);
}

/**
 * The absolute reading of a moment for "as of": "10:44 AM CST" within today, and the day first
 * ("Sun Nov 1, 4:12 PM CST") on any other day, so an old time is never mistaken for today's.
 */
export function formatBannerAsOf(
  asOf: Date | string | number,
  options: Pick<BannerPresetFacts, 'timeZone' | 'locale' | 'now'> = {},
): string {
  const date = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(date.getTime())) return 'an unknown time';
  const { timeZone, locale } = options;
  const now = options.now === undefined ? new Date() : new Date(options.now);
  const time = formatTimeOfDay(date, { timeZone, locale });
  const zone = formatTimeZoneLabel(date, { timeZone, locale });
  if (sameCalendarDay(date, now, timeZone)) return `${time} ${zone}`;
  const day = formatDate(date, locale ?? 'en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).replace(',', '');
  return `${day}, ${time} ${zone}`;
}

function showing(facts: BannerPresetFacts): string | undefined {
  if (facts.asOf === undefined) return undefined;
  return `Showing ${facts.subject ?? 'what loaded'} as of ${formatBannerAsOf(facts.asOf, facts)}.`;
}

function retrying(facts: BannerPresetFacts): string | undefined {
  if (facts.retryInSeconds === undefined) return undefined;
  const attempt =
    facts.attempt === undefined
      ? ''
      : ` (attempt ${facts.attempt} of ${facts.maxAttempts ?? BANNER_MAX_ATTEMPTS})`;
  return `Retrying in ${Math.max(0, Math.ceil(facts.retryInSeconds))} s${attempt}.`;
}

function consequence(facts: BannerPresetFacts, fallback: string): string | undefined {
  if (facts.consequence === false) return undefined;
  return facts.consequence ?? fallback;
}

function sentences(...parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(' ');
}

/**
 * The words of a preset for the facts the page has: one wording everywhere, so no page words its
 * own. The same function writes the banner, so a page that needs the words elsewhere (a log line, a
 * test) reads them from here.
 *
 * @example
 * bannerPresetCopy('unreachable', { asOf, retryInSeconds: 4, attempt: 3 });
 * // { title: 'Can’t reach the Interborough server.',
 * //   text: 'Showing what loaded as of 10:44 AM CST. Changes are off until it’s back. Retrying in 4 s (attempt 3 of 8).' }
 */
export function bannerPresetCopy(
  preset: BannerPreset,
  facts: BannerPresetFacts = {},
): BannerPresetCopy {
  switch (preset) {
    case 'offline':
      return {
        title: facts.title ?? 'You’re offline.',
        text: sentences(
          showing(facts),
          consequence(facts, 'Changes are off until you’re back.'),
          retrying(facts),
        ),
      };
    case 'unreachable':
      return {
        title: facts.title ?? 'Can’t reach the Interborough server.',
        text: sentences(
          showing(facts),
          consequence(facts, 'Changes are off until it’s back.'),
          retrying(facts),
        ),
      };
    case 'stopped':
      return {
        title: facts.title ?? 'Stopped retrying.',
        text: sentences(
          'Can’t reach the Interborough server.',
          showing(facts),
          consequence(facts, 'Changes are off until it’s back.'),
        ),
      };
    case 'refresh-failed':
      return {
        title: facts.title ?? 'Couldn’t refresh this page.',
        text: sentences(showing(facts), retrying(facts), consequence(facts, '')),
      };
    case 'restarting':
      return { title: facts.title ?? 'Restarting Interborough.', text: SAVED };
    case 'reconnecting':
      return {
        title:
          facts.title ??
          (facts.attempt === undefined
            ? 'Reconnecting…'
            : `Reconnecting… attempt ${facts.attempt} of ${facts.maxAttempts ?? BANNER_MAX_ATTEMPTS}.`),
        text: SAVED,
      };
    case 'restart-failed':
      return {
        title: facts.title ?? 'Interborough didn’t come back.',
        text: sentences(
          'Your changes were saved first.',
          showing(facts),
          consequence(facts, 'Changes are off until it’s back.'),
        ),
      };
    case 'back-online':
      return { text: BANNER_BACK_ONLINE_COPY };
  }
}
