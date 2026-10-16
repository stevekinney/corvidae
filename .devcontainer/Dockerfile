# The local development container described in AGENTS.md under "Dev Container".
#
# Node.js 24 is the active LTS line and the major the workspace's `@types/node` catalog
# entry targets. Weft's native SQLite suite (`packages/weft/src/storage/node-sqlite.test.ts`)
# runs its integration cases under a real Node, not Bun's `node` shim, and fails without one.
# Node's bundled `npm` comes along with it.
FROM node:24.21.0-trixie-slim AS node

# The tag is the workspace's `packageManager` Bun version; `scripts/dev-container.test.ts`
# fails when the two drift apart.
FROM oven/bun:1.4.2

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# PostgreSQL 17 is Debian 13's server major and the release the host-side fix for COR-1379
# installed. Only `initdb` and `pg_ctl` are needed: the live PostgreSQL and Neon suites in
# `packages/weft` start their own disposable `--no-locale` UTF8 cluster, so the packaged
# `main` cluster is never created. Validation itself needs `git` (Weft's coverage check
# lists files with `git ls-files`, and several suites shell out to it). `python3`, `make`,
# and `g++` are node-gyp's toolchain: on linux/arm64, `better-sqlite3` and
# `msgpackr-extract` find no prebuilt binary for the Node version Bun 1.4.2 reports, and
# their install scripts fall back to compiling, which fails `bun install` without it.
# `sudo` lets the `onCreateCommand` hand the root-owned `node_modules` volume to `bun`.
RUN mkdir -p /etc/postgresql-common \
  && echo 'create_main_cluster = false' > /etc/postgresql-common/createcluster.conf \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates g++ git make postgresql-17 python3 sudo \
  && rm -rf /var/lib/apt/lists/* \
  && echo 'bun ALL=(root) NOPASSWD:ALL' > /etc/sudoers.d/bun \
  && chmod 0440 /etc/sudoers.d/bun

# `bun run test` includes the browser-fixture suite, which launches Chromium's headless shell
# through Playwright, and Weft's opt-in `WEFT_BROWSER_SMOKE=1` suites need it too, plus full
# Chromium for WebExtensionStorage, which loads an unpacked extension. The version is the
# `playwright-core` that `bun.lock` resolves, so the browser revisions are the ones the
# installed package looks for; `scripts/dev-container.test.ts` fails when the two drift
# apart. The browsers' system libraries need root; the browsers themselves are installed
# below, as `bun`, into Playwright's default cache, because Turborepo's strict environment
# mode would not pass a `PLAYWRIGHT_BROWSERS_PATH` through to the tasks.
RUN npx --yes playwright@1.63.0 install-deps chromium \
  && rm -rf /root/.npm /var/lib/apt/lists/*

# Debian keeps the server binaries off PATH; the suites find them with `Bun.which`.
ENV PATH=/usr/lib/postgresql/17/bin:$PATH
# Keep Turborepo's local cache out of the bind-mounted checkout, so a host run never
# replays a task result this Linux container produced, or the reverse.
ENV TURBO_CACHE_DIR=/home/bun/.cache/turbo
# Turborepo runs ten tasks at once by default, and Docker Desktop's default virtual machine has
# 8 GB. Measured in this image, Weft's `tsc --noEmit` peaks near 3.5 GB and its type-contract
# check near 4.4 GB, so even two tasks side by side can be killed for memory (exit 137). One
# at a time fits; an explicit `--concurrency` flag, such as the root `test` script's, still
# wins over this.
ENV TURBO_CONCURRENCY=1

# `initdb` refuses to run as root, so the container works as the image's `bun` user.
# A bind-mounted checkout is owned by the host's uid, which Git would otherwise reject
# as dubious ownership.
USER bun
RUN git config --global --add safe.directory '*' \
  && mkdir -p /home/bun/.cache/turbo \
  && npx --yes playwright@1.63.0 install chromium \
  && rm -rf /home/bun/.npm
