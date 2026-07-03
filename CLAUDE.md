# Pi Whiteboard — Dev Guide

## What this is

An Obsidian plugin that runs AI-assisted research on a Canvas, backed by `pi --mode rpc`.
Port of `whiteboard` (action palette) + `claude-canvas` (TS plumbing) onto a pi backend,
dropping Python.

## Quick Reference

```bash
npm install
npm run dev          # esbuild watch → main.js
npm run build        # production build
```

## Architecture

| File | Role |
|------|------|
| `src/main.ts` | Plugin entry: commands, action loop, prompt building, status bar. |
| `src/canvas-bridge.ts` | Canvas reads (selection, graph context) + writes (live API + file fallback), multi-node parsing. |
| `src/pi-session.ts` | Long-lived `pi --mode rpc` client; JSONL events; canvas-keyed memory. |
| `src/actions.ts` | Action palette registry (id, color, createsMultiple). |
| `src/settings.ts` | Settings tab + per-platform path resolution. |
| `prompts/*.md` | Prompt templates + `system.md`, read fresh per action. |

## Key decisions

- **Subprocess, not SDK.** `pi --mode rpc` is spawned as a child process (matches the
  claude-canvas precedent; avoids bundling the heavy pi agent into an Electron plugin).
- **Web-only toolset.** Spawned with `--no-builtin-tools --tools web_search,web_fetch`.
  The agent can never touch the filesystem. See `docs/adr/0001-web-toolset-only.md`.
- **No custom web_search tool.** The `@counterposition/pi-web-search` package (installed
  globally for pi) provides `web_search`/`web_fetch`, Tavily-backed via `TAVILY_API_KEY`.
- **Canvas-keyed memory.** One pi process; switching the active canvas sends `new_session`.
- **Fire-and-forget.** Trigger → status bar "WB: researching…" → result node(s) appear.

## Pipeline

```
command → getSelectionContext → buildContextSection (whiteboard style) + prompt template
        → piSession.sendPrompt → parseMultiple (if createsMultiple)
        → createResponseNodes (live) | createResponseNodesViaFile (fallback)
```

## Action colors

1=red, 2=orange, 3=yellow, 4=green, 5=cyan, 6=purple.
Per-action colors (from the original whiteboard): research=4, critique=1, adversarial=1,
decompose=2, question=6, evidence=4, analogy=3, implication=5, synthesize=5.

## Dev iteration

- Obsidian skips **symlinked** plugin folders in its directory scan, so the vault
  plugin dir must be a REAL directory. esbuild writes there via a gitignored
  `.install-path` file (one line = absolute vault plugin dir); each build also copies
  `manifest.json`, `styles.css`, `prompts/`, `.hotreload`.
- `npm run dev` = esbuild **watch** (auto-rebuild on TS change) + the install copy.
- Install `hot-reload` (pjeby) in the vault; `.hotreload` marker is copied too.
- Edit TS → `npm run dev` rebuilds → hot-reload reloads (~750ms). Edit a prompt →
  `npm run build` (or just re-run the action after a build) — no Obsidian reload.
- `.install-path` is gitignored (vault path stays out of the repo).

## Target vault

`~/Obsidian/Duminda` (Linux) / `E:\Obsidian\Duminda` (Windows). Vault path is derived at
runtime from `app.vault.adapter.basePath` — never hardcoded.

## v1 scope

9 actions + ask + search + split + new exploration + abort. **Deferred to v1.1:**
sequences (deep-dive, challenge, explore, investigate) — multi-prompt chains.
