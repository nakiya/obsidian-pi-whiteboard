# CONTEXT — pi-whiteboard

A glossary of the domain language used in this project. Keep it light; add terms as the
implementation crystallises them.

## Terms

- **Action** — One of the nine research operations in the fixed palette (`research`,
  `critique`, `adversarial`, `decompose`, `question`, `evidence`, `analogy`,
  `implication`, `synthesize`). Each action has a prompt template (`prompts/<id>.md`),
  a canvas node color, and a flag for whether it produces multiple nodes. Actions are
  fire-and-forget: trigger → status bar shows "researching…" → result node(s) appear
  connected to the source.

- **Sequence** *(deferred to v1.1)* — A multi-prompt chain of actions (e.g.
  `deep-dive` = decompose → research → critique → synthesize). Not in v1.

- **Canvas session** — The pi RPC conversation scoped to one canvas. Implemented as a
  single long-lived `pi --mode rpc` process; switching the active canvas sends a
  `new_session` RPC command so each canvas gets a fresh thread while repeated actions on
  the same canvas build a coherent multi-turn context.

- **Source node** — The canvas node(s) selected when an action is triggered. Result nodes
  are connected back to each source node via edges labelled with the action id.

- **Web toolset** — The only tools the agent may use: `web_search` and `web_fetch`. All
  built-in filesystem tools are disabled. See ADR-0001.

## Architecture map

| File | Role |
|------|------|
| `src/main.ts` | Plugin entry: command registration, action loop, prompt building, status bar. |
| `src/canvas-bridge.ts` | Canvas reads (selection, graph context) and writes (live API + file fallback), multi-node parsing. |
| `src/pi-session.ts` | Long-lived `pi --mode rpc` client; JSONL event handling; canvas-keyed memory. |
| `src/actions.ts` | The action registry (palette). |
| `src/settings.ts` | Settings tab + per-platform path resolution. |
| `prompts/*.md` | Prompt templates + `system.md`, read fresh per action. |

## Pipeline

```
command → getSelectionContext → buildContextSection (whiteboard style) + prompt template
        → piSession.sendPrompt → parseMultiple (if createsMultiple)
        → createResponseNodes (live) | createResponseNodesViaFile (fallback)
```

## Upstream constraints

- The `web_search`/`web_fetch` tools come from the globally-installed
  `@counterposition/pi-web-search` package (loaded by pi via its `packages` setting).
- Toolset is fixed at spawn (`--no-builtin-tools --tools web_search,web_fetch`); there is
  no `set_tools` RPC command.
