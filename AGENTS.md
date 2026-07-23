# Project Instructions

## Scope

These instructions apply to the entire `omp-keysmith` repository.

## Project purpose

`omp-keysmith` is an OMP Extension that manages versioned system prompts in a plugin-owned content-addressed store. It injects the active prompt through the `before_agent_start` Extension event without modifying OMP's `SYSTEM.md`, `APPEND_SYSTEM.md`, `config.yml`, or hooks.

## Runtime and tooling

- Runtime: OMP 17.0.7+ and Bun-compatible TypeScript.
- Package manager and test runner: Bun.
- Type checking: strict TypeScript with `tsc --noEmit`.
- Linting: oxlint.
- Runtime dependencies should remain zero unless a dependency replaces substantial, security-sensitive code.

Required verification:

```bash
bun run check
```

This runs type checking, linting, and the complete test suite.

## Repository layout

- `src/extension.ts`: OMP Extension registration, command handling, UI output, and turn-level injection.
- `src/command.ts`: slash-command tokenization, option validation, aliases, and usage text.
- `src/prompt-store.ts`: strict state schema, deployment layering, content-addressed storage, status, recovery, and doctor operations.
- `src/safe-fs.ts`: no-follow reads, stable file snapshots, atomic publication, fsync, and exact cleanup.
- `src/constants.ts`: schema, filenames, prompt metadata, regular expressions, and permissions.
- `src/types.ts`: persisted and public store types.
- `assets/default-prompt.md`: byte-pinned upstream built-in prompt.
- `tests/`: observable command, store, and Extension contracts.

## Non-negotiable invariants

### Built-in prompt provenance

`assets/default-prompt.md` must remain byte-identical to `codex-instruct.py::BUILTIN_GPT_UNRESTRICTED_MD` at codex-keysmith commit `700f1be22446af4dc2c362080cbde669e215094d`.

Expected SHA-256:

```text
2c2c9f0e008c492bfc9487170a7a08daedeb8b0625af1f85617ab2d1bd3f35c0
```

Never trim, normalize line endings, remove the final newline, template, translate, or reformat the asset. Any intentional upstream refresh must update the pinned commit, hash, tests, README, and source metadata together.

### System-prompt chaining

The active prompt must be appended to the current event value:

```ts
return { systemPrompt: [...event.systemPrompt, active.content] };
```

Never replace the array with only the keysmith prompt. `event.systemPrompt`, not `ctx.getSystemPrompt()`, is the current value in the multi-Extension chain.

A missing, uninitialized, or disabled deployment returns no system-prompt override. Prompt integrity failure must fail closed and preserve OMP's existing prompt.

### Path resolution

External relative prompt paths must resolve from the live command context `ctx.cwd`, not `process.cwd()` or the Extension load directory. Keep a test where these directories differ.

The store root must be derived from `pi.pi.getAgentDir()` so OMP profiles and `PI_CODING_AGENT_DIR` continue to work.

### Filesystem ownership and integrity

- Only plugin-owned paths under `<agent-dir>/keysmith` may be mutated.
- Never modify OMP prompt files, configuration, hooks, Codex directories, or legacy prompt files.
- External prompts, state, locks, temporary files, and blobs must be regular no-follow nodes.
- Preserve stable-read identity and size/mtime checks around file reads.
- SHA-256 over original UTF-8 bytes is the blob identity; mtime and inode are concurrency evidence, not content identity.
- Blob publication must remain no-replace and content-addressed.
- Mutable state publication must remain atomic and fsynced.
- Unknown, malformed, symlinked, or concurrently changed nodes fail closed and remain untouched.
- Status is strictly read-only. It must not initialize directories, create locks, or update timestamps.
- Recovery and doctor may delete only exact, validated, plugin-owned residue described by their preview results.

### Deployment semantics

- Preview and dry-run perform zero writes.
- In interactive mode, mutations require UI confirmation unless `--yes` is supplied.
- In headless mode, mutations require `--yes`.
- A deployment pushes one layer and records `enabledBefore`.
- Uninstall removes only the newest owned layer and restores `enabledBefore`.
- Immutable blobs are retained on uninstall and removed only by explicit doctor cleanup.
- Enable must verify that an active deployment and valid blob exist.
- The active blob is revalidated immediately before each turn-level injection.

### Command UX semantics

Command output and documentation must distinguish these independent concepts:

- `enable`/`disable` mutate a persistent switch. They apply across later turns and OMP sessions, retain every deployment layer, and never create a layer.
- `deploy` always pushes one deployment layer, selects it, and enables injection. It is for first deployment or a new prompt version, not for resuming a disabled layer.
- `/keysmith uninstall` and `rollback` pop only the newest owned deployment layer and restore that layer's `enabledBefore` value. They do not uninstall the OMP Extension package.
- `omp plugin uninstall omp-keysmith` is the shell command that removes the package. It does not automatically delete the plugin-owned state directory.
- `recover` is limited to recognized publication residue. It does not roll back valid deployment layers.
- `doctor --fix` is limited to unreferenced valid blobs. It does not remove selected layers or uninstall the package.

Status output must show the selected deployment even when injection is disabled. It must also provide a concrete next action:

- no layer: preview, then deploy;
- disabled with a layer: enable without deploying;
- enabled with a layer: disable to pause, or deploy only for a new layer;
- blocked: resolve integrity or structural issues first.

Help, mutation previews, and success messages must state whether a command changes the persistent switch, deployment stack, content-addressed blobs, or installed package. Keep tests for these distinctions so future wording changes cannot reintroduce the lifecycle ambiguity.

## Code conventions

- Use English for code, comments, tests, documentation, and user-facing messages.
- Follow the existing tab-indented TypeScript style.
- Prefer Node standard-library APIs and OMP's injected API over runtime dependencies.
- Use `Record` for small static string lookup tables and `Map`/`Set` for dynamic collections.
- Do not extract one-expression helper functions unless they define a durable public or domain contract.
- Keep public state schemas strict: reject unknown keys, wrong types, unsafe names, invalid hashes, and unsupported versions.
- Do not introduce compatibility shims or deprecated aliases; migrate every internal caller in one change.

## Testing requirements

Tests must defend observable contracts and use isolated temporary directories. Add or update tests when changing:

- command grammar, aliases, confirmation behavior, or path resolution;
- default prompt bytes, provenance, or source selection;
- state schema or deployment history;
- filesystem node handling, atomic publication, locks, recovery, or cleanup;
- enable/disable/uninstall transitions;
- active prompt verification or `before_agent_start` chaining.

High-risk filesystem tests must remain deterministic and must not follow or remove user-controlled targets.

## Installation verification

Production installation uses:

```bash
omp plugin install github:ParticleG/omp-keysmith
```

After package or manifest changes, verify:

```bash
omp plugin list
omp plugin doctor
```

For an Extension behavior smoke test, start a fresh OMP process and run `/keysmith status`. Initial installation requires a fresh Extension load; prompt state changes take effect on the next agent turn.
