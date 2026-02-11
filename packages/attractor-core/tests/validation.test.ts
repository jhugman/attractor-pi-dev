import { describe, it, expect } from "vitest";
import { parseDot } from "../src/parser/parser.js";
import { buildGraph } from "../src/model/builder.js";
import { Graph } from "../src/model/graph.js";
import type { GraphAttrs, GraphEdge, GraphNode } from "../src/model/graph.js";
import {
  validate,
  validateOrRaise,
  Severity,
  ValidationError,
} from "../src/validation/index.js";

function buildAndValidate(dot: string) {
  const ast = parseDot(dot);
  const graph = buildGraph(ast);
  return validate(graph);
}

describe("Validation", () => {
  it("passes a valid pipeline", () => {
    const diags = buildAndValidate(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [label="A", prompt="Do A"]
        start -> a -> exit
      }
    `);
    const errors = diags.filter((d) => d.severity === Severity.ERROR);
    expect(errors.length).toBe(0);
  });

  it("errors on missing start node", () => {
    const diags = buildAndValidate(`
      digraph G {
        exit [shape=Msquare]
        a [label="A"]
        a -> exit
      }
    `);
    const startErrors = diags.filter((d) => d.rule === "start_node");
    expect(startErrors.length).toBe(1);
    expect(startErrors[0]!.severity).toBe(Severity.ERROR);
  });

  it("errors on missing exit node", () => {
    const diags = buildAndValidate(`
      digraph G {
        start [shape=Mdiamond]
        a [label="A"]
        start -> a
      }
    `);
    const exitErrors = diags.filter((d) => d.rule === "terminal_node");
    expect(exitErrors.length).toBe(1);
    expect(exitErrors[0]!.severity).toBe(Severity.ERROR);
  });

  it("errors on unreachable nodes", () => {
    const diags = buildAndValidate(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        orphan [label="Orphan"]
        start -> exit
      }
    `);
    const reach = diags.filter((d) => d.rule === "reachability");
    expect(reach.length).toBe(1);
    expect(reach[0]!.nodeId).toBe("orphan");
  });

  it("errors on start node with incoming edges", () => {
    const diags = buildAndValidate(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [label="A"]
        start -> a -> exit
        a -> start
      }
    `);
    const startIn = diags.filter((d) => d.rule === "start_no_incoming");
    expect(startIn.length).toBe(1);
  });

  it("errors on exit node with outgoing edges", () => {
    const diags = buildAndValidate(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [label="A"]
        start -> a -> exit
        exit -> a
      }
    `);
    const exitOut = diags.filter((d) => d.rule === "exit_no_outgoing");
    expect(exitOut.length).toBe(1);
  });

  it("warns on unknown handler type", () => {
    const diags = buildAndValidate(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="unknown_type"]
        start -> a -> exit
      }
    `);
    const typeWarns = diags.filter((d) => d.rule === "type_known");
    expect(typeWarns.length).toBe(1);
    expect(typeWarns[0]!.severity).toBe(Severity.WARNING);
  });

  it("warns on missing prompt on LLM nodes", () => {
    const diags = buildAndValidate(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        do_thing [shape=box]
        start -> do_thing -> exit
      }
    `);
    const promptWarns = diags.filter((d) => d.rule === "prompt_on_llm_nodes");
    expect(promptWarns.length).toBe(1);
  });

  it("warns on goal_gate without retry_target", () => {
    const diags = buildAndValidate(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [goal_gate=true, prompt="Do A"]
        start -> a -> exit
      }
    `);
    const gateWarns = diags.filter((d) => d.rule === "goal_gate_has_retry");
    expect(gateWarns.length).toBe(1);
  });

  it("validateOrRaise throws on errors", () => {
    const ast = parseDot(`
      digraph G {
        a [label="A"]
      }
    `);
    const graph = buildGraph(ast);
    expect(() => validateOrRaise(graph)).toThrow(ValidationError);
  });

  it("no diagnostic for valid stylesheet", () => {
    const diags = buildAndValidate(`
      digraph G {
        graph [model_stylesheet="* { llm_model: sonnet; }"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [prompt="Do A"]
        start -> a -> exit
      }
    `);
    const ssErrors = diags.filter((d) => d.rule === "stylesheet_syntax");
    expect(ssErrors.length).toBe(0);
  });

  it("errors on malformed stylesheet", () => {
    const diags = buildAndValidate(`
      digraph G {
        graph [model_stylesheet="bad { no-colon }"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [prompt="Do A"]
        start -> a -> exit
      }
    `);
    const ssErrors = diags.filter((d) => d.rule === "stylesheet_syntax");
    expect(ssErrors.length).toBe(1);
    expect(ssErrors[0]!.severity).toBe(Severity.ERROR);
  });

  it("no diagnostic for empty stylesheet", () => {
    const diags = buildAndValidate(`
      digraph G {
        graph [model_stylesheet=""]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [prompt="Do A"]
        start -> a -> exit
      }
    `);
    const ssErrors = diags.filter((d) => d.rule === "stylesheet_syntax");
    expect(ssErrors.length).toBe(0);
  });

  it("no diagnostic when no model_stylesheet attribute", () => {
    const diags = buildAndValidate(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [prompt="Do A"]
        start -> a -> exit
      }
    `);
    const ssErrors = diags.filter((d) => d.rule === "stylesheet_syntax");
    expect(ssErrors.length).toBe(0);
  });

  it("validateOrRaise returns warnings without throwing", () => {
    const ast = parseDot(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="custom_thing", prompt="do stuff"]
        start -> a -> exit
      }
    `);
    const graph = buildGraph(ast);
    const diags = validateOrRaise(graph);
    expect(diags.some((d) => d.severity === Severity.WARNING)).toBe(true);
  });

  it("errors on edge whose target does not exist", () => {
    // buildGraph auto-creates nodes for edge endpoints, so we construct
    // the Graph directly with a dangling edge target.
    const nodes = new Map<string, GraphNode>();
    const mkNode = (id: string, shape: string): GraphNode => ({
      id,
      label: id,
      shape,
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
    });
    nodes.set("start", mkNode("start", "Mdiamond"));
    nodes.set("a", mkNode("a", "box"));
    nodes.set("exit", mkNode("exit", "Msquare"));

    const edges: GraphEdge[] = [
      { fromNode: "start", toNode: "a", label: "", condition: "", weight: 0, fidelity: "", threadId: "", loopRestart: false, attrs: {} },
      { fromNode: "a", toNode: "exit", label: "", condition: "", weight: 0, fidelity: "", threadId: "", loopRestart: false, attrs: {} },
      // This edge targets a node that does not exist
      { fromNode: "a", toNode: "ghost", label: "", condition: "", weight: 0, fidelity: "", threadId: "", loopRestart: false, attrs: {} },
    ];

    const attrs: GraphAttrs = {
      goal: "",
      label: "",
      modelStylesheet: "",
      defaultMaxRetry: 50,
      retryTarget: "",
      fallbackRetryTarget: "",
      defaultFidelity: "",
      vars: [],
      varsExplicit: false,
    };

    const graph = new Graph("G", attrs, nodes, edges);
    const diags = validate(graph);
    const edgeErrors = diags.filter((d) => d.rule === "edge_target_exists");
    expect(edgeErrors.length).toBe(1);
    expect(edgeErrors[0]!.severity).toBe(Severity.ERROR);
    expect(edgeErrors[0]!.edge).toEqual({ from: "a", to: "ghost" });
  });

  it("warns on invalid fidelity mode", () => {
    const diags = buildAndValidate(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [fidelity="bogus", prompt="Do A"]
        start -> a -> exit
      }
    `);
    const fidelityWarns = diags.filter((d) => d.rule === "fidelity_valid");
    expect(fidelityWarns.length).toBe(1);
    expect(fidelityWarns[0]!.severity).toBe(Severity.WARNING);
    expect(fidelityWarns[0]!.nodeId).toBe("a");
  });

  it("warns on retry_target pointing to nonexistent node", () => {
    const diags = buildAndValidate(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [retry_target="nonexistent", prompt="Do A"]
        start -> a -> exit
      }
    `);
    const retryWarns = diags.filter((d) => d.rule === "retry_target_exists");
    expect(retryWarns.length).toBe(1);
    expect(retryWarns[0]!.severity).toBe(Severity.WARNING);
    expect(retryWarns[0]!.nodeId).toBe("a");
  });

  it("errors on malformed condition syntax", () => {
    const diags = buildAndValidate(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [prompt="Do A"]
        start -> a
        a -> exit [condition="outcome matches [invalid"]
      }
    `);
    const condErrors = diags.filter((d) => d.rule === "condition_syntax");
    expect(condErrors.length).toBe(1);
    expect(condErrors[0]!.severity).toBe(Severity.ERROR);
  });
});
