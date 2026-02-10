import { describe, it, expect } from "vitest";
import { Lexer, TokenType } from "../src/parser/lexer.js";
import { parseDot, ParseError } from "../src/parser/parser.js";

describe("Lexer", () => {
  it("tokenizes a simple digraph", () => {
    const tokens = new Lexer('digraph G { a -> b }').tokenize();
    const types = tokens.map((t) => t.type);
    expect(types).toEqual([
      TokenType.Digraph,
      TokenType.Identifier,
      TokenType.LBrace,
      TokenType.Identifier,
      TokenType.Arrow,
      TokenType.Identifier,
      TokenType.RBrace,
      TokenType.EOF,
    ]);
  });

  it("tokenizes string values with escapes", () => {
    const tokens = new Lexer('"hello\\nworld"').tokenize();
    expect(tokens[0]!.type).toBe(TokenType.String);
    expect(tokens[0]!.value).toBe("hello\nworld");
  });

  it("tokenizes integers and floats", () => {
    const tokens = new Lexer("42 -1 0.5 -3.14").tokenize();
    expect(tokens[0]!.type).toBe(TokenType.Integer);
    expect(tokens[0]!.value).toBe("42");
    expect(tokens[1]!.type).toBe(TokenType.Integer);
    expect(tokens[1]!.value).toBe("-1");
    expect(tokens[2]!.type).toBe(TokenType.Float);
    expect(tokens[2]!.value).toBe("0.5");
    expect(tokens[3]!.type).toBe(TokenType.Float);
    expect(tokens[3]!.value).toBe("-3.14");
  });

  it("tokenizes duration values", () => {
    const tokens = new Lexer("900s 15m 2h 250ms 1d").tokenize();
    expect(tokens[0]!.type).toBe(TokenType.Duration);
    expect(tokens[0]!.value).toBe("900s");
    expect(tokens[1]!.type).toBe(TokenType.Duration);
    expect(tokens[1]!.value).toBe("15m");
    expect(tokens[2]!.type).toBe(TokenType.Duration);
    expect(tokens[2]!.value).toBe("2h");
    expect(tokens[3]!.type).toBe(TokenType.Duration);
    expect(tokens[3]!.value).toBe("250ms");
    expect(tokens[4]!.type).toBe(TokenType.Duration);
    expect(tokens[4]!.value).toBe("1d");
  });

  it("tokenizes boolean values", () => {
    const tokens = new Lexer("true false").tokenize();
    expect(tokens[0]!.type).toBe(TokenType.True);
    expect(tokens[1]!.type).toBe(TokenType.False);
  });

  it("strips line comments", () => {
    const tokens = new Lexer("digraph G {\n// comment\na\n}").tokenize();
    const ids = tokens.filter((t) => t.type === TokenType.Identifier);
    expect(ids.map((t) => t.value)).toEqual(["G", "a"]);
  });

  it("strips block comments", () => {
    const tokens = new Lexer("digraph G { /* comment */ a }").tokenize();
    const ids = tokens.filter((t) => t.type === TokenType.Identifier);
    expect(ids.map((t) => t.value)).toEqual(["G", "a"]);
  });

  it("tracks line and column", () => {
    const tokens = new Lexer("digraph G {\n  a\n}").tokenize();
    const aToken = tokens.find((t) => t.value === "a");
    expect(aToken!.loc.line).toBe(2);
    expect(aToken!.loc.column).toBe(3);
  });
});

