# The factory floor.
#
# Agents get real tools here — bash, git, a package manager, a compiler — which
# is the only way they build anything worth reviewing. The safety is not a
# shrinking tool allowlist (agents route around those, and it becomes a
# blocklist you maintain forever); it is this boundary plus the egress proxy in
# compose.yaml.

# ---------------------------------------------------------------- desk build
# Vite and Vue live in devDependencies, and the runtime image installs
# production deps only. Building here keeps the toolchain out of the shipped
# image while still shipping a built console.
FROM node:26-slim AS desk
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-fund --no-audit
COPY desk ./desk
RUN npx vite build --config desk/vite.config.ts

# ----------------------------------------------------------------- dev stage
# Same base and same tools, but keeps devDependencies so vite and tsgo are
# there. No source is copied: compose.dev.yaml mounts the working tree over
# /app, which is the whole point — edit on the host, reload in the box.
FROM node:26-slim AS dev
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep jq less procps tini chromium fonts-liberation \
      bubblewrap socat \
      ffmpeg \
 && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN useradd -m -u 10001 -s /bin/bash labs && mkdir -p /data /app && chown -R labs:labs /data /app
WORKDIR /app
COPY --chown=labs:labs package*.json ./
# npm runs as root here, so node_modules lands root-owned — and the anonymous
# volume compose mounts over it inherits that ownership. Vite then cannot write
# its own dependency cache and the dev server dies on first request.
ARG CLAUDE_SDK_VERSION=
RUN npm ci --no-fund --no-audit \
 && if [ -n "$CLAUDE_SDK_VERSION" ]; then \
      npm install --no-save --no-fund --no-audit "@anthropic-ai/claude-agent-sdk@$CLAUDE_SDK_VERSION"; fi \
 && set -- /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude \
 && [ "$#" -eq 1 ] && [ -x "$1" ] && ln -sf "$1" /usr/local/bin/claude \
 && mkdir -p /app/node_modules/.vite \
 && chown -R labs:labs /app/node_modules
COPY --chown=labs:labs docker/entrypoint.sh /entrypoint.sh
USER labs
RUN git config --global user.name "Riff" \
 && git config --global user.email "riff@localhost" \
 && git config --global init.defaultBranch main \
 && git config --global --add safe.directory '*'
ENV NODE_ENV=development RIFF_ROOT=/data RIFF_CONTAINED=1 PORT=4173
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

# ------------------------------------------------------------------- runtime
# Named, and the factory service targets it by name. It is NOT the last stage
# any more — keyproxy is — and an untargeted build resolves to the last stage,
# so adding keyproxy below silently made an untargeted factory build the proxy
# instead (the container booted `keyproxy listening on :8890` and no gateway).
FROM node:26-slim AS runtime

