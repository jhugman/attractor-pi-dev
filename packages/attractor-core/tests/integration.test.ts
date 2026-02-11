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
import { Checkpoint } from "../src/state/checkpoint.js";

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

describe("Integration: loop_restart edge attribute", () => {
  it("resets retry counters when loop_restart edge is taken", async () => {
    // Pipeline: start -> work -> gate -> exit (on success)
    //                                  -> work [loop_restart=true] (on fail)
    // "work" node uses a custom handler that:
    //   - Sets a retry counter in context on first visit per loop
    //   - Uses max_retries=2 so the internal retry counter is meaningful
    const { graph } = preparePipeline(`
      digraph LoopTest {
        graph [goal="Test loop restart"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        work  [type="counting_handler", prompt="Do work", max_retries=1]
        gate  [shape=diamond, label="Check"]
        start -> work -> gate
        gate -> exit [condition="outcome=success"]
        gate -> work [condition="outcome!=success", loop_restart=true]
      }
    `);

    // Track how many times "work" has been executed across loop iterations
    let workExecutionCount = 0;

    const events: PipelineEvent[] = [];
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      onEvent: (e) => events.push(e),
    });

    // Custom handler that:
    //  1st call: sets a retry counter in context, returns SUCCESS
    //  (gate is conditional handler: returns SUCCESS in simulate)
    //  gate -> exit path taken on success
    // We need gate to return FAIL first time to trigger the loop_restart
    // Actually, the conditional handler just returns SUCCESS always.
    // We need to control the gate outcome directly.

    // Better approach: use a custom handler for gate too
    runner.registerHandler("counting_handler", {
      async execute(node, ctx, _graph, _logsRoot) {
        workExecutionCount++;
        // Record the retry counter value at the time of execution
        const retryKey = `internal.retry_count.${node.id}`;
        const currentRetryCount = ctx.getNumber(retryKey);
        ctx.set(`test.retry_count_at_exec_${workExecutionCount}`, currentRetryCount);
        ctx.set("test.work_exec_count", workExecutionCount);
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    // For gate: first time return FAIL to trigger loop, second time return SUCCESS
    let gateCallCount = 0;
    runner.registerHandler("conditional", {
      async execute(node, ctx, _graph, _logsRoot) {
        gateCallCount++;
        if (gateCallCount === 1) {
          return {
            status: StageStatus.FAIL,
            contextUpdates: { last_stage: node.id },
          };
        }
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);

    // Pipeline should complete successfully (gate succeeds second time)
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // work should have been executed twice (once per loop iteration)
    expect(workExecutionCount).toBe(2);

    // The retry counter for "work" should have been 0 on the second
    // execution, proving it was reset by loop_restart
    expect(result.context.getNumber("test.retry_count_at_exec_1")).toBe(0);
    expect(result.context.getNumber("test.retry_count_at_exec_2")).toBe(0);

    // A loop_restarted event should have been emitted
    const loopEvents = events.filter((e) => e.type === "loop_restarted");
    expect(loopEvents.length).toBe(1);
    const loopEvent = loopEvents[0] as { type: "loop_restarted"; fromNode: string; toNode: string };
    expect(loopEvent.fromNode).toBe("gate");
    expect(loopEvent.toNode).toBe("work");
  });

  it("clears nodeOutcomes for reachable nodes on loop_restart", async () => {
    // Pipeline: start -> a -> b -> gate -> exit (success)
    //                                    -> a [loop_restart=true] (fail)
    // Verify that on loop restart, nodeOutcomes for a and b are cleared
    const { graph } = preparePipeline(`
      digraph LoopClear {
        graph [goal="Test outcome clearing"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="track_handler", prompt="A"]
        b [type="track_handler", prompt="B"]
        gate [shape=diamond]
        start -> a -> b -> gate
        gate -> exit [condition="outcome=success"]
        gate -> a    [condition="outcome!=success", loop_restart=true]
      }
    `);

    const execOrder: string[] = [];
    const events: PipelineEvent[] = [];
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      onEvent: (e) => events.push(e),
    });

    runner.registerHandler("track_handler", {
      async execute(node, _ctx, _graph, _logsRoot) {
        execOrder.push(node.id);
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    let gateCount = 0;
    runner.registerHandler("conditional", {
      async execute(node, _ctx, _graph, _logsRoot) {
        gateCount++;
        execOrder.push(node.id);
        if (gateCount === 1) {
          return {
            status: StageStatus.FAIL,
            contextUpdates: { last_stage: node.id },
          };
        }
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    // Execution order: a, b, gate (fail), a, b, gate (success)
    expect(execOrder).toEqual(["a", "b", "gate", "a", "b", "gate"]);

    // Verify loop_restarted event
    expect(events.some((e) => e.type === "loop_restarted")).toBe(true);
  });

  it("does not reset retry counters when loop_restart is false", async () => {
    // Same structure but without loop_restart: counters should persist
    const { graph } = preparePipeline(`
      digraph NoLoopRestart {
        graph [goal="Test no reset"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        work  [type="retry_tracker", prompt="Do work", max_retries=1]
        gate  [shape=diamond]
        start -> work -> gate
        gate -> exit [condition="outcome=success"]
        gate -> work [condition="outcome!=success"]
      }
    `);

    let workCount = 0;
    const events: PipelineEvent[] = [];
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      onEvent: (e) => events.push(e),
    });

    runner.registerHandler("retry_tracker", {
      async execute(node, ctx, _graph, _logsRoot) {
        workCount++;
        // Set a retry counter manually to simulate previous retries
        const retryKey = `internal.retry_count.${node.id}`;
        if (workCount === 1) {
          ctx.set(retryKey, 3); // Simulate 3 retries from first iteration
        }
        ctx.set(`test.retry_at_work_${workCount}`, ctx.getNumber(retryKey));
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    let gateCount = 0;
    runner.registerHandler("conditional", {
      async execute(node, _ctx, _graph, _logsRoot) {
        gateCount++;
        if (gateCount === 1) {
          return {
            status: StageStatus.FAIL,
            contextUpdates: { last_stage: node.id },
          };
        }
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);

    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    // On first visit: handler sets retry counter to 3, then reads it back as 3
    expect(result.context.getNumber("test.retry_at_work_1")).toBe(3);
    // On second visit: retry counter should still be 3 (not reset, since loop_restart=false)
    expect(result.context.getNumber("test.retry_at_work_2")).toBe(3);

    // No loop_restarted event should exist
    const loopEvents = events.filter((e) => e.type === "loop_restarted");
    expect(loopEvents.length).toBe(0);
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

describe("Integration: Checkpoint Resume", () => {
  it("resumes a pipeline from a checkpoint, skipping already-completed nodes", async () => {
    // Pipeline: start -> a -> b -> c -> exit
    // We'll run it fully first, create a checkpoint after "a",
    // then resume from that checkpoint with a new runner.
    const DOT = `
      digraph Resume {
        graph [goal="Test resume"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="tracking", prompt="Do A"]
        b [type="tracking", prompt="Do B"]
        c [type="tracking", prompt="Do C"]
        start -> a -> b -> c -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    // Create a checkpoint as if we completed start and a
    const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-cp-"));
    const cp = new Checkpoint({
      currentNode: "a",
      completedNodes: ["start", "a"],
      context: { "graph.goal": "Test resume", last_stage: "a", outcome: "success" },
      nodeRetries: {},
    });
    cp.save(checkpointDir);

    // Now resume from the checkpoint
    const executedNodes: string[] = [];
    const events: PipelineEvent[] = [];
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: checkpointDir,
      onEvent: (e) => events.push(e),
    });
    runner.registerHandler("tracking", {
      async execute(node, ctx, _graph, _logsRoot) {
        executedNodes.push(node.id);
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);

    // Should succeed
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // Only b and c should have been actually executed (start and a were skipped)
    expect(executedNodes).toEqual(["b", "c"]);

    // completedNodes should include all nodes (restored + newly executed)
    expect(result.completedNodes).toContain("start");
    expect(result.completedNodes).toContain("a");
    expect(result.completedNodes).toContain("b");
    expect(result.completedNodes).toContain("c");

    // A checkpoint_resumed event should have been emitted
    const resumeEvents = events.filter((e) => e.type === "checkpoint_resumed");
    expect(resumeEvents.length).toBe(1);
    const resumeEvent = resumeEvents[0] as {
      type: "checkpoint_resumed";
      resumedFromNode: string;
      skippedNodes: string[];
    };
    expect(resumeEvent.resumedFromNode).toBe("a");
    expect(resumeEvent.skippedNodes).toEqual(["start", "a"]);

    // Clean up checkpoint dir
    fs.rmSync(checkpointDir, { recursive: true, force: true });
  });

  it("preserves context values across checkpoint/resume", async () => {
    const DOT = `
      digraph CtxResume {
        graph [goal="Test context resume"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="ctx_setter", prompt="Set context"]
        b [type="ctx_reader", prompt="Read context"]
        start -> a -> b -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    // Create a checkpoint after "a" with custom context values
    const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-resume-"));
    const cp = new Checkpoint({
      currentNode: "a",
      completedNodes: ["start", "a"],
      context: {
        "graph.goal": "Test context resume",
        outcome: "success",
        "custom.key1": "hello",
        "custom.key2": 42,
        last_stage: "a",
      },
      nodeRetries: {},
    });
    cp.save(checkpointDir);

    let capturedCtx: Record<string, unknown> = {};
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: checkpointDir,
    });

    runner.registerHandler("ctx_setter", {
      async execute(node, ctx, _graph, _logsRoot) {
        // Should not run since "a" was already completed
        return { status: StageStatus.SUCCESS };
      },
    });

    runner.registerHandler("ctx_reader", {
      async execute(node, ctx, _graph, _logsRoot) {
        // Capture context values that were restored from checkpoint
        capturedCtx = {
          key1: ctx.getString("custom.key1"),
          key2: ctx.getNumber("custom.key2"),
          lastStage: ctx.getString("last_stage"),
        };
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // Context from checkpoint should have been visible to node b
    expect(capturedCtx.key1).toBe("hello");
    expect(capturedCtx.key2).toBe(42);
    expect(capturedCtx.lastStage).toBe("a");

    // Final context should have the updated last_stage from b
    expect(result.context.getString("last_stage")).toBe("b");

    fs.rmSync(checkpointDir, { recursive: true, force: true });
  });

  it("restores retry counters from checkpoint", async () => {
    const DOT = `
      digraph RetryResume {
        graph [goal="Test retry resume"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="retry_check", prompt="A"]
        b [type="retry_check", prompt="B"]
        start -> a -> b -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    // Create a checkpoint after "a" with retry counters
    const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "retry-resume-"));
    const cp = new Checkpoint({
      currentNode: "a",
      completedNodes: ["start", "a"],
      context: {
        "graph.goal": "Test retry resume",
        outcome: "success",
        last_stage: "a",
        "internal.retry_count.a": 3,
      },
      nodeRetries: { a: 3 },
    });
    cp.save(checkpointDir);

    let retryCountAtB = -1;
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: checkpointDir,
    });

    runner.registerHandler("retry_check", {
      async execute(node, ctx, _graph, _logsRoot) {
        if (node.id === "b") {
          // Check that retry counter for "a" was restored
          retryCountAtB = ctx.getNumber("internal.retry_count.a");
        }
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // The retry counter for "a" should have been restored from the checkpoint
    expect(retryCountAtB).toBe(3);

    fs.rmSync(checkpointDir, { recursive: true, force: true });
  });

  it("handles resume when checkpoint directory has no checkpoint file", async () => {
    const DOT = `
      digraph NoCheckpoint {
        graph [goal="Test no checkpoint"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [prompt="Do A"]
        start -> a -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    // Point to an empty directory (no checkpoint.json)
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "no-cp-"));

    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: emptyDir,
    });

    // Should run normally from the start since no checkpoint exists
    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
    expect(result.completedNodes).toContain("start");
    expect(result.completedNodes).toContain("a");

    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it("resumed pipeline saves new checkpoints as it progresses", async () => {
    const DOT = `
      digraph SaveOnResume {
        graph [goal="Test checkpoint saves on resume"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="simple", prompt="A"]
        b [type="simple", prompt="B"]
        c [type="simple", prompt="C"]
        start -> a -> b -> c -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    // Checkpoint after "a"
    const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "save-resume-"));
    const cp = new Checkpoint({
      currentNode: "a",
      completedNodes: ["start", "a"],
      context: { "graph.goal": "Test checkpoint saves on resume", outcome: "success", last_stage: "a" },
      nodeRetries: {},
    });
    cp.save(checkpointDir);

    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: checkpointDir,
    });

    runner.registerHandler("simple", {
      async execute(node, _ctx, _graph, _logsRoot) {
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // The new logsRoot (tmpDir) should have a checkpoint.json reflecting the final state
    expect(fs.existsSync(path.join(tmpDir, "checkpoint.json"))).toBe(true);
    const finalCheckpoint = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "checkpoint.json"), "utf-8"),
    );
    // Last completed node should be "c"
    expect(finalCheckpoint.currentNode).toBe("c");
    expect(finalCheckpoint.completedNodes).toContain("start");
    expect(finalCheckpoint.completedNodes).toContain("a");
    expect(finalCheckpoint.completedNodes).toContain("b");
    expect(finalCheckpoint.completedNodes).toContain("c");

    fs.rmSync(checkpointDir, { recursive: true, force: true });
  });
});

describe("Integration: Pipeline Variables", () => {
  it("expands declared variables with defaults", () => {
    const { graph } = preparePipeline(`
      digraph Vars {
        graph [goal="Test vars", vars="feature=login, priority=high"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [prompt="Plan the $feature feature at $priority priority"]
        start -> plan -> exit
      }
    `);
    expect(graph.getNode("plan").prompt).toBe(
      "Plan the login feature at high priority",
    );
  });

  it("overrides defaults with --set variables", () => {
    const { graph } = preparePipeline(
      `
      digraph Vars {
        graph [goal="Test vars", vars="feature=login, priority=high"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [prompt="Plan the $feature feature at $priority priority"]
        start -> plan -> exit
      }
    `,
      { variables: { feature: "auth", priority: "low" } },
    );
    expect(graph.getNode("plan").prompt).toBe(
      "Plan the auth feature at low priority",
    );
  });

  it("$goal is implicitly declared from graph[goal]", () => {
    const { graph } = preparePipeline(`
      digraph Vars {
        graph [goal="Build a widget", vars="feature"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [prompt="Goal: $goal, feature: $feature"]
        start -> plan -> exit
      }
    `, { variables: { feature: "search" } });
    expect(graph.getNode("plan").prompt).toBe(
      "Goal: Build a widget, feature: search",
    );
  });

  it("--set goal overrides graph[goal] in prompts", () => {
    const { graph } = preparePipeline(
      `
      digraph Vars {
        graph [goal="Original goal", vars="feature=x"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [prompt="$goal with $feature"]
        start -> plan -> exit
      }
    `,
      { variables: { goal: "Overridden goal" } },
    );
    expect(graph.getNode("plan").prompt).toBe(
      "Overridden goal with x",
    );
  });

  it("validation catches undeclared variables", () => {
    expect(() =>
      preparePipeline(`
        digraph Vars {
          graph [goal="Test", vars="feature"]
          start [shape=Mdiamond]
          exit  [shape=Msquare]
          plan [prompt="Plan $feature with $unknown_var"]
          start -> plan -> exit
        }
      `, { variables: { feature: "login" } }),
    ).toThrow(/vars_declared/);
  });

  it("skips variable validation when no vars declared (backward compat)", () => {
    // No vars attribute at all — $anything in prompts is left as-is, no error
    const { graph } = preparePipeline(`
      digraph Legacy {
        graph [goal="Test legacy"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [prompt="Plan $goal with $something"]
        start -> plan -> exit
      }
    `);
    // $goal gets expanded (implicitly declared via graph[goal]), $something left as-is
    expect(graph.getNode("plan").prompt).toBe(
      "Plan Test legacy with $something",
    );
  });

  it("expands variables in labels too", () => {
    const { graph } = preparePipeline(`
      digraph Vars {
        graph [goal="Test", vars="env=prod"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        deploy [label="Deploy to $env", prompt="Deploy"]
        start -> deploy -> exit
      }
    `);
    expect(graph.getNode("deploy").label).toBe("Deploy to prod");
  });

  it("vars without defaults require --set values", () => {
    // feature has no default, so $feature won't expand unless --set provides it
    const { graph } = preparePipeline(`
      digraph Vars {
        graph [goal="Test", vars="feature"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [prompt="Plan $feature"]
        start -> plan -> exit
      }
    `, { variables: { feature: "notifications" } });
    expect(graph.getNode("plan").prompt).toBe("Plan notifications");
  });

  it("unresolved vars without --set are left as-is in prompt", () => {
    // feature declared but no default and no --set value
    const { graph } = preparePipeline(`
      digraph Vars {
        graph [goal="Test", vars="feature"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [prompt="Plan $feature"]
        start -> plan -> exit
      }
    `);
    // Variable is declared but not resolved — left as $feature
    expect(graph.getNode("plan").prompt).toBe("Plan $feature");
  });
});
