/**
 * What Home's first-run checklist knows: whether it shows, and how far the person is. It reads the
 * three answers the steps are made of (the providers that hold a key, the agents, the chats a
 * person started), the first two through the reads the rest of Home already asks, so no card is held
 * up. The chats are read on their own (`useChatHistory`), one chat, archived ones included: Recent
 * chats leaves archived chats out, but an archived chat is still a chat that happened. The page is `pending` until all three have answered, so the overview is
 * never drawn only to be replaced by the checklist. A chat list that cannot be read says nothing
 * about whether a person has had a chat, so it shows the overview, whose own cards say what they
 * cannot read.
 *
 * Two facts are kept in the browser, per workspace and actor, in the shell's own pattern
 * (`app/first-run.ts`): that the person chose Assistant for the second step, and that a chat has
 * happened, so deleting every chat does not bring the checklist back.
 */
import {
  firstRunProgress,
  homeChecklistShows,
  readAssistantChosen,
  readSaidHello,
  stepsLeft,
  writeAssistantChosen,
  writeSaidHello,
  type FirstRunProgress,
} from '../../app/first-run.ts';
import { browserWorkspaceStorage } from '../../app/workspace-lifetime.ts';
import { getPrincipalStore } from '../../lib/scopes.svelte.ts';
import { useAgentList, useChatHistory, useHostProviders } from './home-queries.svelte.ts';
import { checklistSteps, type ChecklistStep } from './home-rows.ts';
import { findAssistant } from './home-start-chat.ts';

/** What Home draws: nothing yet, the first-run checklist, or the overview. */
export type HomeMode = 'pending' | 'checklist' | 'overview';

/** The state of Home's first-run checklist, as {@link useHomeFirstRun} returns it. */
export interface HomeFirstRun {
  /** Which page Home draws. */
  mode(): HomeMode;
  /** The three steps with their words, once the checklist shows. */
  steps(): readonly ChecklistStep[];
  /** How many steps are still open, which the line that leads the page says. */
  left(): number;
  /** Whether a provider holds a key: the box that starts a chat comes back with it. */
  providerConnected(): boolean;
  /**
   * The Assistant the host lists, which the second step can take and the last step starts a chat
   * with. `undefined` on a host that lists none: Assistant is only there where a plugin or the host
   * contributes it, so nothing offers it where it does not exist.
   */
  assistant(): string | undefined;
  /** Takes Assistant as the agent to start from, which is what makes the second step done. */
  useAssistant(): void;
}

/** Reads the checklist's state. Call it while a component initializes. */
export function useHomeFirstRun(): HomeFirstRun {
  const storage = browserWorkspaceStorage(getPrincipalStore().principal?.workspace, 'localStorage');
  const providers = useHostProviders();
  const agents = useAgentList();
  // Whether a chat happened counts an archived one, which Recent chats leaves out.
  const chats = useChatHistory();

  let saidHello = $state(readSaidHello(storage));
  let assistantChosen = $state(readAssistantChosen(storage));

  // A chat the Bureau lists is a chat that happened, for good.
  $effect(() => {
    if (!saidHello && chats.data !== undefined && chats.data.contexts.length > 0) {
      writeSaidHello(storage);
      saidHello = true;
    }
  });

  const progress = $derived<FirstRunProgress>(
    firstRunProgress({
      providers: providers.data?.providers ?? [],
      agents: agents.data ?? [],
      chatCount: chats.data?.contexts.length ?? 0,
      assistantChosen,
    }),
  );
  const answered = $derived<HomeMode>(
    saidHello || chats.isError
      ? 'overview'
      : !chats.isSuccess ||
          !(providers.isSuccess || providers.isError) ||
          !(agents.isSuccess || agents.isError)
        ? 'pending'
        : homeChecklistShows(progress, saidHello)
          ? 'checklist'
          : 'overview',
  );
  // Once the page is drawn it stays drawn: a read that is asked again (a card mounting beside an
  // errored read asks it again, and an errored read that is asked again is pending until it
  // answers) must not take the page away, which would mount the cards, ask the read again, and
  // never settle.
  let drawn = $state<HomeMode>('pending');
  $effect.pre(() => {
    if (answered !== 'pending') drawn = answered;
  });
  const mode = $derived<HomeMode>(answered === 'pending' ? drawn : answered);
  const steps = $derived(
    checklistSteps(progress, {
      providers: providers.data?.providers ?? [],
      agents: agents.data,
      assistantChosen,
    }),
  );

  return {
    mode: () => mode,
    steps: () => steps,
    left: () => stepsLeft(progress),
    providerConnected: () => progress.provider,
    assistant: () => findAssistant(agents.data ?? []),
    useAssistant: () => {
      writeAssistantChosen(storage);
      assistantChosen = true;
    },
  };
}
