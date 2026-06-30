# Forge — Docker agent image
# Pre-installs common dev tools + language toolchains so agents don't waste time on setup.
# Multi-stage: the `rust`, `go`, and `tools` builder stages build in parallel under BuildKit;
# the final stage (the shipped agent image) copies their artifacts in.
# Build:  DOCKER_BUILDKIT=1 docker build -t forge-agent:latest docker/

ARG UBUNTU=ubuntu:22.04

# ===== builder: tools (lazygit, git-delta, starship, uv + Python 3.11, ruff/black/isort/mypy, AWS CLI v2) =====
FROM ${UBUNTU} AS tools
ENV DEBIAN_FRONTEND=noninteractive \
    UV_INSTALL_DIR=/opt/extra/bin \
    UV_PYTHON_INSTALL_DIR=/opt/extra/uv/python \
    UV_TOOL_DIR=/opt/extra/uv/tools \
    UV_TOOL_BIN_DIR=/opt/extra/bin \
    PATH=/opt/extra/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/extra/bin
# lazygit + git-delta (arch-aware GitHub releases)
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) lg=x86_64; dl=x86_64-unknown-linux-gnu ;; \
                    arm64) lg=arm64;  dl=aarch64-unknown-linux-gnu ;; \
                    *) echo "unsupported arch $arch"; exit 1 ;; esac; \
    lgver="$(curl -fsSL https://api.github.com/repos/jesseduffield/lazygit/releases/latest | grep -Po '"tag_name": *"v\K[^"]*')"; \
    curl -fsSL "https://github.com/jesseduffield/lazygit/releases/download/v${lgver}/lazygit_${lgver}_Linux_${lg}.tar.gz" -o /tmp/lazygit.tgz; \
    tar -C /opt/extra/bin -xzf /tmp/lazygit.tgz lazygit; \
    dver="$(curl -fsSL https://api.github.com/repos/dandavison/delta/releases/latest | grep -Po '"tag_name": *"\K[^"]*')"; \
    curl -fsSL "https://github.com/dandavison/delta/releases/download/${dver}/delta-${dver}-${dl}.tar.gz" -o /tmp/delta.tgz; \
    tar -C /tmp -xzf /tmp/delta.tgz; mv "/tmp/delta-${dver}-${dl}/delta" /opt/extra/bin/delta; \
    rm -rf /tmp/lazygit.tgz /tmp/delta.tgz "/tmp/delta-${dver}-${dl}"
# starship
RUN curl -fsSL https://starship.rs/install.sh | sh -s -- -y -b /opt/extra/bin
# uv + Python 3.11 + linters
RUN set -eux; \
    curl -LsSf https://astral.sh/uv/install.sh | sh; \
    command -v uv >/dev/null || cp "$HOME/.local/bin/uv" /opt/extra/bin/; \
    uv python install 3.11; \
    ln -sf "$(uv python find 3.11)" /opt/extra/bin/python3.11; \
    uv tool install ruff; uv tool install black; uv tool install isort; uv tool install mypy
# AWS CLI v2
RUN set -eux; \
    arch="$(uname -m)"; \
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${arch}.zip" -o /tmp/awscliv2.zip; \
    cd /tmp; unzip -q awscliv2.zip; ./aws/install --install-dir /opt/extra/aws-cli --bin-dir /opt/extra/bin; \
    cd /; rm -rf /tmp/aws /tmp/awscliv2.zip
RUN chmod -R a+rX /opt/extra

# ===== builder: rust (long pole) =====
FROM ${UBUNTU} AS rust
ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain 1.93.0 --profile default --no-modify-path; \
    rustup component add clippy rust-analyzer rust-src; \
    cargo install cargo-watch cargo-audit; \
    cargo install --locked cargo-nextest; \
    chmod -R a+rX "$CARGO_HOME" "$RUSTUP_HOME"

# ===== builder: go =====
FROM ${UBUNTU} AS go
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) ga=amd64 ;; arm64) ga=arm64 ;; *) echo "unsupported $arch"; exit 1 ;; esac; \
    GO_VERSION=1.24.4; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ga}.tar.gz" -o /tmp/go.tgz; \
    tar -C /usr/local -xzf /tmp/go.tgz; rm /tmp/go.tgz

# ===== final: the shipped agent image (run with --user 1000:1000) =====
FROM ${UBUNTU}
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Core tools + languages + dev extras
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Basics
    ca-certificates curl wget git openssh-client gnupg \
    # Build essentials
    build-essential pkg-config libssl-dev \
    # Python
    python3 python3-pip python3-venv \
    # Shells & utilities
    bash zsh jq ripgrep fd-find fzf tree unzip less bat \
    # Dev extras
    tmux htop direnv cmake clang postgresql-client silversearcher-ag \
    # Process inspection
    procps \
    # Networking
    dnsutils iputils-ping netcat-openbsd \
    # Editor (agents sometimes need a $EDITOR)
    nano \
    && rm -rf /var/lib/apt/lists/*

# Make fd/bat available under their common names (Ubuntu ships fdfind/batcat)
RUN ln -sf "$(command -v fdfind)" /usr/local/bin/fd 2>/dev/null || true; \
    ln -sf "$(command -v batcat)" /usr/local/bin/bat 2>/dev/null || true

# Add apt repos: NodeSource (Node 22 LTS) and GitHub CLI
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
         | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
         > /etc/apt/sources.list.d/nodesource.list \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list

# Install Node.js, npm, and GitHub CLI in one layer
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs git-lfs gh \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g npm@10

# AI agent CLIs — must be present so Docker-mode tasks can execute them
RUN npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli opencode-ai

# Antigravity CLI (agy) — Go binary via the official installer; --dir drops it on PATH
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin \
    && agy --version

# Default git config so commits work out of the box inside containers
RUN git config --system init.defaultBranch main \
    && git config --system advice.detachedHead false

# Language toolchains + extra CLIs from the parallel builder stages
COPY --from=tools /opt/extra        /opt/extra
COPY --from=rust  /usr/local/cargo  /usr/local/cargo
COPY --from=rust  /usr/local/rustup /usr/local/rustup
COPY --from=go    /usr/local/go     /usr/local/go
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo \
    UV_INSTALL_DIR=/opt/extra/bin \
    UV_PYTHON_INSTALL_DIR=/opt/extra/uv/python \
    UV_TOOL_DIR=/opt/extra/uv/tools \
    UV_TOOL_BIN_DIR=/opt/extra/bin \
    PATH=/usr/local/go/bin:/usr/local/cargo/bin:/opt/extra/bin:$PATH

# Non-root user — use --user 1000:1000 in docker run as needed
RUN groupadd --gid 1000 agent \
    && useradd --uid 1000 --gid agent --shell /bin/bash --create-home agent

# Curated dotfiles (no secrets, no baked git identity) + vim-gitgutter
COPY --chown=1000:1000 dotfiles/bashrc        /home/agent/.bashrc
COPY --chown=1000:1000 dotfiles/gitconfig     /home/agent/.gitconfig
COPY --chown=1000:1000 dotfiles/tmux.conf     /home/agent/.tmux.conf
COPY --chown=1000:1000 dotfiles/vimrc         /home/agent/.vimrc
COPY --chown=1000:1000 dotfiles/starship.toml /home/agent/.config/starship.toml
RUN set -eux; \
    git clone --depth=1 https://github.com/airblade/vim-gitgutter \
      /home/agent/.vim/pack/plugins/start/vim-gitgutter; \
    chown -R 1000:1000 /home/agent/.config /home/agent/.vim

ENV SHELL=/bin/bash
WORKDIR /app
CMD ["bash"]
