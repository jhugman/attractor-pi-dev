import { describe, it, expect } from "vitest";
import { selectEdge, normalizeLabel } from "../src/engine/edge-selection.js";
import { delayForAttempt } from "../src/engine/retry.js";
import type { GraphEdge } from "../src/model/graph.js";
import { Context } from "../src/state/context.js";
import { StageStatus } from "../src/state/types.js";
import type { Outcome } from "../src/state/types.js";

function makeEdge(overrides: Partial<GraphEdge>): GraphEdge {
  return {
    fromNode: "a",
    toNode: "b",
    label: "",
    condition: "",
    weight: 0,
    fidelity: "",
    threadId: "",
    loopRestart: false,
    attrs: {},
    ...overrides,
  };
}

function makeOutcome(status: StageStatus, opts?: Partial<Outcome>): Outcome {
  return { status, ...opts };
}

describe("Edge Selection", () => {
  it("returns null for empty edges", () => {
    const ctx = new Context();
    expect(selectEdge([], makeOutcome(StageStatus.SUCCESS), ctx)).toBeNull();
  });

  it("step 1: condition match wins", () => {
    const ctx = new Context();
    const edges = [
      makeEdge({ toNode: "b", condition: "outcome=success" }),
      makeEdge({ toNode: "c", condition: "outcome=fail" }),
      makeEdge({ toNode: "d" }),
    ];
    const result = selectEdge(edges, makeOutcome(StageStatus.SUCCESS), ctx);
    expect(result?.toNode).toBe("b");
  });

  it("step 2: preferred label match", () => {
    const ctx = new Context();
    const edges = [
      makeEdge({ toNode: "b", label: "Yes" }),
      makeEdge({ toNode: "c", label: "No" }),
    ];
    const result = selectEdge(
      edges,
      makeOutcome(StageStatus.SUCCESS, { preferredLabel: "No" }),
      ctx,
    );
    expect(result?.toNode).toBe("c");
  });

  it("step 3: suggested next IDs", () => {
    const ctx = new Context();
    const edges = [
      makeEdge({ toNode: "b" }),
      makeEdge({ toNode: "c" }),
    ];
    const result = selectEdge(
      edges,
      makeOutcome(StageStatus.SUCCESS, { suggestedNextIds: ["c"] }),
      ctx,
    );
    expect(result?.toNode).toBe("c");
  });

  it("step 4: weight breaks ties", () => {
    const ctx = new Context();
    const edges = [
      makeEdge({ toNode: "b", weight: 5 }),
      makeEdge({ toNode: "c", weight: 10 }),
    ];
    const result = selectEdge(edges, makeOutcome(StageStatus.SUCCESS), ctx);
    expect(result?.toNode).toBe("c");
  });

  it("step 5: lexical tiebreak as final fallback", () => {
    const ctx = new Context();
    const edges = [
      makeEdge({ toNode: "c" }),
      makeEdge({ toNode: "a" }),
      makeEdge({ toNode: "b" }),
    ];
    const result = selectEdge(edges, makeOutcome(StageStatus.SUCCESS), ctx);
    expect(result?.toNode).toBe("a");
  });

  it("condition match has higher priority than weight", () => {
    const ctx = new Context();
    const edges = [
      makeEdge({ toNode: "b", weight: 100 }),
      makeEdge({ toNode: "c", condition: "outcome=success", weight: 1 }),
    ];
    const result = selectEdge(edges, makeOutcome(StageStatus.SUCCESS), ctx);
    expect(result?.toNode).toBe("c");
  });
});

describe("normalizeLabel", () => {
  it("strips [K] prefix", () => {
    expect(normalizeLabel("[Y] Yes, deploy")).toBe("yes, deploy");
  });

  it("strips K) prefix", () => {
    expect(normalizeLabel("Y) Yes, deploy")).toBe("yes, deploy");
  });

  it("strips K - prefix", () => {
    expect(normalizeLabel("Y - Yes, deploy")).toBe("yes, deploy");
  });

  it("lowercases", () => {
    expect(normalizeLabel("APPROVE")).toBe("approve");
  });
});

describe("Retry backoff", () => {
  it("calculates exponential delay", () => {
    const config = {
      initialDelayMs: 200,
      backoffFactor: 2.0,
      maxDelayMs: 60000,
      jitter: false,
    };
    expect(delayForAttempt(1, config)).toBe(200);
    expect(delayForAttempt(2, config)).toBe(400);
    expect(delayForAttempt(3, config)).toBe(800);
  });

  it("caps at max delay", () => {
    const config = {
      initialDelayMs: 200,
      backoffFactor: 2.0,
      maxDelayMs: 500,
      jitter: false,
    };
    expect(delayForAttempt(5, config)).toBe(500);
  });
});
