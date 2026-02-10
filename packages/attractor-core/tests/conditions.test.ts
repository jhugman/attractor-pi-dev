import { describe, it, expect } from "vitest";
import {
  parseCondition,
  evaluateCondition,
  validateConditionSyntax,
} from "../src/conditions/index.js";
import { Context } from "../src/state/context.js";
import { StageStatus } from "../src/state/types.js";
import type { Outcome } from "../src/state/types.js";

function makeOutcome(
  status: StageStatus,
  opts?: Partial<Outcome>,
): Outcome {
  return { status, ...opts };
}

describe("Condition Expression Language", () => {
  describe("parseCondition", () => {
    it("parses simple equals", () => {
      const parsed = parseCondition("outcome=success");
      expect(parsed.clauses.length).toBe(1);
      expect(parsed.clauses[0]).toEqual({
        key: "outcome",
        operator: "=",
        value: "success",
      });
    });

    it("parses not equals", () => {
      const parsed = parseCondition("outcome!=success");
      expect(parsed.clauses[0]).toEqual({
        key: "outcome",
        operator: "!=",
        value: "success",
      });
    });

    it("parses AND conjunction", () => {
      const parsed = parseCondition(
        "outcome=success && context.tests_passed=true",
      );
      expect(parsed.clauses.length).toBe(2);
      expect(parsed.clauses[0]!.key).toBe("outcome");
      expect(parsed.clauses[1]!.key).toBe("context.tests_passed");
    });

    it("returns empty clauses for empty string", () => {
      const parsed = parseCondition("");
      expect(parsed.clauses.length).toBe(0);
    });
  });

  describe("evaluateCondition", () => {
    it("empty condition is always true", () => {
      const outcome = makeOutcome(StageStatus.SUCCESS);
      const ctx = new Context();
      expect(evaluateCondition("", outcome, ctx)).toBe(true);
    });

    it("matches outcome=success", () => {
      const ctx = new Context();
      expect(
        evaluateCondition(
          "outcome=success",
          makeOutcome(StageStatus.SUCCESS),
          ctx,
        ),
      ).toBe(true);
      expect(
        evaluateCondition(
          "outcome=success",
          makeOutcome(StageStatus.FAIL),
          ctx,
        ),
      ).toBe(false);
    });

    it("matches outcome!=success", () => {
      const ctx = new Context();
      expect(
        evaluateCondition(
          "outcome!=success",
          makeOutcome(StageStatus.FAIL),
          ctx,
        ),
      ).toBe(true);
      expect(
        evaluateCondition(
          "outcome!=success",
          makeOutcome(StageStatus.SUCCESS),
          ctx,
        ),
      ).toBe(false);
    });

    it("matches context variables", () => {
      const ctx = new Context();
      ctx.set("tests_passed", "true");
      const outcome = makeOutcome(StageStatus.SUCCESS);

      expect(
        evaluateCondition("context.tests_passed=true", outcome, ctx),
      ).toBe(true);
    });

    it("missing context keys compare as empty string", () => {
      const ctx = new Context();
      const outcome = makeOutcome(StageStatus.SUCCESS);
      expect(
        evaluateCondition("context.nonexistent=true", outcome, ctx),
      ).toBe(false);
      expect(
        evaluateCondition("context.nonexistent!=true", outcome, ctx),
      ).toBe(true);
    });

    it("AND conjunction requires all clauses", () => {
      const ctx = new Context();
      ctx.set("tests_passed", "true");
      const outcome = makeOutcome(StageStatus.SUCCESS);

      expect(
        evaluateCondition(
          "outcome=success && context.tests_passed=true",
          outcome,
          ctx,
        ),
      ).toBe(true);
      expect(
        evaluateCondition(
          "outcome=fail && context.tests_passed=true",
          outcome,
          ctx,
        ),
      ).toBe(false);
    });

    it("resolves preferred_label", () => {
      const outcome = makeOutcome(StageStatus.SUCCESS, {
        preferredLabel: "Fix",
      });
      const ctx = new Context();
      expect(
        evaluateCondition("preferred_label=Fix", outcome, ctx),
      ).toBe(true);
    });
  });

  describe("validateConditionSyntax", () => {
    it("returns null for valid conditions", () => {
      expect(validateConditionSyntax("outcome=success")).toBeNull();
      expect(
        validateConditionSyntax("outcome=success && context.x=true"),
      ).toBeNull();
      expect(validateConditionSyntax("")).toBeNull();
    });

    it("returns error for empty key", () => {
      expect(validateConditionSyntax("=value")).not.toBeNull();
    });
  });
});
