# Repo Root Layout

Most of `C:\Greenhaven` is conventional: `packages/*` workspaces,
`docs/`, `scripts/`, `migrations/` (under `packages/web-server/`), and
the standard JS/TS toolchain. This file documents the **non-workspace
root directories** that aren't obvious from a glance, so future agents
don't waste time auditing them again.

The Phase-7 hygiene fixspec `H-5` covered the four entries that
historically had no documented ownership: `bundle/`, `sea/`,
`kit-shell/`, and `ena-chat/`.

## Classification

| Directory    | Status            | Notes                                                                                                                  |
| ------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `bundle/`    | generated output  | Produced by `npm run bundle` (esbuild + `scripts/copy_bundle_assets.js`). Root `package.json` ships `bin.gemini = "bundle/gemini.js"` and lists `bundle/` in `files`. Gitignored. Do not edit by hand. |
| `sea/`       | active source     | Two-file Node SEA launcher (`sea-launch.cjs` + `sea-launch.test.js`) plus its Vitest harness. Wired into root `package.json` via `"test:sea-launch": "vitest run sea/sea-launch.test.js"` and called from `test` / `test:ci`. Tracked; do not move. |
| `kit-shell/` | archived experiment | Self-contained shell experiment snapshot (~8.8 k files, carries its own nested `.git`, `.cargo`, `.claude`, `.github`, agent prompts, asset trees). Not a Greenhaven workspace package, not referenced by any active build/test/source path. Kept on disk for historical reference; gitignored so it doesn't pollute searches or tracked status. |
| `ena-chat/`  | active donor       | Upstream donor tree (~34 k files) that hosts `ena-chat/tools/sticker-studio/` — the sticker-pack tooling `docs/cartridge/sticker-studio-node.md` invokes via `npm --prefix ena-chat/tools/sticker-studio run forge -- ...`. Not part of the Greenhaven workspace and not bundled into desktop builds, but the path must keep resolving on disk for the sticker-studio workflow. Gitignored to remove search noise; do **not** move without simultaneously rewriting every command in `docs/cartridge/sticker-studio-node.md`. |

## Operator rules

- `bundle/` is a build artifact. Wipe it with `npm run clean` and
  regenerate via `npm run bundle`. Never commit changes inside it.
- `sea/` is tracked source. Treat the two files like any other
  Apache-2.0 launcher: edit, run `npm run test:sea-launch`, commit.
- `kit-shell/` is read-only history. If you want to extract anything,
  copy it out and convert it into a real package or doc; do not modify
  in place.
- `ena-chat/tools/sticker-studio/` is the live sticker-studio path.
  Treat the rest of `ena-chat/` as read-only donor history.

## Why these aren't workspace packages

The `packages/` workspace exists for code Greenhaven actively ships:
the Hono web-server, the Vite + React UI, the Electron desktop shell,
the cartridge-forge, etc. The four root directories above are either
disposable build output (`bundle/`), a single-file launcher that
predates the workspace layout (`sea/`), or external donor / experiment
trees that came in with their own toolchains and `.git` directories
(`kit-shell/`, `ena-chat/`). Pulling them into `packages/` would
either rewrite their history or pretend they're Greenhaven code, so we
leave them at the root, classify them here, and gitignore the donor /
archive entries.