# Build tooling the staff will actually need. Kept deliberately small — add per
# line of business rather than pre-installing a kitchen sink.
#
# tar and gzip are NOT listed because node:26-slim (Debian) already ships GNU
# tar 1.35 and gzip. Company export and import shell out to them. A base image
# without them — alpine's busybox tar, or anything distroless — breaks both,
# so add them explicitly if this line ever changes.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep jq less procps tini \
      bubblewrap socat \
 && rm -rf /var/lib/apt/lists/*

# bubblewrap and socat are Claude Code's own Bash sandbox on Linux: bwrap
# enforces the filesystem boundary, socat relays network through its proxy.
# Without them the CLI reports the sandbox unavailable and — unless
# failIfUnavailable is set — runs commands unsandboxed.
#
# They need a user namespace, which Docker's DEFAULT seccomp profile refuses
# for every container: `unshare` is allowlisted only alongside CAP_SYS_ADMIN,
# so it falls through to the profile's SCMP_ACT_ERRNO. Measured four ways —
# plain container, cap_drop ALL, our full profile, and seccomp=unconfined —
# and only the last one permits it. docker/seccomp-userns.json is Docker's
# profile with that one group added; compose.yaml names it.

# A headless browser, and the fonts it needs to draw text at all.
#
# Every artefact a company here ships is a single HTML file a stranger opens,
# and without a browser nothing anyone builds is ever looked at before it
# reaches the board. Lathe shipped a corrupt dist/plate.html for a whole shift
# with every test passing, because the tests ran the logic in a Node vm and
# nothing ever loaded the page.
#
# Debian's chromium rather than Playwright's own download: the bundled build
# pulls its system libraries with apt as root, and agents are uid 10001.
# Installing the package pulls the libraries in as its own dependencies —
# libnss3, libatk, libgbm, libxkbcommon, libasound, libcups and libpango are
# all present after this line, with nothing unresolved in the binary.
#
# Playwright reads NO environment variable for the executable — it looks only
# in its own versioned cache and fails with "Executable doesn't exist at
# ~/.cache/ms-playwright/...". It must be told explicitly:
#
#     chromium.launch({ executablePath: process.env.CHROME_PATH,
#                       args: ['--no-sandbox'] })
#
# SKIP_BROWSER_DOWNLOAD stops `npm i playwright` fetching a second copy that
# would then need the same libraries again. puppeteer-core does honour its
# variable, and needs nothing further.
#
# Chromium's namespace sandbox needs privileges this container does not grant,
# so launches pass --no-sandbox. That is not a weakening: the container IS the
# sandbox, and the page being rendered is one the company just wrote itself.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# ffmpeg, for getting a frame out of a video.
#
# Not codecs — Debian's chromium already decodes H.264 and AAC (it depends on
# libopenh264, and canPlayType reports "probably" for avc1.42E01E in this
# image). The staff concluded otherwise after a vendor's marketing video
# screenshotted black, and the cause was the capture rather than the codec:
# in headless, virtual time races the media pipeline and a software-decoded
# frame often never composites into the screenshot.
#
# So the fix is the right tool rather than a missing library. `ffmpeg -ss <t>
# -i <url> -frames:v 1 out.png` pulls any frame from any video, deterministically
# and without a browser. It costs about 200 packages, which is the largest
# thing in this image by some way; it is here because a vendor's own product
# footage was the best evidence this company ever found, and a still from it
# beat every written description of the same screen.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Never root. An agent with a shell should not also have the box.
RUN useradd -m -u 10001 -s /bin/bash labs \
 && mkdir -p /data /app \
 && chown -R labs:labs /data /app

WORKDIR /app
COPY --chown=labs:labs package*.json ./
# Claude Code, as each release ships. docker/up.sh looks up the newest Agent
# SDK — which carries its CLI, version for version — and passes it here, so a
# rebuild is the upgrade. Empty, as a bare compose build leaves it, is the
# lockfile's version.
ARG CLAUDE_SDK_VERSION=
RUN npm ci --omit=dev --no-fund --no-audit \
 && if [ -n "$CLAUDE_SDK_VERSION" ]; then \
      npm install --omit=dev --no-save --no-fund --no-audit "@anthropic-ai/claude-agent-sdk@$CLAUDE_SDK_VERSION"; fi
# One Claude Code in the image: the one the SDK drives. `claude` on PATH was a
# second, separate `@latest` install, fixed at the day the image was built —
# 2.1.270 beside an SDK on 2.1.281 — and the staff's own products run it
# (ShipIt's agent runner execs /usr/local/bin/claude). Exactly one platform
# build, or the image fails here rather than linking the wrong one.
#
# And the CLI must be the one the SDK says it carries: the runtime route's
# user-agent is read from that claim, and every "measured on 2.1.N" is too.
RUN set -- /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude \
 && [ "$#" -eq 1 ] && [ -x "$1" ] \
 && ln -sf "$1" /usr/local/bin/claude \
 && ran=$(claude --version | cut -d' ' -f1) \
 && said=$(node -p "require('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json').claudeCodeVersion") \
 && echo "Claude Code $ran (SDK says $said)" && [ "$ran" = "$said" ]
COPY --chown=labs:labs . .
COPY --chown=labs:labs --from=desk /app/desk/dist ./desk/dist
COPY --chown=labs:labs docker/entrypoint.sh /entrypoint.sh

USER labs

# git refuses to commit without an identity, and the world is a git repo that
# every shift writes to. Individual commits are attributed per agent.
RUN git config --global user.name  "Riff" \
 && git config --global user.email "riff@localhost" \
 && git config --global init.defaultBranch main \
 && git config --global --add safe.directory '*'

# RIFF_ROOT is the INSTALLATION root — companies/ and archive/ live under
# it. It must point at the mounted volume: set to a path outside the mount and
# every company is written to the container's own filesystem and destroyed on
# the next restart, silently.
#
# RIFF_CONTAINED opens the shell. The runtime also requires a container
# marker file, so this variable on its own does nothing on someone's laptop.
ENV NODE_ENV=production \
    RIFF_ROOT=/data \
    RIFF_CONTAINED=1 \
    PORT=4173 \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

EXPOSE 4173

# tini reaps the processes agents spawn; without it a runaway build leaves
# zombies behind for the life of the container.
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "src/gateway/server.ts"]

# ------------------------------------------------------------------ keyproxy
# The key-injecting proxy. It is the single most sensitive container in the
# system — it mounts the whole installation read-only and is the one process
# that decrypts a company's real keys — so it gets the SMALLEST image, not the
# factory's. No bash, no compiler, no browser, no Claude CLI: a foothold here
# lands in a box with none of the exfil tooling the factory carries, and the
# proxy needs none of it. It imports only node: builtins and src/core, so it
# needs no node_modules at all; keep that true, or this stage stops building.
#
# ca-certificates is the one dependency a TLS client legitimately needs, to
# validate the upstream it forwards a real key to.
FROM node:26-slim AS keyproxy
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# nologin, not bash: nothing here is ever meant to open a shell.
RUN useradd -m -u 10001 -s /usr/sbin/nologin labs \
 && mkdir -p /data /app \
 && chown -R labs:labs /data /app
WORKDIR /app
# package.json only for `"type": "module"`, so node reads the .ts files as ESM
# and strips their types. No npm install — there are no dependencies to fetch.
COPY --chown=labs:labs package.json ./
COPY --chown=labs:labs src/core ./src/core
COPY --chown=labs:labs src/keyproxy ./src/keyproxy
# One file, not a dependency: the SDK's own package.json, so the runtime route's
# `user-agent: claude-code/<version>` names the CLI the factory was built with
# (CLAUDE_CODE_UA reads it). Copied from the runtime stage because that is where
# the version up.sh resolved was installed; the lockfile's may be older.
COPY --chown=labs:labs --from=runtime /app/node_modules/@anthropic-ai/claude-agent-sdk/package.json \
     ./node_modules/@anthropic-ai/claude-agent-sdk/package.json
USER labs
ENV NODE_ENV=production \
    RIFF_ROOT=/data \
    KEYPROXY_PORT=8890
ENTRYPOINT ["node", "src/keyproxy/main.ts"]
