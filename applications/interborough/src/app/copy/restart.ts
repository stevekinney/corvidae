import { nameList } from './shared.ts';

/** "1 change" or "3 changes". */
function changeCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'change' : 'changes'}`;
}

/**
 * The words of the restart the shell shows (`app/restart`, board SettingsShell "Restart" frames):
 * the question before it, the dialog while the host stops and starts, how it ends when the host
 * never answers, and the banner that says what applied once it is back. Running work always picks up
 * where it stopped and reviews wait, so nothing here says that nothing is running.
 */
export const RESTART_COPY = {
  confirm: {
    title: 'Restart Interborough now?',
    description: (changes: number): string =>
      `Interborough stops and starts again to apply ${changeCount(Math.max(changes, 1))}. Running work picks up where it stopped; reviews stay waiting.`,
    confirm: 'Restart now',
    cancel: 'Cancel',
  },
  /** The steps of the restarting dialog, in order. */
  steps: ['Saved your choice', 'Stopped the server', 'Starting Interborough', 'Checking plugins'],
  restarting: {
    description: 'This takes a few seconds. Your changes are saved.',
    unloading: (plugin: string): string =>
      `Unloading ${plugin}. Running work picks up where it stopped; reviews stay waiting.`,
  },
  failed: {
    check:
      'That Interborough is still running on this machine, and that its address is reachable from this browser.',
    /** What was saved before the host stopped, which is what applies once it starts. */
    description: (changes: number, disabling: string | undefined): string => {
      const answered = 'It didn’t answer after 8 tries.';
      if (disabling !== undefined) {
        return `${answered} Your choice to disable ${disabling} was saved before it stopped, so it applies once Interborough starts.`;
      }
      return changes > 1
        ? `${answered} Your changes were saved before it stopped, so they apply once it starts.`
        : `${answered} Your change was saved before it stopped, so they apply once it starts.`;
    },
  },
  unconfirmed: {
    title: 'Interborough has not restarted',
    description:
      'The host is still answering as it did before, so the change has not applied. It may not be supervised, so restart it where it runs.',
    dismiss: 'Dismiss',
  },
  /** Why a restart did not begin. */
  refusal: {
    locked: 'This host keeps its configuration in its deployment, so it cannot be restarted here.',
    refused: 'This host cannot restart itself. Restart it where it runs.',
    unreachable: 'Interborough did not answer, so it was not asked to restart. Try again.',
  },
  back: {
    title: 'Back up',
    dismiss: 'Dismiss',
    /** The lead of a restart that unloaded one plugin: "Back up. Web search is disabled." */
    disabled: (plugin: string): string => `Back up. ${plugin} is disabled.`,
    /** What applied and what became of the work in flight. */
    applied: (changes: readonly string[]): string =>
      `${changeCount(Math.max(changes.length, 1))} applied${changes.length === 0 ? '' : `: ${changes.join(', ')}`}. Running work picked up where it stopped; reviews stayed waiting.`,
    /** The plugins by standing, such as "1 plugin running (Files); Anthropic and OpenAI need setup." */
    standing: (
      running: readonly string[],
      needSetup: readonly string[],
      disabled: readonly string[],
      notLoaded: readonly string[],
    ): string => {
      const parts: string[] = [];
      if (running.length > 0) {
        parts.push(
          `${String(running.length)} ${running.length === 1 ? 'plugin' : 'plugins'} running (${nameList(running)})`,
        );
      }
      if (needSetup.length > 0) {
        parts.push(`${nameList(needSetup)} ${needSetup.length === 1 ? 'needs' : 'need'} setup`);
      }
      if (disabled.length > 0) {
        parts.push(`${nameList(disabled)} ${disabled.length === 1 ? 'is' : 'are'} disabled`);
      }
      if (notLoaded.length > 0) {
        parts.push(`${nameList(notLoaded)} did not load`);
      }
      return parts.length === 0 ? '' : `${parts.join('; ')}.`;
    },
    /** What stopped working because a plugin was turned off, or that nothing did. */
    unavailable: (plugin: string, unavailable: string | undefined): string =>
      unavailable === undefined
        ? `Nothing used ${plugin}, so nothing became unavailable.`
        : `${unavailable} used ${plugin} and now show as unavailable.`,
    enableAgain: 'Enable it again at any time.',
  },
} as const;
