import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import process from "process";

const mode = process.argv[2]; // "dev" (watch) | "production" (one-shot) | undefined (one-shot)
const prod = mode === "production";
const watch = mode === "dev";

// Optional dev install target: a gitignored `.install-path` file whose first
// non-empty line is the absolute vault plugin directory. When present, the
// build writes main.js there and copies static assets (manifest, styles,
// prompts, .hotreload) so Obsidian loads the plugin from a REAL directory.
// (Symlinked plugin folders are skipped by Obsidian's directory scan, which
// treats symlink dir entries as non-directories.)
let installDir = null;
try {
    const raw = fs.readFileSync(".install-path", "utf-8").trim().split("\n")[0]?.trim();
    if (raw) installDir = raw;
} catch {
    /* no install target — write ./main.js */
}

const outfile = installDir ? path.join(installDir, "main.js") : "main.js";
const copyFiles = ["manifest.json", "styles.css", ".hotreload"];

// Copy static assets into the install dir after each build.
const installPlugin = {
    name: "pi-whiteboard-install",
    setup(build) {
        build.onEnd((result) => {
            if (!installDir) return;
            if (result?.errors?.length) return;
            for (const f of copyFiles) {
                try {
                    fs.copyFileSync(f, path.join(installDir, f));
                } catch {
                    /* missing static file — skip */
                }
            }
            try {
                fs.cpSync("prompts", path.join(installDir, "prompts"), { recursive: true });
            } catch {
                /* prompts dir missing — skip */
            }
        });
    },
};

const options = {
    entryPoints: ["src/main.ts"],
    bundle: true,
    plugins: [installPlugin],
    external: [
        "obsidian",
        "electron",
        "child_process",
        "fs",
        "path",
        "os",
        "@codemirror/autocomplete",
        "@codemirror/collab",
        "@codemirror/commands",
        "@codemirror/language",
        "@codemirror/lint",
        "@codemirror/search",
        "@codemirror/state",
        "@codemirror/view",
        "@lezer/common",
        "@lezer/highlight",
        "@lezer/lr",
    ],
    format: "cjs",
    target: "es2018",
    logLevel: "info",
    sourcemap: prod ? false : "inline",
    treeShaking: true,
    outfile,
    minify: prod,
};

try {
    if (watch) {
        const ctx = await esbuild.context(options);
        await ctx.watch();
        console.log(
            installDir
                ? `[pi-whiteboard] watching → ${installDir}`
                : "[pi-whiteboard] watching → ./main.js (no .install-path)",
        );
    } else {
        await esbuild.build(options);
    }
} catch {
    process.exit(1);
}
