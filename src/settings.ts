import { App, Platform, PluginSettingTab, Setting } from "obsidian";
import type PiWhiteboardPlugin from "./main";

/**
 * Plugin settings.
 *
 * `piPath` / `promptsDir` are resolved per-platform so the plugin works on both
 * the Windows and Linux vaults the author uses. `model` / `provider` are
 * optional — when left blank, pi's own defaults (from ~/.pi/agent/settings.json)
 * apply.
 */
export interface PiWhiteboardSettings {
    piPath: string;            // path to the `pi` binary (Windows)
    piPathLinux: string;       // path to the `pi` binary (Linux/macOS)
    promptsDir: string;        // absolute path to prompts/ (Windows) — blank = installed dir
    promptsDirLinux: string;   // absolute path to prompts/ (Linux/macOS) — blank = installed dir
    model: string;             // optional model id, e.g. "anthropic/claude-sonnet-4" — blank = pi default
    provider: string;          // optional provider override — blank = pi default
    nodeWidth: number;
    nodeHeight: number;
}

export const DEFAULT_SETTINGS: PiWhiteboardSettings = {
    piPath: "pi",
    piPathLinux: "/home/dumrat/.local/share/mise/installs/node/25.8.1/bin/pi",
    promptsDir: "",
    promptsDirLinux: "",
    model: "",
    provider: "",
    nodeWidth: 460,
    nodeHeight: 300,
};

/** Return the active pi binary path for the current platform. */
export function getActivePiPath(settings: PiWhiteboardSettings): string {
    const p = Platform.isWin ? settings.piPath : settings.piPathLinux;
    return p && p.trim().length > 0 ? p : "pi";
}

/** Return the configured prompts dir for the current platform, or "" to use the installed plugin dir. */
export function getActivePromptsDir(settings: PiWhiteboardSettings): string {
    return Platform.isWin ? settings.promptsDir : settings.promptsDirLinux;
}

export class PiWhiteboardSettingTab extends PluginSettingTab {
    plugin: PiWhiteboardPlugin;

    constructor(app: App, plugin: PiWhiteboardPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h3", { text: "pi binary" });

        new Setting(containerEl)
            .setName("pi executable (Windows)")
            .setDesc("Path to the pi binary on Windows. Use \"pi\" if it's on PATH.")
            .addText((text) =>
                text
                    .setPlaceholder("pi")
                    .setValue(this.plugin.settings.piPath)
                    .onChange(async (value) => {
                        this.plugin.settings.piPath = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName("pi executable (Linux/macOS)")
            .setDesc("Path to the pi binary on Linux/macOS.")
            .addText((text) =>
                text
                    .setPlaceholder("/usr/local/bin/pi")
                    .setValue(this.plugin.settings.piPathLinux)
                    .onChange(async (value) => {
                        this.plugin.settings.piPathLinux = value;
                        await this.plugin.saveSettings();
                    }),
            );

        containerEl.createEl("h3", { text: "Prompts directory" });

        new Setting(containerEl)
            .setName("Prompts directory (Windows)")
            .setDesc("Absolute path to the prompts/ folder. Leave blank to use the installed plugin's prompts/ folder.")
            .addText((text) =>
                text
                    .setPlaceholder("(installed dir)")
                    .setValue(this.plugin.settings.promptsDir)
                    .onChange(async (value) => {
                        this.plugin.settings.promptsDir = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName("Prompts directory (Linux/macOS)")
            .setDesc("Absolute path to the prompts/ folder. Leave blank to use the installed plugin's prompts/ folder.")
            .addText((text) =>
                text
                    .setPlaceholder("(installed dir)")
                    .setValue(this.plugin.settings.promptsDirLinux)
                    .onChange(async (value) => {
                        this.plugin.settings.promptsDirLinux = value;
                        await this.plugin.saveSettings();
                    }),
            );

        containerEl.createEl("h3", { text: "Model (optional)" });

        new Setting(containerEl)
            .setName("Model")
            .setDesc("Optional model id, e.g. \"anthropic/claude-sonnet-4\". Leave blank to use pi's default.")
            .addText((text) =>
                text
                    .setPlaceholder("(pi default)")
                    .setValue(this.plugin.settings.model)
                    .onChange(async (value) => {
                        this.plugin.settings.model = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName("Provider")
            .setDesc("Optional provider override (anthropic, openrouter, ...). Leave blank for pi default.")
            .addText((text) =>
                text
                    .setPlaceholder("(pi default)")
                    .setValue(this.plugin.settings.provider)
                    .onChange(async (value) => {
                        this.plugin.settings.provider = value;
                        await this.plugin.saveSettings();
                    }),
            );

        containerEl.createEl("h3", { text: "Canvas nodes" });

        new Setting(containerEl)
            .setName("Response node width")
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.nodeWidth))
                    .onChange(async (value) => {
                        const n = parseInt(value, 10);
                        if (!Number.isNaN(n) && n > 0) {
                            this.plugin.settings.nodeWidth = n;
                            await this.plugin.saveSettings();
                        }
                    }),
            );

        new Setting(containerEl)
            .setName("Response node height")
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.nodeHeight))
                    .onChange(async (value) => {
                        const n = parseInt(value, 10);
                        if (!Number.isNaN(n) && n > 0) {
                            this.plugin.settings.nodeHeight = n;
                            await this.plugin.saveSettings();
                        }
                    }),
            );

        const current = Platform.isWin ? "Windows" : Platform.isMacOS ? "macOS" : "Linux";
        containerEl.createEl("p", {
            text: `Current platform: ${current}. Toolset is restricted to web_search + web_fetch (filesystem tools disabled).`,
            cls: "setting-item-description",
        });
    }
}
