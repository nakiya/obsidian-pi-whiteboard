import { ChildProcess, spawn } from "child_process";
import type { PiWhiteboardSettings } from "./settings";
import { getActivePiPath } from "./settings";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingRequest {
    resolve: (text: string) => void;
    onToken: (text: string) => void;
    lastAssistantText: string;
    currentText: string;
    currentIsAssistant: boolean;
    responded: boolean;
}

/**
 * Long-lived `pi --mode rpc` client.
 *
 * One process per plugin session. Canvas-keyed memory: call `resetForCanvas()`
 * (sends `new_session`) whenever the active canvas changes so each canvas gets
 * a fresh conversation thread while repeated actions on the SAME canvas build a
 * coherent multi-turn context.
 *
 * Toolset is locked at spawn to web_search + web_fetch only
 * (--no-builtin-tools --tools web_search,web_fetch), so the agent can never
 * touch the filesystem. See docs/adr/0001-web-toolset-only.md.
 */
export class PiSession {
    private settings: PiWhiteboardSettings;
    private vaultPath: string;
    private systemPrompt: string;

    private process: ChildProcess | null = null;
    private stdoutBuffer = "";
    private pending: PendingRequest | null = null;

    constructor(settings: PiWhiteboardSettings, vaultPath: string, systemPrompt: string) {
        this.settings = settings;
        this.vaultPath = vaultPath;
        this.systemPrompt = systemPrompt;
    }

    // ─── Public API ──────────────────────────────────────────────

    /**
     * Send a prompt and resolve with the assistant's final text answer.
     * `onToken` receives streaming text deltas (for console logging / future UI).
     */
    sendPrompt(prompt: string, onToken: (text: string) => void = () => {}): Promise<string> {
        // If a request is already in-flight, abort it first.
        if (this.pending) {
            this.pending.resolve(this.pending.lastAssistantText);
            this.pending = null;
        }

        try {
            this.ensureProcess();
        } catch (err: any) {
            const msg = this.classifyError(err);
            onToken(msg);
            return Promise.resolve(msg);
        }

        if (!this.process || !this.process.stdin) {
            const msg = "Failed to start pi process";
            onToken(msg);
            return Promise.resolve(msg);
        }

        const cmd = JSON.stringify({ type: "prompt", message: prompt });

        return new Promise<string>((resolve) => {
            this.pending = {
                resolve: (text: string) => resolve(text),
                onToken,
                lastAssistantText: "",
                currentText: "",
                currentIsAssistant: false,
                responded: false,
            };

            try {
                this.process!.stdin!.write(cmd + "\n");
            } catch (err: any) {
                this.pending = null;
                const msg = this.classifyError(err);
                onToken(msg);
                resolve(msg);
            }
        });
    }

    /** Reset the conversation for a new canvas (sends `new_session`). */
    resetForCanvas(): void {
        if (!this.process || !this.process.stdin) return;
        try {
            this.process.stdin.write(JSON.stringify({ type: "new_session" }) + "\n");
        } catch (err) {
            console.warn("[pi-whiteboard] new_session failed:", err);
        }
    }

    /** Abort the current run (sends `abort`). */
    abort(): void {
        if (this.pending) {
            const p = this.pending;
            this.pending = null;
            if (!p.responded) {
                p.responded = true;
                p.resolve(p.lastAssistantText || "(aborted)");
            }
        }
        if (this.process && this.process.stdin) {
            try {
                this.process.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
            } catch {
                /* ignore */
            }
        }
    }

    /** Update settings; restarts the process if spawn-affecting fields changed. */
    updateSettings(settings: PiWhiteboardSettings, systemPrompt: string): void {
        const needsRestart =
            settings.model !== this.settings.model ||
            settings.provider !== this.settings.provider ||
            getActivePiPath(settings) !== getActivePiPath(this.settings) ||
            systemPrompt !== this.systemPrompt;

        this.settings = settings;
        this.systemPrompt = systemPrompt;

        if (needsRestart) this.killProcess();
    }

    /** Tear down the process (plugin unload). */
    dispose(): void {
        if (this.pending) {
            const p = this.pending;
            this.pending = null;
            if (!p.responded) {
                p.responded = true;
                p.resolve("(disposed)");
            }
        }
        this.killProcess();
    }

    // ─── Process lifecycle ───────────────────────────────────────

