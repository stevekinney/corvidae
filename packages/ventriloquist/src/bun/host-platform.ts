/**
 * The host matrix the terminal contract supports: macOS and Linux on x64 and arm64, named the way
 * `process.platform` and `process.arch` name them. Windows is unsupported because
 * `Bun.spawn({ terminal })` is POSIX-only.
 */
export const SUPPORTED_HOST_PLATFORMS = ['darwin', 'linux'] as const;
export const SUPPORTED_HOST_ARCHITECTURES = ['x64', 'arm64'] as const;

export type HostPlatform = {
  platform: string;
  architecture: string;
};

/** Whether a session can start on `host`. A `false` here is the `unsupported-runtime` failure. */
export function isSupportedHost(host: HostPlatform): boolean {
  return (
    (SUPPORTED_HOST_PLATFORMS as readonly string[]).includes(host.platform) &&
    (SUPPORTED_HOST_ARCHITECTURES as readonly string[]).includes(host.architecture)
  );
}
