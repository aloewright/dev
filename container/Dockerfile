# AGPL-3.0-or-later
FROM node:22-slim

ENV NODE_ENV=production
ENV PORT=8080

# Toolchains for the test gate: git + TLS roots (clone), python3/pip, Go
# (installed below), and a C/C++ toolchain (build-essential + python3-dev) so
# native deps build — node-gyp modules, Python C extensions, cgo. node:22-slim
# ships none of these.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git ca-certificates curl \
       build-essential \
       python3 python3-pip python3-venv python3-dev \
  && rm -rf /var/lib/apt/lists/*

# Git-over-HTTPS hardening for the sandbox's egress path. Debian git links
# libcurl3-gnutls, whose TLS 1.3 handshakes through the container egress are
# terminated mid-clone with "GnuTLS recv error (-110): The TLS connection was
# non-properly terminated" (confirmed via per-token logging: the clone fails on
# TLS, not auth — the PAT is valid). Pinning TLS 1.2 + HTTP/1.1 sidesteps the
# gnutls/TLS1.3 + middlebox interaction; the buffer/low-speed settings keep
# large clone/fetch/push resilient. Applied system-wide so any user's git uses it.
RUN git config --system http.version HTTP/1.1 \
  && git config --system http.sslVersion tlsv1.2 \
  && git config --system http.postBuffer 524288000 \
  && git config --system http.lowSpeedLimit 1000 \
  && git config --system http.lowSpeedTime 60

# Go toolchain (arch-matched to the build platform). GOTOOLCHAIN=local pins to
# this version so a repo's go.mod cannot trigger an out-of-band toolchain
# download at test time.
ARG GO_VERSION=1.23.4
RUN ARCH="$(dpkg --print-architecture)" \
  && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" -o /tmp/go.tgz \
  && tar -C /usr/local -xzf /tmp/go.tgz \
  && rm /tmp/go.tgz
ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOTOOLCHAIN=local

# pytest system-wide so `python3 -m pytest` works even when a repo does not list
# it as a dependency. Repo deps install per-run with `pip install --user`.
RUN python3 -m pip install --no-cache-dir --break-system-packages pytest

# Pin these in production for reproducible, supply-chain-reviewed builds
# (override with --build-arg). See SANDBOX_REVIEW.md (sandbox findings).
ARG CODEX_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Run the agent (which executes model-generated changes) as a non-root user.
RUN useradd --system --create-home --home-dir /home/sandbox sandbox \
  && mkdir -p /app \
  && chown -R sandbox:sandbox /app /home/sandbox

# server.mjs imports these sibling modules at runtime; they MUST be in the image or
# the container crashes at boot (ERR_MODULE_NOT_FOUND) and never binds port 8080.
# Do NOT copy *.test.mjs (they import vitest, which isn't installed in the image).
COPY --chown=sandbox:sandbox server.mjs event-throttle.mjs agent-failure.mjs /app/

USER sandbox
WORKDIR /home/sandbox
ENV HOME=/home/sandbox
ENV GOPATH=/home/sandbox/go
ENV GOCACHE=/home/sandbox/.cache/go-build

EXPOSE 8080
CMD ["node", "/app/server.mjs"]
