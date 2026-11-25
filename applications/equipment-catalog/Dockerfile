FROM oven/bun:1.4.4
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run --cwd applications/equipment-catalog build
ENV NODE_ENV=production
CMD ["bun", "run", "--cwd", "applications/equipment-catalog", "start"]
