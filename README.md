# Pi Whiteboard

AI-assisted research on Obsidian Canvas, powered by [pi](https://github.com/earendil-works/pi-coding-agent) in RPC mode.

Select a canvas node, run a command, and a researched answer appears as a new connected
node. A limited palette of actions — research, critique, decompose, and more — each with
its own prompt and node color.

This is a port of two earlier `claude`-backed plugins (`whiteboard` and `claude-canvas`,
both in the `obsidian-tools` monorepo) onto a `pi` backend, with the Python CLI dropped in
favour of all-TypeScript in-process plumbing.

## How it works

- A single long-lived `pi --mode rpc` process runs per plugin session. Switching the
  active canvas sends `new_session`, so each canvas gets its own conversation thread.
- The agent's toolset is locked to **`web_search` + `web_fetch`** only — no filesystem
  access (see [`docs/adr/0001-web-toolset-only.md`](docs/adr/0001-web-toolset-only.md)).
  Web search is backed by Tavily via the `TAVILY_API_KEY` environment variable, provided
  by the `@counterposition/pi-web-search` package.
- Prompts live as loose `.md` files in `prompts/`, read fresh per action — tweak a prompt
  and re-run, no reload needed.
- Answers are written to the canvas via the live canvas API, with a JSON file-write
  fallback when the canvas isn't active. Multi-node actions (decompose, question,
  implication) split their output into multiple connected child nodes.

## Commands

- **9 actions** — Research, Critique, Adversarial, Decompose, Question, Evidence, Analogy,
  Implication, Synthesize.
- **Ask** — type a free-form question, researched against the selected node.
- **Search** — find/select canvas nodes by text.
- **Split** — copy a node + its descendants into a new canvas.
- **New Exploration** — create a fresh canvas with a root node.
- **Abort** — cancel the running action (also bound to the status bar item).

## Development

### Prerequisites

- `pi` on PATH (or set its path in settings). v0.79+.
- The `@counterposition/pi-web-search` package installed for pi: `pi install npm:@counterposition/pi-web-search`.
- `TAVILY_API_KEY` available to pi — either as an environment variable, or (more
  robust, survives GUI-launched Obsidian) stored in `~/.pi/agent/settings.json` under
  `webSearch.apiKeys.TAVILY_API_KEY`. The plugin never handles the key itself; the
  `@counterposition/pi-web-search` package reads it from either location.
- Obsidian with the [hot-reload](https://github.com/pjeby/hot-reload) plugin for fast iteration.

### Build

```bash
npm install
npm run dev      # esbuild watch → main.js
# or
npm run build    # one-shot production build
```

The recommended dev setup is to symlink the vault plugin dir to this source dir so
`manifest.json`, `main.js`, `styles.css`, and `.hotreload` all live in source:

```bash
ln -s /path/to/pi-whiteboard ~/Obsidian/<vault>/.obsidian/plugins/pi-whiteboard
```

Then toggle the plugin on in Obsidian. With hot-reload installed, editing TS rebuilds
`main.js` and the plugin reloads in ~750ms.

### Iteration loop

- Edit TS → `npm run dev` rebuilds → hot-reload reloads the plugin.
- Edit a prompt `.md` → re-run the action; no reload.
