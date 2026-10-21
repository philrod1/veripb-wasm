FROM ubuntu:24.04

ARG RUST_VERSION=stable
ARG USERNAME=dev
ARG USER_UID=1000

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    build-essential curl git cmake pkg-config \
    valgrind \
    ripgrep fd-find \
    sudo ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Node.js 22 LTS (required for Claude Code)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash -u $USER_UID $USERNAME \
  && echo "$USERNAME ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

USER $USERNAME
WORKDIR /home/$USERNAME

ENV PATH="/home/$USERNAME/.cargo/bin:/home/$USERNAME/.npm-global/bin:$PATH"

# Configure npm to install globally without sudo
RUN mkdir -p ~/.npm-global \
  && npm config set prefix '~/.npm-global'

# Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain 1.95.0

RUN rustup component add rust-analyzer clippy rustfmt rust-src \
  && cargo install --locked \
      cargo-criterion \
      cargo-watch \
      iai-callgrind-runner \
  && curl -LsSf https://get.nexte.st/latest/linux | tar zxf - -C /home/$USERNAME/.cargo/bin

ARG HYPERFINE_VERSION=1.19.0
RUN HYPERFINE_TARGET="$(uname -m)-unknown-linux-gnu" \
  && curl -LsSf https://github.com/sharkdp/hyperfine/releases/download/v${HYPERFINE_VERSION}/hyperfine-v${HYPERFINE_VERSION}-${HYPERFINE_TARGET}.tar.gz \
  | tar zxf - --strip-components=1 -C /home/$USERNAME/.cargo/bin hyperfine-v${HYPERFINE_VERSION}-${HYPERFINE_TARGET}/hyperfine

RUN rustup target add wasm32-unknown-unknown wasm32-wasip1

# Claude Code
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace
CMD ["bash"]
