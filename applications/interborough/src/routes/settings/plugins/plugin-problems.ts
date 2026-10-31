/**
 * The words for a problem a plugin or a folder has, and the one button that goes with it when
 * there is one. The host reports a problem by `code` plus the fields that code carries
 * (`PluginProblem` in `lib/host-plugins.ts` keeps them loose), so a code this client has no words
 * for still lists, with the code, instead of vanishing.
 */
import { PLUGINS_COPY } from '../../../app/copy.ts';
import type { PluginProblem } from '../../../lib/host-plugins.ts';

/** What a problem says, and the action beside it. */
export type ProblemView = {
  readonly title: string;
  readonly body: string;
  /** A secret the person can save from here, which clears the problem with no restart. */
  readonly secretKey?: string;
};

function text(problem: PluginProblem, field: string): string {
  const value: unknown = Reflect.get(problem, field);
  return typeof value === 'string' ? value : '';
}

function whole(problem: PluginProblem, field: string): number {
  const value: unknown = Reflect.get(problem, field);
  return typeof value === 'number' ? value : 0;
}

function partyText(problem: PluginProblem, field: string): string {
  const value: unknown = Reflect.get(problem, field);
  if (typeof value !== 'object' || value === null) return '';
  const location: unknown = Reflect.get(value, 'location');
  return typeof location === 'string' ? location : '';
}

/** The words for one problem. */
export function problemView(problem: PluginProblem): ProblemView {
  const words = PLUGINS_COPY.problems;
  switch (problem.code) {
    case 'secret-missing': {
      const key = text(problem, 'key');
      return {
        title: words.secretMissing.title,
        body: words.secretMissing.body(key),
        secretKey: key,
      };
    }
    case 'configuration-invalid':
      return {
        title: words.configurationInvalid.title,
        body: words.configurationInvalid.body(text(problem, 'field'), text(problem, 'message')),
      };
    case 'reference-unresolved':
      return {
        title: words.referenceUnresolved.title,
        body: words.referenceUnresolved.body(text(problem, 'file'), text(problem, 'id')),
      };
    case 'pinned-version-unavailable':
      return {
        title: words.pinnedVersionUnavailable.title,
        body: words.pinnedVersionUnavailable.body(
          text(problem, 'id'),
          text(problem, 'version'),
          whole(problem, 'waitingRuns'),
        ),
      };
    case 'name-clash':
      return {
        title: words.nameClash.title,
        body: words.nameClash.body(
          text(problem, 'name'),
          partyText(problem, 'first'),
          partyText(problem, 'second'),
        ),
      };
    case 'development-source':
      return {
        title: words.developmentSource.title,
        body: words.developmentSource.body(text(problem, 'path')),
      };
    case 'setup-failed':
    case 'secret-refused':
    case 'load-failed':
    case 'after-start-failed':
      return { title: words.failed.title, body: text(problem, 'message') };
    default:
      return { title: words.title, body: words.unknown(problem.code) };
  }
}
