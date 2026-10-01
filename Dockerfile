# Overhear release image. Debian slim Node 22 plus ffmpeg: the audio mixer calls /usr/bin/ffmpeg and
# ffprobe through execFile with an argv array, never a shell. One image serves both the MCP server and
# the Alexa+ simulator; docker-compose chooses which to run. The default run is mock models plus local
# store, so a reviewer gets the whole product with no AWS keys and no spend.
FROM node:22-slim

# ffmpeg + ffprobe install to /usr/bin, the path the mixer uses.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install against the committed lockfile, then build every TypeScript package (server, libraries,
# conformance, simulator host). The web UI is a Vite app its own service builds and serves at run time.
COPY . .
RUN npm ci --no-audit --no-fund \
  && npx tsc -b

# 8787 MCP server, 5173 simulator UI.
EXPOSE 8787 5173

# Default to the server; the simulator service overrides this command.
CMD ["node", "packages/server/dist/main.js"]
