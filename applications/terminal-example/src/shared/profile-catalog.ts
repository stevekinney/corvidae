/**
 * What the page may know about a profile: an identifier and words for a person. The executable,
 * arguments, working directory and environment of each profile live in `src/server/profiles.ts` and
 * never cross to the browser. The identifiers `shell`, `readonly-output` and `diagnostic` are the
 * ones `documentation/terminal/contract.md` froze; `fullscreen` is the fourth behavior the example
 * demonstrates, and `links` and `escaped` exist for the review controls (links to accept and to refuse, and a job that leaves the session).
 */
export const PROFILE_IDENTIFIERS = [
  'shell',
  'fullscreen',
  'diagnostic',
  'readonly-output',
  'links',
  'escaped',
] as const;

export type ProfileIdentifier = (typeof PROFILE_IDENTIFIERS)[number];

export type ProfileDescription = {
  readonly identifier: ProfileIdentifier;
  readonly label: string;
  readonly title: string;
  readonly summary: string;
  /** `pty` is one terminal stream; `pipe` keeps standard output and standard error apart. */
  readonly transport: 'pty' | 'pipe';
  /** Whether the server will ever grant this profile input, whatever the page asks for. */
  readonly interactive: boolean;
};

export const PROFILE_DESCRIPTIONS: Readonly<Record<ProfileIdentifier, ProfileDescription>> = {
  shell: {
    identifier: 'shell',
    label: 'Login shell',
    title: 'Login shell',
    summary: 'Your login shell ($SHELL -l) on a pseudo-terminal.',
    transport: 'pty',
    interactive: true,
  },
  fullscreen: {
    identifier: 'fullscreen',
    label: 'Full-screen program',
    title: 'Full-screen program',
    summary: 'A small program that takes over the alternate screen. Press q to leave it.',
    transport: 'pty',
    interactive: true,
  },
  diagnostic: {
    identifier: 'diagnostic',
    label: 'Pipe demo',
    title: 'Pipe demo',
    summary: 'Piped standard output and standard error, kept in separate views. It reads no input.',
    transport: 'pipe',
    interactive: false,
  },
  'readonly-output': {
    identifier: 'readonly-output',
    label: 'Replay',
    title: 'Replay',
    summary: 'A read-only replay of a fixed set of bytes. The server never grants it input.',
    transport: 'pipe',
    interactive: false,
  },
  escaped: {
    identifier: 'escaped',
    label: 'Escaped job',
    title: 'Escaped job',
    summary:
      'Starts a process that leaves the terminal session on purpose. Ending the session then reports Cleanup incomplete, the real path.',
    transport: 'pty',
    interactive: true,
  },
  links: {
    identifier: 'links',
    label: 'Links',
    title: 'Links',
    summary:
      'A read-only fixture with visible HTTPS text, a hidden OSC 8 destination, a path, a command scheme and a download-looking address.',
    transport: 'pipe',
    interactive: false,
  },
};

export function isProfileIdentifier(value: unknown): value is ProfileIdentifier {
  return typeof value === 'string' && (PROFILE_IDENTIFIERS as readonly string[]).includes(value);
}

/** The body of `POST /session`: which profile, and whether the page wants to be read-only. */
export type SessionRequest = {
  readonly profile: ProfileIdentifier;
  readonly readOnly: boolean;
};

/** The answer to `POST /session`: the identity and the one-time ticket for the upgrade. */
export type SessionGrant = {
  readonly sessionId: string;
  readonly ticket: string;
};

/** The answer to `GET /session/status`: whether the subject's slot can take a new session. */
export type SlotStatus = 'free' | 'busy' | 'quarantined';
