import { describe, it, expect } from "vitest";
import { Graph, type GraphAttrs, type GraphNode } from "../src/model/graph.js";
import { VariableExpansionTransform } from "../src/transforms/index.js";

/** Helper to create a minimal GraphNode with optional overrides */
function makeNode(
  overrides: Partial<GraphNode> & { attrs?: Record<string, unknown> } = {},
): GraphNode {
  return {
    id: "n1",
    label: "Node",
    shape: "box",
    type: "",
    prompt: "",
    maxRetries: 0,
    goalGate: false,
    retryTarget: "",
    fallbackRetryTarget: "",
    fidelity: "",
    threadId: "",
    classes: [],
    timeout: null,
    llmModel: "",
    llmProvider: "",
    reasoningEffort: "high",
    autoStatus: false,
    allowPartial: false,
    attrs: {},
    ...overrides,
  };
}

/** Helper to create a minimal Graph with vars and a single node */
function makeGraph(
  vars: Array<{ name: string; defaultValue?: string }>,
  node: GraphNode,
): Graph {
  const attrs: GraphAttrs = {
    goal: "",
    label: "",
    modelStylesheet: "",
    defaultMaxRetry: 50,
    retryTarget: "",
    fallbackRetryTarget: "",
    defaultFidelity: "",
    vars,
    varsExplicit: vars.length > 0,
  };
  const nodes = new Map<string, GraphNode>();
  nodes.set(node.id, node);
  return new Graph("test", attrs, nodes, []);
}

describe("VariableExpansionTransform: tool attributes", () => {
  it("$var in tool_command is expanded", () => {
    const node = makeNode({
      attrs: { tool_command: "run $TOOL" },
    });
    const graph = makeGraph(
      [{ name: "TOOL", defaultValue: "mytool" }],
      node,
    );

    const transform = new VariableExpansionTransform();
    transform.apply(graph);

    expect(graph.getNode("n1").attrs["tool_command"]).toBe("run mytool");
  });

  it("$var in pre_hook is expanded", () => {
    const node = makeNode({
      attrs: { pre_hook: "echo $MSG" },
    });
    const graph = makeGraph(
      [{ name: "MSG", defaultValue: "hello_world" }],
      node,
    );

    const transform = new VariableExpansionTransform();
    transform.apply(graph);

    expect(graph.getNode("n1").attrs["pre_hook"]).toBe("echo hello_world");
  });

  it("$var in post_hook is expanded", () => {
    const node = makeNode({
      attrs: { post_hook: "cleanup $DIR" },
    });
    const graph = makeGraph(
      [{ name: "DIR", defaultValue: "/tmp/build" }],
      node,
    );

    const transform = new VariableExpansionTransform();
    transform.apply(graph);

    expect(graph.getNode("n1").attrs["post_hook"]).toBe("cleanup /tmp/build");
  });

  it("unresolved $var in tool_command is left as-is", () => {
    const node = makeNode({
      attrs: { tool_command: "run $UNDEFINED_VAR" },
    });
    const graph = makeGraph([], node);

    const transform = new VariableExpansionTransform();
    transform.apply(graph);

    expect(graph.getNode("n1").attrs["tool_command"]).toBe(
      "run $UNDEFINED_VAR",
    );
  });
});
