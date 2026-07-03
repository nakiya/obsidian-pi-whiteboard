import { App } from "obsidian";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CanvasNodeInfo {
    id: string;
    title: string;
    content: string;
    position: { x: number; y: number };
}

export type SelectionContext =
    | { type: "text-selection"; text: string; sourceNodeId: string; sourceNodeTitle: string }
    | { type: "nodes"; nodes: CanvasNodeInfo[] }
    | { type: "none" };

/**
 * Whiteboard-style context for a single node, matching the placeholders the
 * seeded prompts expect ("Current Node", "Already Explored", "Children of
 * Current Node").
 */
export interface NodeContext {
    nodeTitle: string;
    nodeText: string;
    breadcrumb: string[];   // root-first titles, INCLUDING the node itself
    siblings: string[];     // titles of sibling nodes (same parent)
    children: string[];     // titles of direct children
}

export interface MultiNodeContext {
    nodes: Array<{ title: string; content: string; breadcrumb: string[]; children: string[] }>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract a human-readable title from the first line of a node's text. */
function extractTitle(text: string): string {
    const firstLine = text.split("\n")[0] ?? "";
    const stripped = firstLine.replace(/^#+\s*/, "").trim();
    if (stripped.length === 0) return "Untitled Node";
    if (stripped.length > 60) return stripped.slice(0, 60) + "\u2026";
    return stripped;
}

/** Safely read the text content of a canvas node. */
function readNodeText(node: any): string {
    try {
        if (typeof node.text === "string") return node.text;
        if (typeof node.filePath === "string") return `![[${node.filePath}]]`;
        return "";
    } catch {
        return "";
    }
}

function emptyNodeContext(title: string): NodeContext {
    return { nodeTitle: title, nodeText: "", breadcrumb: [title], siblings: [], children: [] };
}

// ---------------------------------------------------------------------------
// Public API — canvas reads
// ---------------------------------------------------------------------------

/** Get the active canvas object, or null. */
export function getActiveCanvas(app: App): any | null {
    try {
        const leaves = app.workspace.getLeavesOfType("canvas");
        if (leaves.length === 0) return null;

        const activeLeaf = app.workspace.activeLeaf;
        const canvasLeaf = activeLeaf && (activeLeaf.view as any)?.canvas ? activeLeaf : leaves[0];
        const canvas = (canvasLeaf?.view as any)?.canvas;
        if (!canvas) return null;

        if (typeof canvas.selection === "undefined" || typeof canvas.nodes === "undefined") {
            console.warn("[pi-whiteboard] Canvas object missing expected properties.");
            return null;
        }
        return canvas;
    } catch (err) {
        console.warn("[pi-whiteboard] Failed to get active canvas:", err);
        return null;
    }
}

/** Read the currently-selected canvas nodes. */
export function getSelectedNodes(app: App): CanvasNodeInfo[] {
    try {
        const canvas = getActiveCanvas(app);
        if (!canvas) return [];

        const selection: Set<any> | any = canvas.selection;
        if (!selection || typeof selection[Symbol.iterator] !== "function") return [];

        const results: CanvasNodeInfo[] = [];
        for (const node of selection) {
            try {
                const text = readNodeText(node);
                results.push({
                    id: String(node.id ?? ""),
                    title: extractTitle(text),
                    content: text,
                    position: {
                        x: typeof node.x === "number" ? node.x : 0,
                        y: typeof node.y === "number" ? node.y : 0,
                    },
                });
            } catch (nodeErr) {
                console.warn("[pi-whiteboard] Failed to read selected node:", nodeErr);
            }
        }
        return results;
    } catch (err) {
        console.warn("[pi-whiteboard] Failed to get selected nodes:", err);
        return [];
    }
}

/** In-node text selection, or null. */
export function getInNodeTextSelection(
    app: App,
): { text: string; nodeId: string; nodeTitle: string } | null {
    try {
        const canvas = getActiveCanvas(app);
        if (!canvas) return null;

        const activeNode: any = (canvas as any).currentEditingNode ?? (canvas as any).activeNode ?? null;
        if (!activeNode) return null;

        const editor: any = activeNode.child?.editor;
        if (!editor) return null;

        const selectedText: string | undefined = editor.getSelection?.();
        if (!selectedText || selectedText.trim().length === 0) return null;

        return {
            text: selectedText,
            nodeId: String(activeNode.id ?? ""),
            nodeTitle: extractTitle(readNodeText(activeNode)),
        };
    } catch (err) {
        console.warn("[pi-whiteboard] Failed to get in-node text selection:", err);
        return null;
    }
}

/** Selection context with priority: in-node text > selected nodes > none. */
export function getSelectionContext(app: App): SelectionContext {
    const textSel = getInNodeTextSelection(app);
    if (textSel) {
        return {
            type: "text-selection",
            text: textSel.text,
            sourceNodeId: textSel.nodeId,
            sourceNodeTitle: textSel.nodeTitle,
        };
    }
    const nodes = getSelectedNodes(app);
    if (nodes.length > 0) return { type: "nodes", nodes };
    return { type: "none" };
}

/** Vault-relative path to the active .canvas file, or null. */
export function getCanvasFilePath(app: App): string | null {
    try {
        const leaves = app.workspace.getLeavesOfType("canvas");
        if (leaves.length === 0) return null;

        const activeLeaf = app.workspace.activeLeaf;
        const canvasLeaf = activeLeaf && (activeLeaf.view as any)?.canvas ? activeLeaf : leaves[0];
        const file = (canvasLeaf?.view as any)?.file;
        if (file && typeof file.path === "string") return file.path as string;
        return null;
    } catch (err) {
        console.warn("[pi-whiteboard] Failed to get canvas file path:", err);
        return null;
    }
}

/** Absolute path to the active .canvas file (vault basePath + relative path). */
export function getCanvasAbsolutePath(app: App): string | null {
    const rel = getCanvasFilePath(app);
    if (!rel) return null;
    const adapter = app.vault.adapter as any;
    const basePath = adapter.basePath || adapter.getBasePath?.() || "";
    const sep = process.platform === "win32" ? "\\" : "/";
    const filePath = process.platform === "win32" ? rel.replace(/\//g, "\\") : rel;
    return basePath + sep + filePath;
}

// ---------------------------------------------------------------------------
// Graph context — whiteboard-style
// ---------------------------------------------------------------------------

interface GraphMaps {
    titleById: Map<string, string>;
    parents: Map<string, string[]>;   // child -> parent ids
    children: Map<string, string[]>;  // parent -> child ids
}

function buildGraphMaps(data: any): GraphMaps {
    const titleById = new Map<string, string>();
    const parents = new Map<string, string[]>();
    const children = new Map<string, string[]>();

    if (Array.isArray(data?.nodes)) {
        for (const n of data.nodes) {
            titleById.set(String(n.id), extractTitle(n.text ?? n.file ?? ""));
        }
    }
    if (Array.isArray(data?.edges)) {
        for (const edge of data.edges) {
            const from = String(edge.fromNode ?? "");
            const to = String(edge.toNode ?? "");
            if (!from || !to) continue;
            if (!parents.has(to)) parents.set(to, []);
            parents.get(to)!.push(from);
            if (!children.has(from)) children.set(from, []);
            children.get(from)!.push(to);
        }
    }
    return { titleById, parents, children };
}

/** Walk parent edges up to a root, returning the breadcrumb (root-first, including the node). */
function breadcrumbFor(nodeId: string, maps: GraphMaps): string[] {
    const path: string[] = [];
    const visited = new Set<string>([nodeId]);
    let current: string | undefined = nodeId;
    const maxDepth = 6;
    let depth = 0;

    while (current && depth < maxDepth) {
        path.unshift(maps.titleById.get(current) ?? "Untitled");
        const parentIds = maps.parents.get(current);
        if (!parentIds || parentIds.length === 0) break;
        const next = parentIds.find((p) => !visited.has(p));
        if (!next) break;
        visited.add(next);
        current = next;
        depth++;
    }
    return path;
}

/** Whiteboard-style context for a single node. */
export function getNodeContext(app: App, nodeId: string): NodeContext {
    try {
        const canvas = getActiveCanvas(app);
        if (!canvas) return emptyNodeContext("Untitled Node");

        const data = canvas.getData();
        if (!data?.nodes) return emptyNodeContext("Untitled Node");

        const maps = buildGraphMaps(data);
        const node = (data.nodes as any[]).find((n) => String(n.id) === nodeId);
        const text = node ? String(node.text ?? node.file ?? "") : "";
        const title = extractTitle(text);

        const breadcrumb = breadcrumbFor(nodeId, maps);

        const parentIds = maps.parents.get(nodeId) ?? [];
        const siblings: string[] = [];
        if (parentIds.length > 0) {
            const sibIds = maps.children.get(parentIds[0]) ?? [];
            for (const sid of sibIds) {
                if (sid !== nodeId) siblings.push(maps.titleById.get(sid) ?? "Untitled");
            }
        }

        const childIds = maps.children.get(nodeId) ?? [];
        const children = childIds.map((cid) => maps.titleById.get(cid) ?? "Untitled");

        return { nodeTitle: title, nodeText: text, breadcrumb, siblings, children };
    } catch (err) {
        console.warn("[pi-whiteboard] getNodeContext failed:", err);
        return emptyNodeContext("Untitled Node");
    }
}

/** Whiteboard-style context across multiple selected nodes (for synthesize, etc.). */
export function getMultiNodeContext(app: App, nodeIds: string[]): MultiNodeContext {
    const nodes: MultiNodeContext["nodes"] = [];
    try {
        const canvas = getActiveCanvas(app);
        if (!canvas) return { nodes };

        const data = canvas.getData();
        if (!data?.nodes) return { nodes };

        const maps = buildGraphMaps(data);
        for (const id of nodeIds) {
            const node = (data.nodes as any[]).find((n) => String(n.id) === id);
            const content = node ? String(node.text ?? node.file ?? "") : "";
            const childIds = maps.children.get(id) ?? [];
            nodes.push({
                title: extractTitle(content),
                content,
                breadcrumb: breadcrumbFor(id, maps),
                children: childIds.map((cid) => maps.titleById.get(cid) ?? "Untitled"),
            });
        }
        return { nodes };
    } catch (err) {
        console.warn("[pi-whiteboard] getMultiNodeContext failed:", err);
        return { nodes };
    }
}

// ---------------------------------------------------------------------------
// Canvas writes
// ---------------------------------------------------------------------------

const NODE_PADDING = 100;
const NODE_VSPACING = 40;

/** Random hex string for canvas node/edge ids. */
function randomHexId(length = 16): string {
    const chars = "0123456789abcdef";
    let id = "";
    for (let i = 0; i < length; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

/**
 * Compute stacked positions to the right of the rightmost source node.
 * Returns one {x,y} per content item, laid out vertically and centered on the
 * source nodes' average Y.
 */
function positionNodes(
    canvas: any,
    sourceNodeIds: string[],
    count: number,
    nodeWidth: number,
    nodeHeight: number,
): Array<{ x: number; y: number }> {
    const positions: Array<{ x: number; y: number }> = [];
    try {
        const sourceNodes: any[] = [];
        for (const id of sourceNodeIds) {
            const node = canvas.nodes.get(id);
            if (node) sourceNodes.push(node);
        }

        let posX: number;
        let centerY: number;
        if (sourceNodes.length === 0) {
            if (typeof canvas.getViewportCenter === "function") {
                const c = canvas.getViewportCenter();
                posX = c?.x ?? 0;
                centerY = c?.y ?? 0;
            } else {
                posX = 0;
                centerY = 0;
            }
        } else {
            let rightmostX = -Infinity;
            let ySum = 0;
            for (const n of sourceNodes) {
                rightmostX = Math.max(rightmostX, (n.x ?? 0) + (n.width ?? 0));
                ySum += n.y ?? 0;
            }
            posX = rightmostX + NODE_PADDING;
            centerY = Math.round(ySum / sourceNodes.length);
        }

        const totalH = count * nodeHeight + (count - 1) * NODE_VSPACING;
        let startY = centerY - Math.round(totalH / 2);
        for (let i = 0; i < count; i++) {
            positions.push({ x: posX, y: startY + i * (nodeHeight + NODE_VSPACING) });
        }
        return positions;
    } catch (err) {
        console.warn("[pi-whiteboard] positionNodes failed:", err);
        for (let i = 0; i < count; i++) positions.push({ x: 0, y: i * (nodeHeight + NODE_VSPACING) });
        return positions;
    }
}

export interface CreateNodesOpts {
    nodeWidth: number;
    nodeHeight: number;
    color: number;        // 1-6
    edgeLabel: string;    // action id, applied to every source->result edge
}

/**
 * Create response nodes on the ACTIVE canvas (live API) and connect each to all
 * source nodes. Returns the created node ids, or [] on failure.
 */
export function createResponseNodes(
    app: App,
    contents: string[],
    sourceNodeIds: string[],
    opts: CreateNodesOpts,
): string[] {
    try {
        const canvas = getActiveCanvas(app);
        if (!canvas) {
            console.warn("[pi-whiteboard] createResponseNodes: no active canvas");
            return [];
        }

        const positions = positionNodes(canvas, sourceNodeIds, contents.length, opts.nodeWidth, opts.nodeHeight);
        const createdIds: string[] = [];

        for (let i = 0; i < contents.length; i++) {
            const pos = positions[i];
            const newNode = canvas.createTextNode({
                pos: { x: pos.x, y: pos.y },
                size: { width: opts.nodeWidth, height: opts.nodeHeight },
                text: contents[i],
                color: opts.color,
            });
            if (!newNode) {
                console.warn("[pi-whiteboard] createTextNode returned falsy");
                continue;
            }
            // Defensive: ensure color is set on the instance too.
            try {
                newNode.color = opts.color;
            } catch {
                /* read-only */
            }
            createdIds.push(String(newNode.id));
        }

        // Edges via getData/setData (proven pattern from community plugins).
        if (createdIds.length > 0 && sourceNodeIds.length > 0) {
            const data = canvas.getData();
            const existingIds = new Set((data.nodes as any[]).map((n: any) => String(n.id)));
            for (const sourceId of sourceNodeIds) {
                if (!existingIds.has(sourceId)) continue;
                for (const newId of createdIds) {
                    (data.edges as any[]).push({
                        id: randomHexId(16),
                        fromNode: sourceId,
                        fromSide: "right",
                        toNode: newId,
                        toSide: "left",
                        label: opts.edgeLabel,
                        color: opts.color,
                    });
                }
            }
            canvas.setData(data);
        }
        canvas.requestSave();
        return createdIds;
    } catch (err) {
        console.warn("[pi-whiteboard] createResponseNodes failed:", err);
        return [];
    }
}

/**
 * Fallback: write response nodes by editing the .canvas JSON file directly.
 * Used when the canvas is not active (live API unavailable).
 */
export async function createResponseNodesViaFile(
    app: App,
    contents: string[],
    sourceNodeIds: string[],
    opts: CreateNodesOpts,
): Promise<string[]> {
    try {
        const filePath = getCanvasFilePath(app);
        if (!filePath) {
            console.warn("[pi-whiteboard] createResponseNodesViaFile: no canvas file path");
            return [];
        }

        const raw = await app.vault.adapter.read(filePath);
        const data: { nodes: any[]; edges: any[] } = JSON.parse(raw);
        if (!Array.isArray(data.nodes)) data.nodes = [];
        if (!Array.isArray(data.edges)) data.edges = [];

        // Position relative to source nodes found in the JSON.
        const sourceJson = data.nodes.filter((n) => sourceNodeIds.includes(String(n.id)));
        let posX = 0;
        let centerY = 0;
        if (sourceJson.length > 0) {
            let rightmostX = -Infinity;
            let ySum = 0;
            for (const n of sourceJson) {
                rightmostX = Math.max(rightmostX, (n.x ?? 0) + (n.width ?? 0));
                ySum += n.y ?? 0;
            }
            posX = rightmostX + NODE_PADDING;
            centerY = Math.round(ySum / sourceJson.length);
        }

        const totalH = contents.length * opts.nodeHeight + (contents.length - 1) * NODE_VSPACING;
        const startY = centerY - Math.round(totalH / 2);

        const createdIds: string[] = [];
        for (let i = 0; i < contents.length; i++) {
            const id = randomHexId(16);
            data.nodes.push({
                id,
                type: "text",
                text: contents[i],
                x: posX,
                y: startY + i * (opts.nodeHeight + NODE_VSPACING),
                width: opts.nodeWidth,
                height: opts.nodeHeight,
                color: opts.color,
            });
            createdIds.push(id);
        }

        for (const sourceId of sourceNodeIds) {
            if (!data.nodes.some((n) => String(n.id) === sourceId)) continue;
            for (const newId of createdIds) {
                data.edges.push({
                    id: randomHexId(16),
                    fromNode: sourceId,
                    fromSide: "right",
                    toNode: newId,
                    toSide: "left",
                    label: opts.edgeLabel,
                    color: opts.color,
                });
            }
        }

        await app.vault.adapter.write(filePath, JSON.stringify(data, null, "\t"));
        return createdIds;
    } catch (err) {
        console.warn("[pi-whiteboard] createResponseNodesViaFile failed:", err);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Multi-node parsing — ported from whiteboard/cli actions._parse_multiple
// ---------------------------------------------------------------------------

/**
 * Parse an action response into one or more node contents.
 * Tries ## headers, then numbered lists, then falls back to a single node.
 */
export function parseMultiple(text: string): string[] {
    // Split by ## headers
    const sections: string[] = [];
    let current: string[] = [];
    for (const line of text.split("\n")) {
        if (line.startsWith("## ") && current.length > 0) {
            sections.push(current.join("\n").trim());
            current = [line];
        } else {
            current.push(line);
        }
    }
    if (current.length > 0) sections.push(current.join("\n").trim());
    if (sections.length > 1) return sections.filter((s) => s.length > 0);

    // Split by numbered list (1. 2. 3.)
    const items: string[] = [];
    let currentItem: string[] = [];
    let started = false;
    for (const line of text.split("\n")) {
        const stripped = line.trim();
        if (stripped.length > 0 && /^\d+\.\s/.test(stripped.slice(0, 5))) {
            if (started) items.push(currentItem.join("\n").trim());
            currentItem = [stripped.replace(/^\d+\.\s+/, "")];
            started = true;
        } else {
            currentItem.push(line);
        }
    }
    if (started) items.push(currentItem.join("\n").trim());
    if (items.length > 1) return items.filter((s) => s.length > 0);

    return [text.trim()].filter((s) => s.length > 0);
}
