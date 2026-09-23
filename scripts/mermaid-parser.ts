import { JSDOM } from "jsdom";

type MermaidApi = typeof import("mermaid").default;

let mermaidApi: Promise<MermaidApi> | undefined;
let dom: JSDOM | undefined;

async function getMermaid(): Promise<MermaidApi> {
  if (!mermaidApi) {
    dom = new JSDOM("<!doctype html>", { url: "http://localhost/" });
    const window = dom.window;
    for (const key of [
      "window",
      "document",
      "DOMParser",
      "XMLSerializer",
      "Element",
      "HTMLElement",
      "SVGElement",
      "Node",
      "navigator",
    ] as const) {
      Object.defineProperty(globalThis, key, {
        value: key === "window" ? window : window[key],
        configurable: true,
      });
    }
    Object.defineProperty(globalThis, "getComputedStyle", {
      value: window.getComputedStyle.bind(window),
      configurable: true,
    });
    mermaidApi = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      return mermaid;
    });
  }
  return mermaidApi;
}

/** Parse Mermaid source without rendering, using Mermaid's documented API. */
export async function validateMermaidDiagram(source: string): Promise<void> {
  const mermaid = await getMermaid();
  await mermaid.parse(source);
}

/** Close the DOM after all parser checks when running as a standalone test. */
export function closeMermaidParser(): void {
  dom?.window.close();
  dom = undefined;
  mermaidApi = undefined;
}
