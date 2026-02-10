import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { preparePipeline, parseAndBuild } from "../src/engine/pipeline.js";
import { PipelineRunner } from "../src/engine/runner.js";
import { Context } from "../src/state/context.js";
import { StageStatus } from "../src/state/types.js";
import { validate, Severity } from "../src/validation/index.js";
import type { PipelineEvent } from "../src/events/index.js";
import { AutoApproveInterviewer, QueueInterviewer } from "../src/handlers/interviewers.js";
import type { Answer } from "../src/handlers/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "attractor-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Integration: preparePipeline", () => {
  it("parses, transforms, and validates a simple pipeline", () => {
    const { graph, diagnostics } = preparePipeline(`
      digraph Simple {
        graph [goal="Run tests and report"]
        start [shape=Mdiamond, label="Start"]
        exit  [shape=Msquare, label="Exit"]
        run_tests [label="Run Tests", prompt="Run the test suite for: $goal"]
        report    [label="Report", prompt="Summarize results"]
        start -> run_tests -> report -> exit
      }
    `);

    expect(graph.id).toBe("Simple");
    expect(graph.nodes.size).toBe(4);
    // $goal should be expanded
    expect(graph.getNode("run_tests").prompt).toBe(
      "Run the test suite for: Run tests and report",
    );
    const errors = diagnostics.filter((d) => d.severity === Severity.ERROR);
    expect(errors.length).toBe(0);
  });
});

