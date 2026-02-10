import { describe, it, expect } from "vitest";
import { parseDot } from "../src/parser/parser.js";
import { buildGraph } from "../src/model/builder.js";

describe("Graph Model Builder", () => {
  it("builds a simple graph with correct node attributes", () => {
    const ast = parseDot(`
      digraph Simple {
        graph [goal="Run tests"]
        start [shape=Mdiamond, label="Start"]
        exit  [shape=Msquare, label="Exit"]
        run   [label="Run Tests", prompt="Run the test suite", max_retries=2]
        start -> run -> exit
      }
    `);
    const graph = buildGraph(ast);

    expect(graph.id).toBe("Simple");
    expect(graph.attrs.goal).toBe("Run tests");
    expect(graph.nodes.size).toBe(3);
    expect(graph.edges.length).toBe(2);

    const run = graph.getNode("run");
    expect(run.label).toBe("Run Tests");
    expect(run.prompt).toBe("Run the test suite");
    expect(run.maxRetries).toBe(2);
    expect(run.shape).toBe("box"); // default
  });

  it("resolves handler types from shapes", () => {
    const ast = parseDot(`
      digraph G {
        s [shape=Mdiamond]
        e [shape=Msquare]
        h [shape=hexagon]
        d [shape=diamond]
        p [shape=component]
        t [shape=parallelogram]
        s -> h -> d -> p -> e
      }
    `);
    const graph = buildGraph(ast);

    expect(graph.resolveHandlerType(graph.getNode("s"))).toBe("start");
    expect(graph.resolveHandlerType(graph.getNode("e"))).toBe("exit");
    expect(graph.resolveHandlerType(graph.getNode("h"))).toBe("wait.human");
    expect(graph.resolveHandlerType(graph.getNode("d"))).toBe("conditional");
    expect(graph.resolveHandlerType(graph.getNode("p"))).toBe("parallel");
    expect(graph.resolveHandlerType(graph.getNode("t"))).toBe("tool");
  });

  it("explicit type overrides shape", () => {
    const ast = parseDot(`
      digraph G {
        a [shape=box, type="wait.human"]
      }
    `);
    const graph = buildGraph(ast);
    expect(graph.resolveHandlerType(graph.getNode("a"))).toBe("wait.human");
  });

  it("finds start and exit nodes", () => {
    const ast = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        start -> exit
      }
    `);
    const graph = buildGraph(ast);

    expect(graph.findStartNode()?.id).toBe("start");
    expect(graph.findExitNode()?.id).toBe("exit");
  });

  it("computes outgoing and incoming edges", () => {
    const ast = parseDot(`
      digraph G {
        a -> b
        a -> c
        b -> c
      }
    `);
    const graph = buildGraph(ast);

    expect(graph.outgoingEdges("a").length).toBe(2);
    expect(graph.incomingEdges("c").length).toBe(2);
    expect(graph.incomingEdges("a").length).toBe(0);
  });

  it("applies node defaults", () => {
    const ast = parseDot(`
      digraph G {
        node [shape=box, timeout=900s]
        a [label="A"]
        b [label="B", timeout=1800s]
      }
    `);
    const graph = buildGraph(ast);

    expect(graph.getNode("a").shape).toBe("box");
    expect(graph.getNode("a").timeout).toBe(900000); // 900s in ms
    expect(graph.getNode("b").timeout).toBe(1800000); // explicit override
  });

  it("applies edge defaults", () => {
    const ast = parseDot(`
      digraph G {
        edge [weight=5]
        a -> b
        a -> c [weight=10]
      }
    `);
    const graph = buildGraph(ast);
    const edges = graph.outgoingEdges("a");
    const ab = edges.find((e) => e.toNode === "b")!;
    const ac = edges.find((e) => e.toNode === "c")!;
    expect(ab.weight).toBe(5);
    expect(ac.weight).toBe(10);
  });

  it("handles subgraph class derivation", () => {
    const ast = parseDot(`
      digraph G {
        subgraph cluster_loop {
          label = "Loop A"
          node [thread_id="loop-a"]
          Plan [label="Plan"]
        }
      }
    `);
    const graph = buildGraph(ast);
    const plan = graph.getNode("Plan");
    expect(plan.classes).toContain("loop-a");
    expect(plan.threadId).toBe("loop-a");
  });

  it("computes reachability", () => {
    const ast = parseDot(`
      digraph G {
        a -> b -> c
        d [label="orphan"]
      }
    `);
    const graph = buildGraph(ast);
    const reachable = graph.reachableFrom("a");
    expect(reachable.has("a")).toBe(true);
    expect(reachable.has("b")).toBe(true);
    expect(reachable.has("c")).toBe(true);
    expect(reachable.has("d")).toBe(false);
  });

  it("expands chained edges into pairs", () => {
    const ast = parseDot(`
      digraph G {
        A -> B -> C -> D [label="next"]
      }
    `);
    const graph = buildGraph(ast);
    expect(graph.edges.length).toBe(3);
    expect(graph.edges[0]!.fromNode).toBe("A");
    expect(graph.edges[0]!.toNode).toBe("B");
    expect(graph.edges[1]!.fromNode).toBe("B");
    expect(graph.edges[1]!.toNode).toBe("C");
    expect(graph.edges[2]!.fromNode).toBe("C");
    expect(graph.edges[2]!.toNode).toBe("D");
    // Each edge gets the chained attributes
    expect(graph.edges[0]!.label).toBe("next");
    expect(graph.edges[2]!.label).toBe("next");
  });

  it("parses graph-level attributes correctly", () => {
    const ast = parseDot(`
      digraph G {
        graph [goal="Build feature", default_max_retry=10, model_stylesheet="* { llm_model: gpt-4; }"]
      }
    `);
    const graph = buildGraph(ast);
    expect(graph.attrs.goal).toBe("Build feature");
    expect(graph.attrs.defaultMaxRetry).toBe(10);
    expect(graph.attrs.modelStylesheet).toBe("* { llm_model: gpt-4; }");
  });

  it("parses class attribute into classes array", () => {
    const ast = parseDot(`
      digraph G {
        a [class="code,critical", shape=box]
      }
    `);
    const graph = buildGraph(ast);
    expect(graph.getNode("a").classes).toEqual(["code", "critical"]);
  });
});