describe("Parser", () => {
  it("parses a simple linear workflow", () => {
    const ast = parseDot(`
      digraph Simple {
        graph [goal="Run tests and report"]
        rankdir=LR

        start [shape=Mdiamond, label="Start"]
        exit  [shape=Msquare, label="Exit"]

        run_tests [label="Run Tests", prompt="Run the test suite and report results"]
        report    [label="Report", prompt="Summarize the test results"]

        start -> run_tests -> report -> exit
      }
    `);

    expect(ast.id).toBe("Simple");
    // Should have graph attrs, node defaults style (rankdir), node stmts, edge stmts
    const nodeStmts = ast.body.filter((s) => s.kind === "node");
    expect(nodeStmts.length).toBe(4);
    const edgeStmts = ast.body.filter((s) => s.kind === "edge");
    expect(edgeStmts.length).toBe(1);
    // The chained edge has 4 nodes -> 1 edge stmt with chain of 4
    expect(edgeStmts[0]!.kind === "edge" && edgeStmts[0]!.chain.length).toBe(4);
  });

  it("parses node attributes", () => {
    const ast = parseDot(`
      digraph G {
        a [shape=box, label="Hello", timeout=900s, goal_gate=true, max_retries=3]
      }
    `);
    const node = ast.body.find((s) => s.kind === "node" && s.id === "a");
    expect(node).toBeDefined();
    if (node?.kind === "node") {
      expect(node.attrs.length).toBe(5);
      const shape = node.attrs.find((a) => a.key === "shape");
      expect(shape?.value).toEqual({ kind: "identifier", value: "box" });
      const timeout = node.attrs.find((a) => a.key === "timeout");
      expect(timeout?.value.kind).toBe("duration");
      const gate = node.attrs.find((a) => a.key === "goal_gate");
      expect(gate?.value).toEqual({ kind: "boolean", value: true });
    }
  });

  it("parses edge attributes", () => {
    const ast = parseDot(`
      digraph G {
        a -> b [label="Yes", condition="outcome=success", weight=10]
      }
    `);
    const edge = ast.body.find((s) => s.kind === "edge");
    expect(edge).toBeDefined();
    if (edge?.kind === "edge") {
      expect(edge.chain).toEqual(["a", "b"]);
      const label = edge.attrs.find((a) => a.key === "label");
      expect(label?.value).toEqual({ kind: "string", value: "Yes" });
      const weight = edge.attrs.find((a) => a.key === "weight");
      expect(weight?.value).toEqual({ kind: "integer", value: 10 });
    }
  });

  it("parses chained edges", () => {
    const ast = parseDot(`
      digraph G {
        A -> B -> C [label="next"]
      }
    `);
    const edge = ast.body.find((s) => s.kind === "edge");
    expect(edge).toBeDefined();
    if (edge?.kind === "edge") {
      expect(edge.chain).toEqual(["A", "B", "C"]);
    }
  });

  it("parses subgraphs", () => {
    const ast = parseDot(`
      digraph G {
        subgraph cluster_loop {
          label = "Loop A"
          node [thread_id="loop-a", timeout=900s]
          Plan [label="Plan next step"]
          Implement [label="Implement", timeout=1800s]
        }
      }
    `);
    const sub = ast.body.find((s) => s.kind === "subgraph");
    expect(sub).toBeDefined();
    if (sub?.kind === "subgraph") {
      expect(sub.id).toBe("cluster_loop");
      expect(sub.body.length).toBeGreaterThan(0);
    }
  });

  it("parses node and edge defaults", () => {
    const ast = parseDot(`
      digraph G {
        node [shape=box, timeout=900s]
        edge [weight=0]
        a [label="A"]
        b [label="B"]
        a -> b
      }
    `);
    const nodeDef = ast.body.find((s) => s.kind === "node_defaults");
    expect(nodeDef).toBeDefined();
    const edgeDef = ast.body.find((s) => s.kind === "edge_defaults");
    expect(edgeDef).toBeDefined();
  });

  it("parses graph-level attribute declarations", () => {
    const ast = parseDot(`
      digraph G {
        rankdir=LR
        goal = "test"
      }
    `);
    const decls = ast.body.filter((s) => s.kind === "graph_attr_decl");
    expect(decls.length).toBe(2);
  });

  it("handles multi-line attribute blocks", () => {
    const ast = parseDot(`
      digraph G {
        review_gate [
          shape=hexagon,
          label="Review Changes",
          type="wait.human"
        ]
      }
    `);
    const node = ast.body.find((s) => s.kind === "node");
    expect(node).toBeDefined();
    if (node?.kind === "node") {
      expect(node.attrs.length).toBe(3);
    }
  });

  it("parses qualified identifiers (dotted keys)", () => {
    const ast = parseDot(`
      digraph G {
        a [tool_hooks.pre="echo hi"]
      }
    `);
    const node = ast.body.find((s) => s.kind === "node");
    if (node?.kind === "node") {
      expect(node.attrs[0]!.key).toBe("tool_hooks.pre");
    }
  });

  it("handles semicolons optionally", () => {
    const ast = parseDot(`
      digraph G {
        a [label="A"];
        b [label="B"]
        a -> b;
      }
    `);
    const nodes = ast.body.filter((s) => s.kind === "node");
    expect(nodes.length).toBe(2);
  });

  it("errors on undirected graphs", () => {
    // The parser only supports 'digraph'; this should fail
    expect(() => parseDot(`graph G { a -- b }`)).toThrow();
  });

  it("parses the branching workflow example", () => {
    const ast = parseDot(`
      digraph Branch {
        graph [goal="Implement and validate a feature"]
        rankdir=LR
        node [shape=box, timeout=900s]

        start     [shape=Mdiamond, label="Start"]
        exit      [shape=Msquare, label="Exit"]
        plan      [label="Plan", prompt="Plan the implementation"]
        implement [label="Implement", prompt="Implement the plan"]
        validate  [label="Validate", prompt="Run tests"]
        gate      [shape=diamond, label="Tests passing?"]

        start -> plan -> implement -> validate -> gate
        gate -> exit      [label="Yes", condition="outcome=success"]
        gate -> implement [label="No", condition="outcome!=success"]
      }
    `);

    expect(ast.id).toBe("Branch");
    const nodes = ast.body.filter((s) => s.kind === "node");
    expect(nodes.length).toBe(6);
    const edges = ast.body.filter((s) => s.kind === "edge");
    expect(edges.length).toBe(3);
  });

  it("parses the human gate example", () => {
    const ast = parseDot(`
      digraph Review {
        rankdir=LR

        start [shape=Mdiamond, label="Start"]
        exit  [shape=Msquare, label="Exit"]

        review_gate [
          shape=hexagon,
          label="Review Changes",
          type="wait.human"
        ]

        start -> review_gate
        review_gate -> ship_it [label="[A] Approve"]
        review_gate -> fixes   [label="[F] Fix"]
        ship_it -> exit
        fixes -> review_gate
      }
    `);
    expect(ast.id).toBe("Review");
    const nodes = ast.body.filter((s) => s.kind === "node");
    expect(nodes.length).toBe(3); // start, exit, review_gate (ship_it and fixes are implicit from edges)
  });
});
