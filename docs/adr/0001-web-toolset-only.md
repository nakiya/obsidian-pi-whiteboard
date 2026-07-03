# ADR-0001: Agent toolset restricted to web tools only (web_search + web_fetch), session-wide

**Date:** 2026-07-03
**Status:** Accepted

## Context

The agent that powers pi-whiteboard runs on the user's machine via `pi --mode rpc` and
acts on an Obsidian canvas. Its job is to *research and reason about* topics the user
selects — never to modify files. The original whiteboard plugin achieved this with a
Python CLI that called Claude with a tightly scoped tool list (`WebSearch`/`WebFetch`)
per action.

When porting to pi, two facts shaped the decision:

1. **pi's toolset is fixed at session creation.** There is no `set_tools` RPC command;
   tools are chosen at process spawn and stay fixed for the life of the session. This is
   why the toolset is "session-wide" rather than per-action.
2. **`web_search` is not a built-in pi tool.** pi's built-ins are `read, bash, edit, write,
   grep, find, ls` — all filesystem-touching. A casual reader might assume per-action tool
   swapping is possible, or that web_search comes free. Neither is true.

## Decision

Restrict the agent to **web tools only** — `web_search` and `web_fetch` — for the entire
session, by spawning pi with:

```
pi --mode rpc --no-session --no-builtin-tools --tools web_search,web_fetch
```

- `--no-builtin-tools` disables all built-in filesystem tools (`read`, `bash`, `edit`,
  `write`, `grep`, `find`, `ls`).
- `--tools web_search,web_fetch` allowlists only the two web tools.

The `web_search`/`web_fetch` tools are provided by the
[`@counterposition/pi-web-search`](https://github.com/counterposition/pi/tree/main/packages/pi-web-search)
package (already installed globally via `pi install`), backed by Tavily via the
`TAVILY_API_KEY` environment variable. No custom tool is written by this plugin.

## Consequences

### Positive

- **The filesystem is untouchable by the agent.** It cannot read vault contents, edit
  files, or run shell commands. The only path to canvas writes is the plugin's own code,
  via the live canvas API (with a JSON file-write fallback for inactive canvases).
- **No per-action tool wiring needed.** Since the whole palette is research-oriented,
  a single web-only toolset serves every action. Prompts govern whether a given action
  actually searches (e.g. `critique` doesn't need web search; `research` does).
- **Zero custom tool code to maintain.** Reusing the existing pi-web-search package
  removes what would have been a Tavily-backed `defineTool` extension file.

### Negative

- **Toolset cannot be swapped per action.** An action that wanted a different toolset
  would require a separate session (and lose canvas memory). This is acceptable: every
  action's tool needs are a subset of {web_search, web_fetch}.
- **Depends on a globally-installed pi package.** If the user removes
  `@counterposition/pi-web-search`, the agent loses web access (it would error on the
  first search). The plugin cannot detect this at spawn time — only at first tool call.
  Mitigation: the error message from the tool surfaces clearly in the response.
- **Tavily key resolution.** The `@counterposition/pi-web-search` package reads
  `TAVILY_API_KEY` from the environment first, then from `~/.pi/agent/settings.json`
  under `webSearch.apiKeys.TAVILY_API_KEY`. The plugin stores nothing itself; for
  GUI-launched Obsidian (where shell env vars are absent), the key should live in pi's
  settings file so `web_search` keeps working.

## Deviation from the original design note

The handoff specified "web_search ONLY". This ADR records a refinement to **web_search
+ web_fetch**, because `web_fetch` (reading a fetched page) is a natural companion to
searching and stays within the spirit of "research only, no filesystem access". Both
tools operate on the open web; neither can touch local files.

## Notes

- pi's own prompt is extended by the web-search package with an "untrusted web content"
  warning automatically (via its `before_agent_start` hook), so we don't add it ourselves.
- Session persistence is disabled (`--no-session`) because canvas-keyed memory is managed
  by sending `new_session` RPC commands when the active canvas changes; ephemeral sessions
  avoid littering the vault with session files.
