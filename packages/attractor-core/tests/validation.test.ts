import { describe, it, expect } from "vitest";
import { parseDot } from "../src/parser/parser.js";
import { buildGraph } from "../src/model/builder.js";
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
});
