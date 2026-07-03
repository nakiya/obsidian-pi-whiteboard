import { App, ItemView, Modal, Notice, Plugin, TFile } from "obsidian";
import { readFileSync } from "fs";
import { ACTIONS, findAction, type ActionDef } from "./actions";
import {
    PiWhiteboardSettings,
    DEFAULT_SETTINGS,
    PiWhiteboardSettingTab,
    getActivePromptsDir,
} from "./settings";
import { PiSession } from "./pi-session";
import {
    getSelectionContext,
    getSelectedNodes,
    getActiveCanvas,
    getCanvasAbsolutePath,
    getCanvasFilePath,
    getNodeContext,
    getMultiNodeContext,
    createResponseNodes,
    createResponseNodesViaFile,
    parseMultiple,
} from "./canvas-bridge";

export default class PiWhiteboardPlugin extends Plugin {
    settings: PiWhiteboardSettings = DEFAULT_SETTINGS;
    statusBarEl: HTMLElement | null = null;

    private piSession!: PiSession;
    private systemPrompt = "";
    private lastCanvasPath: string | null = null;

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new PiWhiteboardSettingTab(this.app, this));

        // Status bar
        this.statusBarEl = this.addStatusBarItem();
        this.statusBarEl.addClass("pi-whiteboard-status");
        this.statusBarEl.setText("WB");
        this.statusBarEl.onClickEvent(() => this.abort());

        // Load the system prompt and create the long-lived pi session.
        try {
            this.systemPrompt = await this.loadPrompt("system");
        } catch (err) {
            console.warn("[pi-whiteboard] Could not load system.md:", err);
            this.systemPrompt = "";
        }
        const vaultPath = (this.app.vault.adapter as any).basePath || (this.app.vault.adapter as any).getBasePath?.() || "";
        this.piSession = new PiSession(this.settings, vaultPath, this.systemPrompt);

        this.registerCommands();
    }

    async onunload() {
        this.piSession?.dispose();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // ── Command registration ───────────────────────────────────────

    private registerCommands() {
        for (const action of ACTIONS) {
            this.addCommand({
                id: `pi-whiteboard-${action.id}`,
                name: `${action.name} — ${action.desc}`,
                checkCallback: (checking: boolean) => {
                    if (checking) return this.isCanvasActive();
                    this.runAction(action);
                    return true;
                },
            });
        }

        this.addCommand({
            id: "pi-whiteboard-ask",
            name: "Ask — Type a question, then research it on the selected node",
            checkCallback: (checking: boolean) => {
                if (checking) return this.isCanvasActive();
                this.ask();
                return true;
            },
        });

        this.addCommand({
            id: "pi-whiteboard-search",
            name: "Search — Find and select nodes by text content",
            checkCallback: (checking: boolean) => {
                if (checking) return this.isCanvasActive();
                this.searchNodes();
                return true;
            },
        });

        this.addCommand({
            id: "pi-whiteboard-split",
            name: "Split — Copy a node + its descendants into a new canvas",
            checkCallback: (checking: boolean) => {
                if (checking) return this.isCanvasActive();
                this.splitNode();
                return true;
            },
        });

        this.addCommand({
            id: "pi-whiteboard-new",
            name: "New Exploration — Create a fresh canvas with a root node",
            callback: () => this.newExploration(),
        });

        this.addCommand({
            id: "pi-whiteboard-abort",
            name: "Abort — Cancel the running action",
            callback: () => this.abort(),
        });
    }

    // ── Core action loop ───────────────────────────────────────────

    private async runAction(action: ActionDef, seed?: string) {
        const sel = getSelectedNodes(this.app);
        const sourceNodeIds = sel.map((n) => n.id);
        if (sourceNodeIds.length === 0) {
            new Notice("Select a canvas node first");
            return;
        }

        const canvasPath = getCanvasAbsolutePath(this.app);
        if (!canvasPath) {
            new Notice("Could not determine canvas file path");
            return;
        }

        // Canvas-keyed memory: reset the pi session when the active canvas changes.
        if (canvasPath !== this.lastCanvasPath) {
            if (this.lastCanvasPath !== null) this.piSession.resetForCanvas();
            this.lastCanvasPath = canvasPath;
        }
        // Pick up setting changes (restarts pi only if spawn-affecting fields changed).
        this.piSession.updateSettings(this.settings, this.systemPrompt);

        const context = getSelectionContext(this.app);
        const prompt = this.buildActionPrompt(action.id, context, sourceNodeIds, seed);
        if (!prompt) {
            new Notice("Could not build prompt (is the action prompt file present?)");
            return;
        }

        this.setWorking(true, action.name);
        const notice = new Notice(`${action.name}…`, 0);

        let result: string;
        try {
            result = await this.piSession.sendPrompt(prompt, (t) => console.debug("[pi-whiteboard] delta:", t));
        } catch (err: any) {
            notice.hide();
            this.setWorking(false);
            new Notice(`Error: ${err?.message ?? err}`, 8000);
            return;
        }

        notice.hide();
        this.setWorking(false);

        if (!result || !result.trim()) {
            new Notice(`${action.name} returned an empty response`, 6000);
            return;
        }

        // Parse into one or more node contents.
        const contents = action.createsMultiple ? parseMultiple(result) : [result];
        if (contents.length === 0) {
            new Notice(`${action.name} produced no parseable content`, 6000);
            return;
        }

        const opts = {
            nodeWidth: this.settings.nodeWidth,
            nodeHeight: this.settings.nodeHeight,
            color: action.color,
            edgeLabel: action.id,
        };

        // Live API first; fall back to direct file write if the canvas isn't active.
        let created = createResponseNodes(this.app, contents, sourceNodeIds, opts);
        if (created.length === 0) {
            created = await createResponseNodesViaFile(this.app, contents, sourceNodeIds, opts);
        }

        if (created.length === 0) {
            new Notice(`${action.name} completed but failed to write node(s)`, 8000);
            console.error("[pi-whiteboard] response text:", result);
            return;
        }

        new Notice(`${action.name} complete — ${created.length} node(s) added`, 3000);
    }

    private async ask() {
        const sel = getSelectedNodes(this.app);
        if (sel.length === 0) {
            new Notice("Select a canvas node first");
            return;
        }
        const question = await this.promptForText("Ask", "Your question about this node:");
        if (!question) return;
        const research = findAction("research");
        if (!research) return;
        this.runAction(research, question);
    }

    // ── Prompt building (whiteboard-style context) ─────────────────

    private buildActionPrompt(
        actionId: string,
        context: ReturnType<typeof getSelectionContext>,
        sourceNodeIds: string[],
        seed?: string,
    ): string {
        let template: string;
        try {
            // template is loaded fresh per action so prompt tweaks need no reload
            template = this.loadPromptSync(actionId);
        } catch {
            return "";
        }

        const contextSection = this.buildContextSection(context, sourceNodeIds);
        const seedSection = seed ? `\n\n## User's Specific Question or Angle\n\n${seed}` : "";
        return `${contextSection}\n\n---\n\n${template}${seedSection}`;
    }

    private buildContextSection(
        context: ReturnType<typeof getSelectionContext>,
        sourceNodeIds: string[],
    ): string {
        if (context.type === "text-selection") {
            const ctx = getNodeContext(this.app, context.sourceNodeId);
            const parts: string[] = [];
            if (ctx.breadcrumb.length > 1) {
                parts.push("## Exploration Path", ctx.breadcrumb.map((t) => `"${t}"`).join(" -> "));
            }
            parts.push("## Current Node", ctx.nodeText || "(empty)");
            parts.push("## Selected Passage", context.text);
            if (ctx.siblings.length > 0) {
                parts.push("## Already Explored (siblings)", ctx.siblings.map((s) => `- ${s}`).join("\n"));
            }
            parts.push("## Children of Current Node", ctx.children.length > 0 ? ctx.children.map((c) => `- ${c}`).join("\n") : "(none yet)");
            return parts.join("\n\n");
        }

        if (context.type === "nodes") {
            if (context.nodes.length === 1) {
                const ctx = getNodeContext(this.app, context.nodes[0].id);
                const parts: string[] = [];
                if (ctx.breadcrumb.length > 1) {
                    parts.push("## Exploration Path", ctx.breadcrumb.map((t) => `"${t}"`).join(" -> "));
                }
                parts.push("## Current Node", ctx.nodeText || "(empty)");
                if (ctx.siblings.length > 0) {
                    parts.push("## Already Explored (siblings)", ctx.siblings.map((s) => `- ${s}`).join("\n"));
                }
                parts.push("## Children of Current Node", ctx.children.length > 0 ? ctx.children.map((c) => `- ${c}`).join("\n") : "(none yet)");
                return parts.join("\n\n");
            }
            // Multi-node
            const multi = getMultiNodeContext(this.app, sourceNodeIds);
            const parts: string[] = [`## Selected Nodes (${multi.nodes.length})`, ""];
            multi.nodes.forEach((n, i) => {
                parts.push(`### Node ${i + 1}: ${n.title}`);
                if (n.breadcrumb.length > 1) {
                    parts.push(`**Path:** ${n.breadcrumb.map((t) => `"${t}"`).join(" -> ")}`);
                }
                parts.push(n.content || "(empty)");
                if (n.children.length > 0) {
                    parts.push(`**Children:**\n${n.children.map((c) => `- ${c}`).join("\n")}`);
                }
                parts.push("");
            });
            return parts.join("\n").trim();
        }

        // No selection — minimal context.
        return "## Current Node\n(none selected)";
    }

    // ── Prompt file loading ────────────────────────────────────────

    private async loadPrompt(name: string): Promise<string> {
        const dir = getActivePromptsDir(this.settings);
        if (dir) return readFileSync(`${dir}/${name}.md`, "utf-8");
        return this.app.vault.adapter.read(`${this.manifest.dir}/prompts/${name}.md`);
    }

    private loadPromptSync(name: string): string {
        const dir = getActivePromptsDir(this.settings);
        if (dir) return readFileSync(`${dir}/${name}.md`, "utf-8");
        // Synchronous read through the adapter is unavailable; fall back to a
        // cached read via Node fs against the vault path.
        const basePath = (this.app.vault.adapter as any).basePath || (this.app.vault.adapter as any).getBasePath?.() || "";
        const sep = process.platform === "win32" ? "\\" : "/";
        return readFileSync(`${basePath}${sep}${this.manifest.dir}${sep}prompts${sep}${name}.md`, "utf-8");
    }

    // ── Canvas helpers ─────────────────────────────────────────────

    private isCanvasActive(): boolean {
        const view = this.app.workspace.getActiveViewOfType(ItemView);
        return view?.getViewType() === "canvas";
    }

    private async searchNodes() {
        const query = await this.promptForText("Search Canvas", "Search text:");
        if (!query) return;
        const canvas = getActiveCanvas(this.app);
        if (!canvas) return;

        const lower = query.toLowerCase();
        const matches: any[] = [];
        canvas.nodes.forEach((node: any) => {
            const text = (node.text || node.filePath || "").toLowerCase();
            if (text.includes(lower)) matches.push(node);
        });

        if (matches.length === 0) {
            new Notice(`No matches for "${query}"`);
            return;
        }
        canvas.deselectAll();
        for (const node of matches) canvas.select(node);
        canvas.zoomToSelection();
        new Notice(`${matches.length} match(es) for "${query}"`);
    }

    private async splitNode() {
        const sel = getSelectedNodes(this.app);
        if (sel.length === 0) {
            new Notice("Select a canvas node first");
            return;
        }
        const relPath = getCanvasFilePath(this.app);
        if (!relPath) {
            new Notice("Could not determine canvas file path");
            return;
        }

        const notice = new Notice("Extracting subtree…", 0);
        try {
            const raw = await this.app.vault.adapter.read(relPath);
            const data: { nodes: any[]; edges: any[] } = JSON.parse(raw);
            const rootId = sel[0].id;

            // BFS descendants (inclusive of root) following forward edges.
            const include = new Set<string>([rootId]);
            const queue = [rootId];
            while (queue.length > 0) {
                const cur = queue.shift()!;
                for (const e of data.edges) {
                    if (String(e.fromNode) === cur && !include.has(String(e.toNode))) {
                        include.add(String(e.toNode));
                        queue.push(String(e.toNode));
                    }
                }
            }

            const subNodes = data.nodes.filter((n) => include.has(String(n.id)));
            const subEdges = data.edges.filter((e) => include.has(String(e.fromNode)) && include.has(String(e.toNode)));

            // Reposition so the root sits at (0,0), preserving relative layout.
            const root = subNodes.find((n) => String(n.id) === rootId);
            const ox = root?.x ?? 0;
            const oy = root?.y ?? 0;
            const movedNodes = subNodes.map((n) => ({ ...n, x: (n.x ?? 0) - ox, y: (n.y ?? 0) - oy }));

            const newName = this.uniqueName(`${sel[0].title || "split"}.canvas`);
            await this.app.vault.create(newName, JSON.stringify({ nodes: movedNodes, edges: subEdges }, null, "\t"));
            await this.app.workspace.openLinkText(newName, "", true);
            notice.hide();
            new Notice(`Subtree copied to ${newName}`, 4000);
        } catch (err: any) {
            notice.hide();
            new Notice(`Split failed: ${err?.message ?? err}`, 8000);
        }
    }

    private async newExploration() {
        const topic = await this.promptForText("New Exploration", "Topic name:");
        if (!topic) return;

        const name = this.uniqueName(`${this.sanitize(topic)}.canvas`);
        const root = {
            id: this.randomHex(16),
            type: "text",
            text: `# ${topic}`,
            x: 0,
            y: 0,
            width: this.settings.nodeWidth,
            height: this.settings.nodeHeight,
        };
        try {
            await this.app.vault.create(name, JSON.stringify({ nodes: [root], edges: [] }, null, "\t"));
            await this.app.workspace.openLinkText(name, "", true);
            new Notice(`Exploration created: ${topic}`, 3000);
        } catch (err: any) {
            new Notice(`Failed to create canvas: ${err?.message ?? err}`, 8000);
        }
    }

    private uniqueName(base: string): string {
        let path = base;
        let i = 1;
        while (this.app.vault.getAbstractFileByPath(path)) {
            const dot = base.lastIndexOf(".");
            path = dot > 0 ? `${base.slice(0, dot)}-${i}${base.slice(dot)}` : `${base}-${i}`;
            i++;
        }
        return path;
    }

    private sanitize(s: string): string {
        return s.replace(/[\\/:*?"<>|]/g, "_").trim() || "exploration";
    }

    private randomHex(len: number): string {
        const chars = "0123456789abcdef";
        let id = "";
        for (let i = 0; i < len; i++) id += chars[Math.floor(Math.random() * chars.length)];
        return id;
    }

    // ── Abort / status / modal ─────────────────────────────────────

    private abort() {
        this.piSession?.abort();
        this.setWorking(false);
        new Notice("Pi Whiteboard: aborted", 2000);
    }

    private setWorking(working: boolean, label?: string) {
        if (!this.statusBarEl) return;
        if (working) {
            this.statusBarEl.setText(label ? `WB: ${label}…` : "WB: working…");
            this.statusBarEl.addClass("pi-whiteboard-working");
        } else {
            this.statusBarEl.setText("WB");
            this.statusBarEl.removeClass("pi-whiteboard-working");
        }
    }

    private promptForText(title: string, placeholder: string): Promise<string | null> {
        return new Promise((resolve) => {
            const modal = new TextInputModal(this.app, title, placeholder, resolve);
            modal.open();
        });
    }
}

class TextInputModal extends Modal {
    private title: string;
    private resolve: (value: string | null) => void;
    private value = "";
    private resolved = false;

    constructor(app: App, title: string, _placeholder: string, resolve: (value: string | null) => void) {
        super(app);
        this.title = title;
        this.resolve = resolve;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: this.title });

        const input = contentEl.createEl("input", {
            type: "text",
            placeholder: "Type here…",
            cls: "pi-whiteboard-modal-input",
        });

        input.addEventListener("input", () => {
            this.value = input.value;
        });
        input.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter") {
                e.preventDefault();
                this.finish(this.value.trim() || null);
            }
        });

        const btnContainer = contentEl.createDiv({ cls: "pi-whiteboard-modal-buttons" });
        const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });
        cancelBtn.addEventListener("click", () => this.finish(null));
        const goBtn = btnContainer.createEl("button", { text: "Go", cls: "mod-cta" });
        goBtn.addEventListener("click", () => this.finish(this.value.trim() || null));

        setTimeout(() => input.focus(), 50);
    }

    private finish(val: string | null) {
        if (this.resolved) return;
        this.resolved = true;
        this.resolve(val);
        this.close();
    }

    onClose() {
        this.contentEl.empty();
        if (!this.resolved) {
            this.resolved = true;
            this.resolve(null);
        }
    }
}
