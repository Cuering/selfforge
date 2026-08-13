# selfforge — Agent Memory Leaderboard evaluation image
#
# Runs only the HTTP memory endpoints required by the benchmark contract
# (POST /add, POST /search, GET /health). The rest of the engine (plugin,
# dashboard, JSON-RPC) is intentionally excluded from this image.
#
# Build:
#   docker build -t selfforge-bench .
# Run:
#   docker run -p 9210:9210 -e SELFFORGE_PORT=9210 -e EVOLVE_HOME=/data selfforge-bench
FROM node:22-alpine

WORKDIR /app

# Copy the compiled, dependency-free serve-daemon bundle (built by build.mjs).
# It serves /add, /search and /health only when BENCH_ONLY=1.
COPY plugin/selfforge /opt/selfforge-src

# Build a standalone bundle for node (node:sqlite + node:http, no opencode).
RUN npx --yes bun@1 build /opt/selfforge-src/serve-daemon.ts \
      --outdir /app/out \
      --target node \
      --format esm \
      --minify \
      --external @opencode-ai/plugin

# Data volume (SQLite lives here; persists Add/Search state).
ENV EVOLVE_HOME=/data
ENV SELFFORGE_PORT=9210
ENV BENCH_ONLY=1

VOLUME ["/data"]
EXPOSE 9210

CMD ["node", "/app/out/serve-daemon.js"]