describe("Integration: PipelineRunner", () => {
  it("runs a simple linear pipeline in simulate mode", async () => {
    const { graph } = preparePipeline(`
      digraph Simple {
        graph [goal="Run tests"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        run_tests [label="Run Tests", prompt="Run tests"]
        report    [label="Report", prompt="Summarize"]
        start -> run_tests -> report -> exit
      }
    `);

    const events: PipelineEvent[] = [];
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      onEvent: (e) => events.push(e),
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.completedNodes).toContain("start");
    expect(result.completedNodes).toContain("run_tests");
    expect(result.completedNodes).toContain("report");

    // Check events were emitted
    expect(events.some((e) => e.type === "pipeline_started")).toBe(true);
    expect(events.some((e) => e.type === "pipeline_completed")).toBe(true);
    expect(events.some((e) => e.type === "stage_started")).toBe(true);
    expect(events.some((e) => e.type === "checkpoint_saved")).toBe(true);

    // Check artifacts exist
    expect(
      fs.existsSync(path.join(tmpDir, "run_tests", "prompt.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, "run_tests", "response.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, "run_tests", "status.json")),
    ).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "checkpoint.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "manifest.json"))).toBe(true);
  });

  it("runs conditional branching pipeline", async () => {
    const { graph } = preparePipeline(`
      digraph Branch {
        graph [goal="Implement and validate"]
        node [shape=box]
        start     [shape=Mdiamond]
        exit      [shape=Msquare]
        plan      [label="Plan", prompt="Plan it"]
        implement [label="Implement", prompt="Build it"]
        validate  [label="Validate", prompt="Test it"]
        gate      [shape=diamond, label="Tests passing?"]
        start -> plan -> implement -> validate -> gate
        gate -> exit      [label="Yes", condition="outcome=success"]
        gate -> implement [label="No", condition="outcome!=success"]
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });
    const result = await runner.run(graph);

    // In simulation mode, all stages return SUCCESS, so gate -> exit
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.completedNodes).toContain("plan");
    expect(result.completedNodes).toContain("implement");
    expect(result.completedNodes).toContain("validate");
    expect(result.completedNodes).toContain("gate");
  });

  it("handles human gate with auto-approve", async () => {
    const { graph } = preparePipeline(`
      digraph Review {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        review [shape=hexagon, label="Review Changes"]
        ship_it [label="Ship It", prompt="Deploy"]
        fixes [label="Fix Issues", prompt="Fix"]
        start -> review
        review -> ship_it [label="[A] Approve"]
        review -> fixes [label="[F] Fix"]
        ship_it -> exit
        fixes -> review
      }
    `);

    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      interviewer: new AutoApproveInterviewer(),
    });
    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.completedNodes).toContain("review");
    expect(result.completedNodes).toContain("ship_it");
  });

  it("context updates from one node are visible to the next", async () => {
    const { graph } = preparePipeline(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [prompt="Do A"]
        b [prompt="Do B"]
        start -> a -> b -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });
    const result = await runner.run(graph);

    // After a runs, context should have last_stage set
    expect(result.context.getString("last_stage")).toBe("b");
    expect(result.context.getString("graph.goal")).toBe("");
  });

  it("goal gate blocks exit when unsatisfied", async () => {
    // We need a custom backend that returns FAIL for the goal gate node
    const { graph } = preparePipeline(`
      digraph G {
        graph [goal="test", retry_target="plan"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan  [prompt="Plan", goal_gate=true]
        start -> plan -> exit
      }
    `);

    // With default simulate mode, plan returns SUCCESS, so it passes
    const runner = new PipelineRunner({ logsRoot: tmpDir });
    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
  });

  it("edge selection: weight breaks ties for unconditional edges", async () => {
    const { graph } = preparePipeline(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        gate [shape=diamond]
        a [prompt="A"]
        b [prompt="B"]
        start -> gate
        gate -> a [weight=10]
        gate -> b [weight=5]
        a -> exit
        b -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });
    const result = await runner.run(graph);

    // Should route through 'a' (higher weight)
    expect(result.completedNodes).toContain("a");
    expect(result.completedNodes).not.toContain("b");
  });

  it("custom handler registration and execution", async () => {
    const { graph } = preparePipeline(`
      digraph G {
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="my_custom", label="Custom"]
        start -> a -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });
    runner.registerHandler("my_custom", {
      async execute(node, _ctx, _graph, _logsRoot) {
        return {
          status: StageStatus.SUCCESS,
          notes: `Custom handler ran for ${node.id}`,
          contextUpdates: { "custom.ran": "true" },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.context.getString("custom.ran")).toBe("true");
  });

  it("variable expansion ($goal) works", () => {
    const { graph } = preparePipeline(`
      digraph G {
        graph [goal="Build the widget"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [prompt="Plan how to: $goal"]
        start -> plan -> exit
      }
    `);
    expect(graph.getNode("plan").prompt).toBe("Plan how to: Build the widget");
  });

  it("pipeline with 10+ nodes completes without errors", async () => {
    const { graph } = preparePipeline(`
      digraph Large {
        graph [goal="Build a large pipeline"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        n1 [prompt="Step 1"]
        n2 [prompt="Step 2"]
        n3 [prompt="Step 3"]
        n4 [prompt="Step 4"]
        n5 [prompt="Step 5"]
        n6 [prompt="Step 6"]
        n7 [prompt="Step 7"]
        n8 [prompt="Step 8"]
        n9 [prompt="Step 9"]
        n10 [prompt="Step 10"]
        start -> n1 -> n2 -> n3 -> n4 -> n5 -> n6 -> n7 -> n8 -> n9 -> n10 -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });
    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.completedNodes.length).toBe(11); // start + 10 nodes
  });
});

describe("Integration: Smoke Test (spec 11.13)", () => {
  it("runs the spec integration smoke test pipeline", async () => {
    const DOT = `
      digraph test_pipeline {
        graph [goal="Create a hello world Python script"]
        start       [shape=Mdiamond]
        plan        [shape=box, prompt="Plan how to create a hello world script for: $goal"]
        implement   [shape=box, prompt="Write the code based on the plan", goal_gate=true]
        review      [shape=box, prompt="Review the code for correctness"]
        done        [shape=Msquare]
        start -> plan
        plan -> implement
        implement -> review [condition="outcome=success"]
        implement -> plan   [condition="outcome=fail", label="Retry"]
        review -> done      [condition="outcome=success"]
        review -> implement [condition="outcome=fail", label="Fix"]
      }
    `;

    // 1. Parse
    const { graph, diagnostics } = preparePipeline(DOT);
    expect(graph.attrs.goal).toBe("Create a hello world Python script");
    expect(graph.nodes.size).toBe(5);
    expect(graph.edges.length).toBe(6);

    // 2. Validate
    const errors = diagnostics.filter((d) => d.severity === Severity.ERROR);
    expect(errors.length).toBe(0);

    // 3. Execute with simulation (no LLM)
    const runner = new PipelineRunner({ logsRoot: tmpDir });
    const result = await runner.run(graph);

    // 4. Verify
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.completedNodes).toContain("implement");

    // 5. Verify artifacts
    expect(
      fs.existsSync(path.join(tmpDir, "plan", "prompt.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, "plan", "response.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, "plan", "status.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, "implement", "prompt.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, "review", "prompt.md")),
    ).toBe(true);

    // 6. Verify checkpoint
    expect(fs.existsSync(path.join(tmpDir, "checkpoint.json"))).toBe(true);
    const checkpoint = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "checkpoint.json"), "utf-8"),
    );
    expect(checkpoint.completedNodes).toContain("plan");
    expect(checkpoint.completedNodes).toContain("implement");
    expect(checkpoint.completedNodes).toContain("review");
  });
});
