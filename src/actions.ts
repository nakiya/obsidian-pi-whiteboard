/**
 * Action registry — the limited palette of research actions.
 *
 * `color` is the Obsidian canvas node color index (1=red, 2=orange, 3=yellow,
 * 4=green, 5=cyan, 6=purple), preserved from the original whiteboard plugin so
 * canvases stay visually consistent.
 *
 * `createsMultiple` marks actions whose response is a list of `##`-headed
 * sections that should each become their own connected child node.
 */
export interface ActionDef {
    id: string;
    name: string;
    desc: string;
    color: number;
    createsMultiple: boolean;
}

export const ACTIONS: ActionDef[] = [
    { id: "research",    name: "Research",    desc: "Deep factual analysis with web sources",        color: 4, createsMultiple: false },
    { id: "critique",    name: "Critique",    desc: "Balanced critical analysis",                    color: 1, createsMultiple: false },
    { id: "adversarial", name: "Adversarial", desc: "Steel-man the opposing view",                   color: 1, createsMultiple: false },
    { id: "decompose",   name: "Decompose",   desc: "Break into sub-components",                     color: 2, createsMultiple: true  },
    { id: "question",    name: "Question",    desc: "Generate probing questions",                    color: 6, createsMultiple: true  },
    { id: "evidence",    name: "Evidence",    desc: "Arguments for and against",                     color: 4, createsMultiple: false },
    { id: "analogy",     name: "Analogy",     desc: "Find parallels in other domains",               color: 3, createsMultiple: false },
    { id: "implication", name: "Implication", desc: "Second/third-order consequences",               color: 5, createsMultiple: true  },
    { id: "synthesize",  name: "Synthesize",  desc: "Distill children into insight",                 color: 5, createsMultiple: false },
];

export function findAction(id: string): ActionDef | undefined {
    return ACTIONS.find((a) => a.id === id);
}
