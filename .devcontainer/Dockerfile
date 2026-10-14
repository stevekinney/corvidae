# The local development container described in AGENTS.md under "Dev Container".
#
# The tag is the workspace's `packageManager` Bun version; `scripts/dev-container.test.ts`
# fails when the two drift apart.
FROM oven/bun:1.4.2

# PostgreSQL 17 is Debian 13's server major and the release the host-side fix for COR-1379
# installed. Only `initdb` and `pg_ctl` are needed: the live PostgreSQL and Neon suites in
# `packages/weft` start their own disposable `--no-locale` UTF8 cluster, so the packaged
# `main` cluster is never created. Validation itself needs `git` (Weft's coverage check
# lists files with `git ls-files`, and several suites shell out to it). `sudo` lets the
# `onCreateCommand` hand the root-owned `node_modules` volume to the `bun` user.
RUN mkdir -p /etc/postgresql-common \
  && echo 'create_main_cluster = false' > /etc/postgresql-common/createcluster.conf \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git postgresql-17 sudo \
  && rm -rf /var/lib/apt/lists/* \
  && echo 'bun ALL=(root) NOPASSWD:ALL' > /etc/sudoers.d/bun \
  && chmod 0440 /etc/sudoers.d/bun

# Debian keeps the server binaries off PATH; the suites find them with `Bun.which`.
ENV PATH=/usr/lib/postgresql/17/bin:$PATH
# Keep Turborepo's local cache out of the bind-mounted checkout, so a host run never
# replays a task result this Linux container produced, or the reverse.
ENV TURBO_CACHE_DIR=/home/bun/.cache/turbo

# `initdb` refuses to run as root, so the container works as the image's `bun` user.
# A bind-mounted checkout is owned by the host's uid, which Git would otherwise reject
# as dubious ownership.
USER bun
RUN git config --global --add safe.directory '*' \
  && mkdir -p /home/bun/.cache/turbo
