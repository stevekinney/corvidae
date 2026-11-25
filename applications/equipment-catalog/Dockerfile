FROM oven/bun:1.4.4
RUN apt-get update && apt-get install -y --no-install-recommends g++ make python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run --cwd applications/equipment-catalog build
ENV NODE_ENV=production
CMD ["bun", "run", "--cwd", "applications/equipment-catalog", "start"]
