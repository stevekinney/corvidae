import type {
  InputRefusal,
  InspectionEvent,
  TerminalGeometry,
  TerminalState,
} from '@lostgradient/terminal';

import type { ScriptedSession } from './scripted-session.ts';

/** What the lab renders the terminal with. Changing it re-renders the same mounted terminal. */
export type LabProps = {
  title: string;
  state: TerminalState;
  error: string | undefined;
  mouseReporting: boolean;
  announceOutput: boolean;
  ariaLabel: string;
  /** Pass `onLinkActivate`, which turns links on. */
  links: boolean;
  /** Pass `onRecoveryRequest`, which gives a recovery control to the states that offer one. */
  recovery: boolean;
  /** Pass every recovery action handler, so each state shows the buttons it offers. */
  actions: boolean;
  /** Cleanup of the previous attachment is unfinished, which blocks replacing the session. */
  cleanupPending: boolean;
  ownerGeometry: TerminalGeometry | undefined;
  maximumPasteBytes: number | undefined;
};

export type LabEvents = {
  geometry: TerminalGeometry[];
  refusals: InputRefusal[];
  inspection: InspectionEvent[];
  titles: string[];
  links: string[];
  recoveryRequests: number;
  /** The recovery actions the reader activated, by button label, in order. */
  actions: string[];
};

/**
 * The handle the host page exposes to the browser specs as `window.terminalLab`. It is the only
 * private surface: it drives the scripted session and the props, and records what the component
 * reported. The component's own engine is never reachable through it.
 */
export type TerminalLab = {
  session: ScriptedSession;
  props: LabProps;
  events: LabEvents;
  /** Times the terminal component was created and destroyed by this page. */
  lifecycle: { mounts: number; unmounts: number };
  setProps(next: Partial<LabProps>): void;
  /** Replace the controller with a new session, as a host does when it starts another. */
  newSession(): ScriptedSession;
  mount(): void;
  unmount(): void;
  /** Destroy the component and create a fresh one against the same session. */
  remount(): void;
  /** Resolves once the engine (if the state mounts one) is ready and its output parsed. */
  ready(): Promise<void>;
};

declare global {
  interface Window {
    terminalLab?: TerminalLab;
  }
}
