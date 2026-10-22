import { describe, expect, it } from "vitest";
import type { GraphData } from "./api";
import { adjacency, categories, neighbourhood, NO_PROJECT, OTHER, stepTo, titleMatches, visibleNodes, type GraphFilters } from "./graphModel";

const node = (id: string, folder_id: string | null = null, tags: string[] = []) =>
  ({ id, title: id.toUpperCase(), block_count: 1, link_count: 0, folder_id, tags });

// a — b — c — d, e alone, f — a
const data: GraphData = {
  nodes: [node("a", "p1", ["work"]), node("b", "p1"), node("c", "p2", ["idea", "work"]), node("d"), node("e", null, ["work"]), node("f", "p2")],
  edges: [
    { source: "a", target: "b", weight: 1 }, { source: "b", target: "c", weight: 1 },
    { source: "d", target: "c", weight: 2 }, { source: "f", target: "a", weight: 1 },
    { source: "a", target: "a", weight: 1 }, { source: "a", target: "zz", weight: 1 },
  ],
};
const adj = adjacency(data);
const none: GraphFilters = { local: null, project: null, tag: null, orphansOnly: false, hideUnlinked: false };
const ids = (f: Partial<GraphFilters>) => visibleNodes(data, adj, { ...none, ...f }).map((n) => n.id);

describe("graph model", () => {
  it("links are undirected, self and dangling links are dropped", () => {
    expect([...adj.get("a")!].sort()).toEqual(["b", "f"]);
    expect(adj.get("e")!.size).toBe(0);
  });

  it("local graph: depth 1–3 around the current page", () => {
    expect([...neighbourhood(adj, "a", 1).keys()].sort()).toEqual(["a", "b", "f"]);
    expect([...neighbourhood(adj, "a", 2).keys()].sort()).toEqual(["a", "b", "c", "f"]);
    expect(neighbourhood(adj, "a", 3).get("d")).toBe(3);
    expect(ids({ local: { centerId: "e", depth: 2 }, hideUnlinked: true })).toEqual(["e"]);
    expect(neighbourhood(adj, "missing", 2).size).toBe(0);
  });

  it("filters: project, tag, orphans", () => {
    expect(ids({ project: "p2" })).toEqual(["c", "f"]);
    expect(ids({ project: NO_PROJECT })).toEqual(["d", "e"]);
    expect(ids({ tag: "work" })).toEqual(["a", "c", "e"]);
    expect(ids({ orphansOnly: true })).toEqual(["e"]);
    expect(ids({ hideUnlinked: true })).toEqual(["a", "b", "c", "d", "f"]);
  });

  it("title search matches every word, case-insensitive", () => {
    expect(titleMatches("Project Alpha notes", "alpha NOTE")).toBe(true);
    expect(titleMatches("Project Alpha", "beta")).toBe(false);
    expect(titleMatches("Anything", "  ")).toBe(false);
  });

  it("colour categories: most common first, the rest share Other", () => {
    const { list, categoryOf } = categories(data.nodes, "project", (id) => `Project ${id}`);
    expect(list.map((c) => c.label)).toEqual(["Project p1", "Project p2", "No project"]);
    expect(categoryOf.get("d")).toBe(NO_PROJECT);
    const many = Array.from({ length: 10 }, (_, i) => node(`n${i}`, `f${i}`));
    const cats = categories(many, "project", (id) => id);
    expect(cats.list.length).toBe(8);
    expect(cats.list[cats.list.length - 1].key).toBe(OTHER);
    const tags = categories(data.nodes, "tag", (id) => id);
    expect(tags.list[0].label).toBe("#work");
    expect(tags.categoryOf.get("c")).toBe("idea");
  });

  it("arrow keys step to the neighbour in that direction, else the nearest node that way", () => {
    const from = { id: "a", x: 0, y: 0 };
    const nb = [{ id: "b", x: 100, y: 10 }, { id: "f", x: -5, y: -80 }];
    const all = [...nb, { id: "e", x: 0, y: 200 }];
    expect(stepTo(from, "ArrowRight", nb, all)).toBe("b");
    expect(stepTo(from, "ArrowUp", nb, all)).toBe("f");
    expect(stepTo(from, "ArrowDown", nb, all)).toBe("e");
    expect(stepTo(from, "ArrowLeft", nb, all)).toBeNull(); // f is up, not left
    expect(stepTo({ id: "x", x: 0, y: 0 }, "ArrowLeft", [], [{ id: "y", x: 50, y: 0 }])).toBeNull();
  });
});
