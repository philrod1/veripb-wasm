FROM ubuntu:24.04

ARG RUST_VERSION=1.95.0
ARG USERNAME=dev
ARG USER_UID=1000

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl git cmake pkg-config \
    openssh-client less \
    valgrind ripgrep fd-find \
    sudo ca-certificates \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

# Test tooling: python3 (serve.py, compare-tui.py), xz for the Node tarball,
# and the libraries and a font that Playwright's headless Chrome needs
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 xz-utils \
    libglib2.0-0t64 libnspr4 libnss3 libatk1.0-0t64 libatspi2.0-0t64 \
    libdbus-1-3 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
    libxfixes3 libxrandr2 libxkbcommon0 libgbm1 libasound2t64 \
    fontconfig fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# ubuntu:24.04 ships a default 'ubuntu' user that already owns UID 1000
RUN userdel -r ubuntu 2>/dev/null || true \
  && useradd -m -s /bin/bash -u $USER_UID $USERNAME \
  && echo "$USERNAME ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/$USERNAME

USER $USERNAME
WORKDIR /home/$USERNAME

ENV PATH="/home/$USERNAME/.local/bin:/home/$USERNAME/.cargo/bin:$PATH" \
    CARGO_TARGET_DIR=/home/$USERNAME/target

# Pre-create volume mount points so named volumes inherit dev's ownership
RUN mkdir -p ~/target ~/.cargo/registry ~/.claude

# Rust (minimal profile skips the large rust-docs component)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --profile minimal --default-toolchain $RUST_VERSION \
  && rustup component add rust-analyzer clippy rustfmt rust-src \
  && rustup target add wasm32-wasip1

# Node 22, only for web/test/*.mjs
ARG NODE_VERSION=22.23.4
RUN mkdir -p ~/.local/node \
  && curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-$(dpkg --print-architecture | sed 's/amd64/x64/').tar.xz \
     | tar -xJ -C ~/.local/node --strip-components=1 \
  && ln -s ~/.local/node/bin/node ~/.local/node/bin/npm ~/.local/bin/

# Playwright and its headless Chrome, for web/test/browser-smoke.mjs
ENV PLAYWRIGHT_BROWSERS_PATH=/home/$USERNAME/.cache/ms-playwright \
    PLAYWRIGHT_CORE=/home/$USERNAME/.local/pw/node_modules/playwright-core
RUN mkdir -p ~/.local/pw && cd ~/.local/pw \
  && npm init -y >/dev/null && npm install -s playwright-core@1 \
  && node node_modules/playwright-core/cli.js install chromium-headless-shell


# Rust tooling as prebuilt binaries where available (falls back to compiling)
RUN curl -L --proto '=https' --tlsv1.2 -sSf \
      https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash \
  && cargo binstall -y --locked \
      cargo-criterion hyperfine cargo-watch cargo-nextest iai-callgrind-runner \
  && rm -rf ~/.cargo/registry/* ~/.cargo/git

# Claude Code native binary (no Node.js needed)
RUN curl -fsSL https://claude.ai/install.sh | bash

WORKDIR /workspace
CMD ["bash"]
