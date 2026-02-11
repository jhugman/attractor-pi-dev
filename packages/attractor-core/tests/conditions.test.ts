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
      expect(parsed.clauses[0]).toMatchObject({
        key: "outcome",
        operator: "=",
        value: "success",
      });
    });

    it("parses not equals", () => {
      const parsed = parseCondition("outcome!=success");
      expect(parsed.clauses[0]).toMatchObject({
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

    it("parses contains operator", () => {
      const parsed = parseCondition('context.name contains "foo"');
      expect(parsed.clauses[0]).toMatchObject({
        key: "context.name",
        operator: "contains",
        value: "foo",
      });
    });

    it("parses matches operator", () => {
      const parsed = parseCondition('context.name matches "^foo.*"');
      expect(parsed.clauses[0]).toMatchObject({
        key: "context.name",
        operator: "matches",
        value: "^foo.*",
      });
    });

    it("parses OR conjunction", () => {
      const parsed = parseCondition(
        "outcome=success || outcome=partial_success",
      );
      expect(parsed.groups.length).toBe(2);
      expect(parsed.groups[0]!.clauses[0]!.value).toBe("success");
      expect(parsed.groups[1]!.clauses[0]!.value).toBe("partial_success");
    });

    it("parses NOT prefix", () => {
      const parsed = parseCondition("!context.flag=true");
      expect(parsed.clauses[0]).toMatchObject({
        key: "context.flag",
        operator: "=",
        value: "true",
        negated: true,
      });
    });

    it("parses numeric comparison operators", () => {
      const lt = parseCondition("context.count < 10");
      expect(lt.clauses[0]).toMatchObject({
        key: "context.count",
        operator: "<",
        value: "10",
      });

      const gt = parseCondition("context.count > 10");
      expect(gt.clauses[0]).toMatchObject({
        key: "context.count",
        operator: ">",
        value: "10",
      });

      const lte = parseCondition("context.count <= 10");
      expect(lte.clauses[0]).toMatchObject({
        key: "context.count",
        operator: "<=",
        value: "10",
      });

      const gte = parseCondition("context.count >= 10");
      expect(gte.clauses[0]).toMatchObject({
        key: "context.count",
        operator: ">=",
        value: "10",
      });
    });

    it("parses mixed AND/OR with correct precedence", () => {
      const parsed = parseCondition(
        "outcome=success && context.x=1 || outcome=fail && context.y=2",
      );
      expect(parsed.groups.length).toBe(2);
      expect(parsed.groups[0]!.clauses.length).toBe(2);
      expect(parsed.groups[1]!.clauses.length).toBe(2);
      expect(parsed.groups[0]!.clauses[0]!.value).toBe("success");
      expect(parsed.groups[0]!.clauses[1]!.value).toBe("1");
      expect(parsed.groups[1]!.clauses[0]!.value).toBe("fail");
      expect(parsed.groups[1]!.clauses[1]!.value).toBe("2");
    });

    it("strips quotes from values", () => {
      const dq = parseCondition('context.name = "hello world"');
      expect(dq.clauses[0]!.value).toBe("hello world");

      const sq = parseCondition("context.name = 'hello world'");
      expect(sq.clauses[0]!.value).toBe("hello world");
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

    // ── contains operator ──

    describe("contains operator", () => {
      it("matches substring", () => {
        const ctx = new Context();
        ctx.set("name", "hello world");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition('context.name contains "world"', outcome, ctx),
        ).toBe(true);
      });

      it("does not match when substring absent", () => {
        const ctx = new Context();
        ctx.set("name", "hello world");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition('context.name contains "xyz"', outcome, ctx),
        ).toBe(false);
      });

      it("matches without quotes", () => {
        const ctx = new Context();
        ctx.set("name", "hello world");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition("context.name contains world", outcome, ctx),
        ).toBe(true);
      });

      it("matches empty substring (always true)", () => {
        const ctx = new Context();
        ctx.set("name", "anything");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition('context.name contains ""', outcome, ctx),
        ).toBe(true);
      });

      it("handles missing context key gracefully", () => {
        const ctx = new Context();
        const outcome = makeOutcome(StageStatus.SUCCESS);

        // Empty string does not contain "foo"
        expect(
          evaluateCondition('context.missing contains "foo"', outcome, ctx),
        ).toBe(false);
      });
    });

    // ── matches operator ──

    describe("matches operator", () => {
      it("matches a regex pattern", () => {
        const ctx = new Context();
        ctx.set("name", "foo-bar-123");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition('context.name matches "^foo.*"', outcome, ctx),
        ).toBe(true);
      });

      it("does not match when regex fails", () => {
        const ctx = new Context();
        ctx.set("name", "bar-baz");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition('context.name matches "^foo.*"', outcome, ctx),
        ).toBe(false);
      });

      it("matches with digit pattern", () => {
        const ctx = new Context();
        ctx.set("code", "ABC-123");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition(
            'context.code matches "^[A-Z]+-\\d+$"',
            outcome,
            ctx,
          ),
        ).toBe(true);
      });

      it("handles missing key (empty string vs regex)", () => {
        const ctx = new Context();
        const outcome = makeOutcome(StageStatus.SUCCESS);

        // Empty string matches "^$"
        expect(
          evaluateCondition('context.missing matches "^$"', outcome, ctx),
        ).toBe(true);

        // Empty string does not match "\\S+"
        expect(
          evaluateCondition('context.missing matches "\\S+"', outcome, ctx),
        ).toBe(false);
      });
    });

    // ── OR operator ──

    describe("OR (||) operator", () => {
      it("true when both sides true", () => {
        const ctx = new Context();
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition(
            "outcome=success || outcome=fail",
            outcome,
            ctx,
          ),
        ).toBe(true);
      });

      it("true when left side true", () => {
        const ctx = new Context();
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition(
            "outcome=success || outcome=fail",
            outcome,
            ctx,
          ),
        ).toBe(true);
      });

      it("true when right side true", () => {
        const ctx = new Context();
        const outcome = makeOutcome(StageStatus.FAIL);

        expect(
          evaluateCondition(
            "outcome=success || outcome=fail",
            outcome,
            ctx,
          ),
        ).toBe(true);
      });

      it("false when both sides false", () => {
        const ctx = new Context();
        const outcome = makeOutcome(StageStatus.RETRY);

        expect(
          evaluateCondition(
            "outcome=success || outcome=fail",
            outcome,
            ctx,
          ),
        ).toBe(false);
      });

      it("respects AND/OR precedence", () => {
        const ctx = new Context();
        ctx.set("flag", "yes");
        const outcome = makeOutcome(StageStatus.FAIL);

        // "outcome=success && context.flag=yes || outcome=fail"
        // Group 1: outcome=success AND flag=yes -> false
        // Group 2: outcome=fail -> true
        // Result: true (because OR)
        expect(
          evaluateCondition(
            "outcome=success && context.flag=yes || outcome=fail",
            outcome,
            ctx,
          ),
        ).toBe(true);

        // "outcome=fail && context.flag=no || outcome=success && context.flag=yes"
        // Group 1: outcome=fail AND flag=no -> false (flag is yes)
        // Group 2: outcome=success AND flag=yes -> false (outcome is fail)
        // Result: false
        expect(
          evaluateCondition(
            "outcome=fail && context.flag=no || outcome=success && context.flag=yes",
            outcome,
            ctx,
          ),
        ).toBe(false);
      });

      it("works with three OR groups", () => {
        const ctx = new Context();
        const outcome = makeOutcome(StageStatus.PARTIAL_SUCCESS);

        expect(
          evaluateCondition(
            "outcome=success || outcome=fail || outcome=partial_success",
            outcome,
            ctx,
          ),
        ).toBe(true);
      });
    });

    // ── NOT operator ──

    describe("NOT (!) operator", () => {
      it("negates an equals clause", () => {
        const ctx = new Context();
        const outcome = makeOutcome(StageStatus.SUCCESS);

        // !outcome=fail -> NOT (outcome = fail) -> NOT false -> true
        expect(
          evaluateCondition("!outcome=fail", outcome, ctx),
        ).toBe(true);

        // !outcome=success -> NOT (outcome = success) -> NOT true -> false
        expect(
          evaluateCondition("!outcome=success", outcome, ctx),
        ).toBe(false);
      });

      it("negates a context check", () => {
        const ctx = new Context();
        ctx.set("flag", "true");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition("!context.flag=false", outcome, ctx),
        ).toBe(true);
        expect(
          evaluateCondition("!context.flag=true", outcome, ctx),
        ).toBe(false);
      });

      it("negates contains operator", () => {
        const ctx = new Context();
        ctx.set("name", "hello");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition('!context.name contains "xyz"', outcome, ctx),
        ).toBe(true);
        expect(
          evaluateCondition('!context.name contains "hello"', outcome, ctx),
        ).toBe(false);
      });

      it("negates matches operator", () => {
        const ctx = new Context();
        ctx.set("name", "hello");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition('!context.name matches "^zzz"', outcome, ctx),
        ).toBe(true);
        expect(
          evaluateCondition('!context.name matches "^hel"', outcome, ctx),
        ).toBe(false);
      });

      it("works with AND conjunction", () => {
        const ctx = new Context();
        ctx.set("flag", "true");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        // outcome=success AND NOT flag=false -> true AND true -> true
        expect(
          evaluateCondition(
            "outcome=success && !context.flag=false",
            outcome,
            ctx,
          ),
        ).toBe(true);
      });
    });

    // ── Numeric comparisons ──

    describe("numeric comparisons", () => {
      it("less than", () => {
        const ctx = new Context();
        ctx.set("count", "5");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition("context.count < 10", outcome, ctx),
        ).toBe(true);
        expect(
          evaluateCondition("context.count < 5", outcome, ctx),
        ).toBe(false);
        expect(
          evaluateCondition("context.count < 3", outcome, ctx),
        ).toBe(false);
      });

      it("greater than", () => {
        const ctx = new Context();
        ctx.set("count", "5");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition("context.count > 3", outcome, ctx),
        ).toBe(true);
        expect(
          evaluateCondition("context.count > 5", outcome, ctx),
        ).toBe(false);
        expect(
          evaluateCondition("context.count > 10", outcome, ctx),
        ).toBe(false);
      });

      it("less than or equal", () => {
        const ctx = new Context();
        ctx.set("count", "5");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition("context.count <= 5", outcome, ctx),
        ).toBe(true);
        expect(
          evaluateCondition("context.count <= 10", outcome, ctx),
        ).toBe(true);
        expect(
          evaluateCondition("context.count <= 4", outcome, ctx),
        ).toBe(false);
      });

      it("greater than or equal", () => {
        const ctx = new Context();
        ctx.set("count", "5");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition("context.count >= 5", outcome, ctx),
        ).toBe(true);
        expect(
          evaluateCondition("context.count >= 3", outcome, ctx),
        ).toBe(true);
        expect(
          evaluateCondition("context.count >= 10", outcome, ctx),
        ).toBe(false);
      });

      it("handles floating point numbers", () => {
        const ctx = new Context();
        ctx.set("score", "3.14");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition("context.score > 3.0", outcome, ctx),
        ).toBe(true);
        expect(
          evaluateCondition("context.score < 4.0", outcome, ctx),
        ).toBe(true);
        expect(
          evaluateCondition("context.score >= 3.14", outcome, ctx),
        ).toBe(true);
        expect(
          evaluateCondition("context.score <= 3.14", outcome, ctx),
        ).toBe(true);
      });

      it("handles negative numbers", () => {
        const ctx = new Context();
        ctx.set("temp", "-5");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition("context.temp < 0", outcome, ctx),
        ).toBe(true);
        expect(
          evaluateCondition("context.temp > -10", outcome, ctx),
        ).toBe(true);
      });

      it("returns false for non-numeric values", () => {
        const ctx = new Context();
        ctx.set("name", "hello");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition("context.name > 5", outcome, ctx),
        ).toBe(false);
        expect(
          evaluateCondition("context.name < 5", outcome, ctx),
        ).toBe(false);
      });

      it("returns false for missing keys (NaN comparison)", () => {
        const ctx = new Context();
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition("context.missing > 0", outcome, ctx),
        ).toBe(false);
      });

      it("handles zero comparisons", () => {
        const ctx = new Context();
        ctx.set("count", "0");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition("context.count >= 0", outcome, ctx),
        ).toBe(true);
        expect(
          evaluateCondition("context.count <= 0", outcome, ctx),
        ).toBe(true);
        expect(
          evaluateCondition("context.count > 0", outcome, ctx),
        ).toBe(false);
      });
    });

    // ── Combined operators ──

    describe("combined operators", () => {
      it("AND with contains and equals", () => {
        const ctx = new Context();
        ctx.set("name", "hello world");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        expect(
          evaluateCondition(
            'outcome=success && context.name contains "hello"',
            outcome,
            ctx,
          ),
        ).toBe(true);
        expect(
          evaluateCondition(
            'outcome=fail && context.name contains "hello"',
            outcome,
            ctx,
          ),
        ).toBe(false);
      });

      it("OR with numeric and string operators", () => {
        const ctx = new Context();
        ctx.set("count", "15");
        ctx.set("flag", "active");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        // count > 10 is true OR flag=inactive is false -> true
        expect(
          evaluateCondition(
            "context.count > 10 || context.flag=inactive",
            outcome,
            ctx,
          ),
        ).toBe(true);
      });

      it("NOT with OR", () => {
        const ctx = new Context();
        const outcome = makeOutcome(StageStatus.SUCCESS);

        // !outcome=fail is true -> entire OR is true
        expect(
          evaluateCondition(
            "!outcome=fail || outcome=retry",
            outcome,
            ctx,
          ),
        ).toBe(true);
      });

      it("complex expression with all operator types", () => {
        const ctx = new Context();
        ctx.set("name", "test-project");
        ctx.set("retries", "3");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        // Group 1: outcome=success AND name contains "test" AND retries < 5
        // -> true AND true AND true -> true
        expect(
          evaluateCondition(
            'outcome=success && context.name contains "test" && context.retries < 5',
            outcome,
            ctx,
          ),
        ).toBe(true);
      });

      it("NOT with numeric comparison", () => {
        const ctx = new Context();
        ctx.set("count", "3");
        const outcome = makeOutcome(StageStatus.SUCCESS);

        // NOT (count > 10) -> NOT false -> true
        expect(
          evaluateCondition("!context.count > 10", outcome, ctx),
        ).toBe(true);

        // NOT (count < 10) -> NOT true -> false
        expect(
          evaluateCondition("!context.count < 10", outcome, ctx),
        ).toBe(false);
      });
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

    it("returns null for new operator conditions", () => {
      expect(
        validateConditionSyntax('context.name contains "foo"'),
      ).toBeNull();
      expect(
        validateConditionSyntax('context.name matches "^foo"'),
      ).toBeNull();
      expect(
        validateConditionSyntax("outcome=success || outcome=fail"),
      ).toBeNull();
      expect(
        validateConditionSyntax("!context.flag=true"),
      ).toBeNull();
      expect(
        validateConditionSyntax("context.count > 5"),
      ).toBeNull();
      expect(
        validateConditionSyntax("context.count <= 10"),
      ).toBeNull();
    });

    it("returns error for invalid regex in matches", () => {
      const result = validateConditionSyntax(
        'context.name matches "[invalid"',
      );
      expect(result).not.toBeNull();
      expect(result).toContain("Invalid regex");
    });
  });
});
