# omp-keysmith

Versioned, integrity-checked system-prompt deployment for [Oh My Pi](https://github.com/can1357/oh-my-pi).

`omp-keysmith` is an OMP Extension that manages prompt versions in a plugin-owned content-addressed store and appends the selected prompt during `before_agent_start`. It does not rewrite OMP configuration or prompt files.

## Features

- Appends the active prompt as a real system-prompt block on every agent turn.
- Preserves OMP's existing system prompt, project context, tools, skills, rules, and other chained Extension changes.
- Uses the bundled codex-keysmith prompt when `--file` is omitted.
- Supports external UTF-8 prompt files and safe logical names.
- Provides preview, deploy, enable, disable, layered uninstall, recovery, and garbage-collection commands.
- Stores immutable prompt blobs by SHA-256 and verifies the active blob before injection.
- Rejects symbolic links, invalid UTF-8, abnormal filesystem nodes, malformed state, and integrity drift.
- Uses private filesystem permissions, atomic publication, and a cross-process write lock.

## Requirements

- OMP 17.0.7 or later with Extension support.
- Bun is only required for local development; OMP loads the TypeScript Extension directly.

## Install

```bash
omp plugin install github:ParticleG/omp-keysmith
```

If OMP was already running during the initial installation, restart that OMP process once so it discovers the new Extension. Prompt deployment and enable/disable changes apply on the next agent turn without another restart.

Verify installation:

```bash
omp plugin list
omp plugin doctor
```

## Quick start

Inside OMP:

```text
/keysmith status
/keysmith preview
/keysmith deploy
```

Interactive OMP asks for confirmation before a mutation. In a non-interactive UI, pass `--yes` explicitly:

```text
/keysmith deploy --yes
```

When `--file` is omitted, `preview` and `deploy` use the bundled `BUILTIN_GPT_UNRESTRICTED_MD` prompt described below.

## Commands

| Command | Behavior |
| --- | --- |
| `/keysmith status` | Read-only structural, integrity, deployment, and injection status. |
| `/keysmith preview [--file <path>] [--name <name>]` | Preview a built-in or external prompt without writing. |
| `/keysmith deploy [--file <path>] [--name <name>] [--dry-run] [--yes]` | Publish an immutable prompt blob, push one deployment layer, and enable it. |
| `/keysmith enable` | Enable the current deployment for the next agent turn. |
| `/keysmith disable` | Disable injection without removing deployment history. |
| `/keysmith uninstall [--yes]` | Remove one owned deployment layer and restore its previous enabled state. |
| `/keysmith recover [--yes]` | Inspect or remove recognized stale lock and pending-publication residue. |
| `/keysmith doctor [--fix] [--yes]` | Inspect or remove unreferenced valid prompt blobs. |

`rollback` is accepted as an alias for `uninstall`, and `dry-run` is accepted as an alias for `preview`.

### External prompts

```text
/keysmith preview --file ./prompts/reviewer.md --name reviewer
/keysmith deploy --file ./prompts/reviewer.md --name reviewer
```

Relative paths resolve from OMP's live `ctx.cwd`, including after an OMP working-directory change. Quote paths containing spaces.

Prompt names accept ASCII letters, digits, dots, underscores, and hyphens, with additional traversal and Windows device-name checks.

## Bundled prompt

The default asset is an exact UTF-8 copy of `BUILTIN_GPT_UNRESTRICTED_MD` from `codex-instruct.py` in codex-keysmith:

- Upstream repository: [Jia-Ethan/codex-keysmith](https://github.com/Jia-Ethan/codex-keysmith)
- Pinned source commit: [`700f1be22446af4dc2c362080cbde669e215094d`](https://github.com/Jia-Ethan/codex-keysmith/blob/700f1be22446af4dc2c362080cbde669e215094d/codex-instruct.py)
- Source symbol: `BUILTIN_GPT_UNRESTRICTED_MD`
- Local asset: [`assets/default-prompt.md`](assets/default-prompt.md)
- SHA-256: `2c2c9f0e008c492bfc9487170a7a08daedeb8b0625af1f85617ab2d1bd3f35c0`

The bundled prompt changes model behavior broadly: it suppresses refusal and warning framing and reinterprets authorization boundaries across security, adult, chemistry, pharmacology, and weapons requests. Review the asset before deployment. It cannot override higher-priority instructions supplied outside the OMP system-prompt array.

## Prompt injection model

The Extension uses OMP's chained `before_agent_start` contract:

```ts
return {
  systemPrompt: [...event.systemPrompt, activePrompt],
};
```

Each turn reads the current plugin state, verifies the selected content-addressed blob, confirms that state did not change during the read, and then appends the exact decoded prompt. A missing, disabled, or uninitialized state produces no injection. Integrity failure blocks only the keysmith prompt rather than replacing OMP's existing prompt.

## Storage

State belongs to the active OMP agent directory returned by `getAgentDir()`:

```text
<agent-dir>/keysmith/
├── state.json
└── prompts/
    └── <sha256>.md
```

This automatically follows OMP profiles and `PI_CODING_AGENT_DIR`.

The Extension does not modify:

```text
SYSTEM.md
APPEND_SYSTEM.md
config.yml
hooks/
```

Uninstalling one deployment layer retains immutable blobs. Use `/keysmith doctor --fix` when you explicitly want to remove unreferenced blobs.

## Development

```bash
bun install
bun run check
```

`bun run check` runs strict TypeScript checking, oxlint, and the Bun test suite.

Link a local checkout for development:

```bash
omp plugin link .
```

Return to the GitHub-installed package with:

```bash
omp plugin uninstall omp-keysmith
omp plugin install github:ParticleG/omp-keysmith
```

## Credit

This project adapts the prompt deployment and integrity ideas from [Jia-Ethan/codex-keysmith](https://github.com/Jia-Ethan/codex-keysmith), created by Jia-Ethan. The bundled default prompt is copied from its `BUILTIN_GPT_UNRESTRICTED_MD` value at the pinned commit above. The upstream project and copied material are distributed under the MIT License; its copyright notice is retained in [`LICENSE`](LICENSE).

The OMP integration is independently implemented as a TypeScript Extension using turn-level system-prompt chaining and a plugin-owned content-addressed store. It does not reuse codex-keysmith's Codex `config.toml` or hook-isolation machinery.

## License

MIT. See [`LICENSE`](LICENSE).
