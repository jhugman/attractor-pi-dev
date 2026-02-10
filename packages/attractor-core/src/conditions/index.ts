import type { Context } from "../state/context.js";
import type { Outcome } from "../state/types.js";

export interface ConditionClause {
  key: string;
  operator: "=" | "!=";
  value: string;
}

export interface ParsedCondition {
  clauses: ConditionClause[];
  raw: string;
}

/**
 * Parse a condition expression string into clauses.
 * Grammar: Clause ( '&&' Clause )*
 * Clause: Key ('=' | '!=') Literal
 */
export function parseCondition(condition: string): ParsedCondition {
  const raw = condition.trim();
  if (!raw) return { clauses: [], raw };

  const parts = raw.split("&&").map((p) => p.trim()).filter(Boolean);
  const clauses: ConditionClause[] = [];

  for (const part of parts) {
    // Check != first (before =)
    const neqIdx = part.indexOf("!=");
    if (neqIdx >= 0) {
      clauses.push({
        key: part.slice(0, neqIdx).trim(),
        operator: "!=",
        value: part.slice(neqIdx + 2).trim(),
      });
      continue;
    }

    const eqIdx = part.indexOf("=");
    if (eqIdx >= 0) {
      clauses.push({
        key: part.slice(0, eqIdx).trim(),
        operator: "=",
        value: part.slice(eqIdx + 1).trim(),
      });
      continue;
    }

    // Bare key: truthy check (treat as key != "")
    clauses.push({
      key: part.trim(),
      operator: "!=",
      value: "",
    });
  }

  return { clauses, raw };
}

/**
 * Validate that a condition string parses without error.
 * Returns null if valid, error message if invalid.
 */
export function validateConditionSyntax(condition: string): string | null {
  try {
    const parsed = parseCondition(condition);
    for (const clause of parsed.clauses) {
      if (!clause.key) return "Empty key in condition clause";
    }
    return null;
  } catch (err) {
    return String(err);
  }
}

/**
 * Resolve a condition variable key against outcome and context.
 */
export function resolveKey(
  key: string,
  outcome: Outcome,
  context: Context,
): string {
  if (key === "outcome") {
    return outcome.status;
  }
  if (key === "preferred_label") {
    return outcome.preferredLabel ?? "";
  }
  if (key.startsWith("context.")) {
    const val = context.get(key);
    if (val !== undefined && val !== null) return String(val);
    // Also try without "context." prefix
    const shortKey = key.slice(8);
    const val2 = context.get(shortKey);
    if (val2 !== undefined && val2 !== null) return String(val2);
    return "";
  }
  // Direct context lookup
  const val = context.get(key);
  if (val !== undefined && val !== null) return String(val);
  return "";
}

/**
 * Evaluate a single clause against outcome and context.
 */
function evaluateClause(
  clause: ConditionClause,
  outcome: Outcome,
  context: Context,
): boolean {
  const resolved = resolveKey(clause.key, outcome, context);
  if (clause.operator === "=") {
    return resolved === clause.value;
  }
  return resolved !== clause.value;
}

/**
 * Evaluate a condition expression string.
 * Empty conditions always return true.
 */
export function evaluateCondition(
  condition: string,
  outcome: Outcome,
  context: Context,
): boolean {
  if (!condition.trim()) return true;
  const parsed = parseCondition(condition);
  return parsed.clauses.every((clause) =>
    evaluateClause(clause, outcome, context),
  );
}
