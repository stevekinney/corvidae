/**
 * The one place the terminal example reads the host's environment.
 *
 * A server-owned profile passes its process a complete, explicit environment and inherits nothing,
 * so the host values a shell genuinely needs are named here and nowhere else: the login shell the
 * user chose, the search path, and the locale. Everything else the process sees is written in
 * `profiles.ts`.
 */
export type HostEnvironment = {
  /** `$SHELL`, if the host set it. */
  readonly shell: string | undefined;
  /** `$PATH`, if the host set it. */
  readonly path: string | undefined;
  /** `$LANG`, if the host set it. */
  readonly language: string | undefined;
};

export function readHostEnvironment(): HostEnvironment {
  return {
    shell: process.env['SHELL'],
    path: process.env['PATH'],
    language: process.env['LANG'],
  };
}
