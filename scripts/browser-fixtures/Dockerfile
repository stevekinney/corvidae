# The authoritative renderer for the committed Linux visual baselines
# (scripts/browser-fixtures/visual-baselines.md). Built for linux/arm64: this
# host is Apple Silicon and corvidae has no CI, so native arm64 replaced
# cinder's emulated x64 renderer (COR-1512).
#
# Both versions arrive as build arguments that the Docker wrapper derives from
# the repository (bun.lock and the root packageManager). Never type them here.
ARG PLAYWRIGHT_VERSION
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy

ARG PLAYWRIGHT_VERSION

# The workspace's own `packageManager` pin. Installing whatever bun.sh serves at
# build time would run a Bun the repository never pinned, which stays invisible
# until a Bun release changes behaviour and the branch under test looks broken.
ARG BUN_VERSION

# Read by the authenticity guard (docker-authenticity.ts): together they prove
# the process runs inside an image built from this Dockerfile, at the pinned
# Playwright version, rather than in any container that sets a flag.
ENV BASELINE_DOCKER=1
ENV BASELINE_PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}
ENV DEBIAN_FRONTEND=noninteractive

# Fail the build rather than fall back to "latest": an unpinned Bun is exactly
# the drift this argument exists to stop.
RUN test -n "${BUN_VERSION}" \
    || { echo 'BUN_VERSION build-arg is required (see readPinnedBunVersion)' >&2; exit 1; } \
    && apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
    && ln -sf /root/.bun/bin/bun /usr/local/bin/bunx

WORKDIR /work

ENTRYPOINT ["/bin/bash", "-lc"]
