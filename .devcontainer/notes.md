# Rust Claude Dev Container Notes

## .env File

```
UID=<your uid, find with `id -u`>
USER=<your username>
CLAUDE_CODE_OAUTH_TOKEN=<token from `claude setup-token`>
```

- Add `.env` to your global gitignore: `echo ".env" >> ~/.gitignore_global`
- Set global gitignore: `git config --global core.excludesfile ~/.gitignore_global`
- Set permissions: `chmod 600 .env`

## Key Commands

### Docker

```bash
# Always run from project root, or pass -f explicitly:
docker compose -f .devcontainer/docker-compose.yml build 

# Start a shell
docker compose -f .devcontainer/docker-compose.yml run --rm rust-dev bash

# Run Claude Code
docker compose -f .devcontainer/docker-compose.yml run --rm rust-dev claude
# Resume session
docker compose -f .devcontainer/docker-compose.yml run --rm rust-dev claude --resume 5d569f44-8667-48dd-a9ac-720576d66c8d

# Run benchmarks
docker compose -f .devcontainer/docker-compose.yml run --rm rust-dev cargo criterion
docker compose -f .devcontainer/docker-compose.yml run --rm rust-dev hyperfine './target/release/my_binary'
```

- `--rm` removes the container on exit — cargo cache and workspace files persist regardless
- Rebuild after Dockerfile changes: `docker compose build`
- Remove named volumes (wipes cargo cache): `docker compose down -v`

### Claude Code OAuth Token

Generate a long-lived token (valid one year) for use in non-interactive environments:

```bash
claude setup-token
```

Set as `CLAUDE_CODE_OAUTH_TOKEN` in `.env`. Requires Pro, Max, Team, or Enterprise plan.

## Security Notes

- `cap_drop: ALL` drops all Linux capabilities — no elevated permissions
- No `SYS_ADMIN`, `SYS_PTRACE`, no `seccomp:unconfined`, no `pid: host`
- Only the project directory and cargo cache are mounted — no host home directory
- Secrets are in `.env`, not in the image or shell environment

## Benchmarking Tools (no elevated permissions needed)

- **Criterion** — microbenchmarks of Rust functions: `cargo criterion`
- **Hyperfine** — whole-program benchmarking: `hyperfine './target/release/binary'`
- **iai-callgrind** — instruction-count based, deterministic, ideal for long-running benchmarks
- **cargo-nextest** — faster test runner

## Profiling Tools (require elevated permissions, separate compose config)

For samply, perf, flamegraph — use a separate `docker-compose.perf.yml` with:

```yaml
cap_add:
  - SYS_ADMIN
  - SYS_PTRACE
security_opt:
  - seccomp:unconfined
pid: host
```

Run with:
```bash
docker compose -f .devcontainer/docker-compose.yml -f .devcontainer/docker-compose.perf.yml run --rm rust-dev bash
```

## Cargo Cache

- Stored in a named Docker volume (`cargo-cache`), persists across container runs
- Mounted at `/home/<user>/.cargo/registry`
- Caches downloaded crate source — compiled artifacts live in `target/` in your workspace
- Delete with `docker compose down -v` (also removes all other named volumes)
