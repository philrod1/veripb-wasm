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
  && rustup component add rust-analyzer clippy rustfmt rust-src

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