    private ensureProcess(): void {
        if (this.process && !this.process.killed && this.process.exitCode === null) return;

        this.stdoutBuffer = "";
        const piPath = getActivePiPath(this.settings);

        const args = [
            "--mode", "rpc",
            "--no-session",
            "--no-builtin-tools", "--tools", "web_search,web_fetch",
            "--no-context-files", "--no-skills", "--no-prompt-templates",
            "--name", "pi-whiteboard",
        ];
        if (this.systemPrompt) args.push("--system-prompt", this.systemPrompt);
        if (this.settings.provider) args.push("--provider", this.settings.provider);
        if (this.settings.model) args.push("--model", this.settings.model);

        const proc = spawn(piPath, args, {
            cwd: this.vaultPath,
            env: { ...process.env },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        this.process = proc;

        proc.stdout.on("data", (data: Buffer) => {
            this.stdoutBuffer += data.toString("utf-8");
            this.processBuffer();
        });
        proc.stderr.on("data", (data: Buffer) => {
            const text = data.toString("utf-8").trim();
            if (text) console.warn("[pi-whiteboard] pi stderr:", text);
        });
        proc.on("error", (err: Error) => {
            console.error("[pi-whiteboard] Process error:", err);
            this.failPending(this.classifyError(err));
        });
        proc.on("close", (code: number | null) => {
            console.warn(`[pi-whiteboard] pi exited (code ${code})`);
            this.failPending(`pi process exited (code ${code})`);
            this.process = null;
        });
    }

    private killProcess(): void {
        if (this.process && !this.process.killed) {
            try {
                this.process.kill("SIGTERM");
            } catch {
                /* ignore */
            }
        }
        this.process = null;
        this.stdoutBuffer = "";
    }

    private failPending(msg: string): void {
        if (!this.pending || this.pending.responded) return;
        const p = this.pending;
        this.pending = null;
        p.responded = true;
        if (!p.lastAssistantText) {
            p.onToken(msg);
            p.lastAssistantText = msg;
        }
        p.resolve(p.lastAssistantText);
    }

    // ─── JSONL parsing ───────────────────────────────────────────
    // NOTE: do NOT use readline — it splits on U+2028/U+2029 which are valid
    // inside JSON strings. Split on "\n" only and strip a trailing "\r".

    private processBuffer(): void {
        let idx: number;
        while ((idx = this.stdoutBuffer.indexOf("\n")) >= 0) {
            let line = this.stdoutBuffer.slice(0, idx);
            this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                this.handleEvent(JSON.parse(trimmed));
            } catch {
                // Non-JSON line (e.g. stray startup banner) — ignore.
            }
        }
    }

    private handleEvent(event: any): void {
        if (!event || typeof event !== "object") return;

        // Command responses
        if (event.type === "response") {
            if (event.command === "prompt" && event.success === false && this.pending && !this.pending.responded) {
                const err = `pi rejected prompt: ${event.error ?? "unknown error"}`;
                this.failPending(err);
            }
            return;
        }

        if (!this.pending) return;

        switch (event.type) {
            case "message_start": {
                this.pending.currentIsAssistant = event.message?.role === "assistant";
                this.pending.currentText = "";
                break;
            }
            case "message_update": {
                const delta = event.assistantMessageEvent;
                if (delta?.type === "text_delta" && typeof delta.delta === "string") {
                    this.pending.currentText += delta.delta;
                    this.pending.onToken(delta.delta);
                }
                break;
            }
            case "message_end": {
                if (event.message?.role === "assistant") {
                    const text = extractAssistantText(event.message);
                    if (text.length > 0) this.pending.lastAssistantText = text;
                }
                this.pending.currentIsAssistant = false;
                break;
            }
            case "agent_end": {
                // Prefer the per-message capture; fall back to scanning messages.
                let text = this.pending.lastAssistantText;
                if (!text && Array.isArray(event.messages)) {
                    for (let i = event.messages.length - 1; i >= 0; i--) {
                        const t = extractAssistantText(event.messages[i]);
                        if (t) {
                            text = t;
                            break;
                        }
                    }
                }
                const p = this.pending;
                this.pending = null;
                p.responded = true;
                p.resolve(text);
                break;
            }
        }
    }

    // ─── Error classification ────────────────────────────────────

    private classifyError(err: any): string {
        const message: string = err?.message ?? String(err);
        if (message.includes("ENOENT") || message.includes("not found") || message.includes("not recognized")) {
            return "pi binary not found. Set the correct path in Pi Whiteboard settings.";
        }
        if (message.includes("auth") || message.includes("401") || message.includes("API key") || message.includes("Unauthorized")) {
            return "pi authentication failed. Run `pi` in a terminal to authenticate.";
        }
        if (message.includes("ECONNREFUSED") || message.includes("ENOTFOUND") || message.includes("ETIMEDOUT") || message.includes("fetch failed")) {
            return "Failed to reach the LLM provider. Check your internet connection.";
        }
        console.error("[pi-whiteboard] pi error:", err);
        return `Error communicating with pi: ${message}`;
    }
}

/** Extract joined text from an assistant message's content blocks. */
function extractAssistantText(message: any): string {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("");
}
