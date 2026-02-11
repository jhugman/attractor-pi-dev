import type { Context } from "../state/context.js";
import type { Outcome } from "../state/types.js";

// ── Types ──

export type ComparisonOperator =
  | "="
  | "!="
  | "contains"
  | "matches"
  | "<"
  | ">"
  | "<="
  | ">=";

export interface ConditionClause {
  key: string;
  operator: ComparisonOperator;
  value: string;
  negated: boolean;
}

/** A group of clauses joined by AND (all must be true) */
export interface AndGroup {
  clauses: ConditionClause[];
}

/** Top-level: groups joined by OR (any must be true) */
export interface ParsedCondition {
  groups: AndGroup[];
  /** Flat view of all clauses (backward compatibility) */
  clauses: ConditionClause[];
  raw: string;
}

// ── Parsing ──

/**
 * Strip surrounding quotes from a value string.
 * Handles both double quotes and single quotes.
 */
function stripQuotes(s: string): string {
  if (s.length >= 2) {
    if (
      (s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))
    ) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Parse a single clause string (without conjunctions).
 * Clause: '!'? Key Operator Value
 * Operators: =, !=, contains, matches, <=, >=, <, >
 * Or bare key: '!'? Key (treated as key != "")
 */
function parseClause(raw: string): ConditionClause {
  let text = raw.trim();

  // Handle NOT prefix
  let negated = false;
  if (text.startsWith("!")) {
    // But not "!=" — only bare "!" as a prefix
    const rest = text.slice(1).trim();
    // Check if this is a standalone negation (not part of !=)
    // If after removing ! the rest doesn't start with =, it's a NOT prefix
    if (!rest.startsWith("=")) {
      negated = true;
      text = rest;
    }
  }

  // Try multi-character operators first (order matters: <=, >= before <, >; != before =)
  // Also try keyword operators: contains, matches
  const operatorPatterns: { pattern: RegExp; operator: ComparisonOperator }[] =
    [
      { pattern: /\s+contains\s+/, operator: "contains" },
      { pattern: /\s+matches\s+/, operator: "matches" },
      { pattern: /<=/, operator: "<=" },
      { pattern: />=/, operator: ">=" },
      { pattern: /!=/, operator: "!=" },
      { pattern: /</, operator: "<" },
      { pattern: />/, operator: ">" },
      { pattern: /=/, operator: "=" },
    ];

  for (const { pattern, operator } of operatorPatterns) {
    const match = text.match(pattern);
    if (match && match.index !== undefined) {
      const key = text.slice(0, match.index).trim();
      const value = stripQuotes(
        text.slice(match.index + match[0].length).trim(),
      );
      return { key, operator, value, negated };
    }
  }

  // Bare key: truthy check (treat as key != "")
  return { key: text.trim(), operator: "!=", value: "", negated };
}

/**
 * Parse a condition expression string into a structured representation.
 *
 * Grammar (with precedence):
 *   Expression = AndExpr ( '||' AndExpr )*
 *   AndExpr    = Clause ( '&&' Clause )*
 *   Clause     = '!'? Key Operator Value
 *   Operator   = '=' | '!=' | 'contains' | 'matches' | '<' | '>' | '<=' | '>='
 */
export function parseCondition(condition: string): ParsedCondition {
  const raw = condition.trim();
  if (!raw) return { groups: [], clauses: [], raw };

  // Split by || first (lower precedence), then by && within each group
  const orParts = raw.split("||").map((p) => p.trim()).filter(Boolean);
  const groups: AndGroup[] = [];
  const allClauses: ConditionClause[] = [];

  for (const orPart of orParts) {
    const andParts = orPart.split("&&").map((p) => p.trim()).filter(Boolean);
    const clauses: ConditionClause[] = [];

    for (const part of andParts) {
      const clause = parseClause(part);
      clauses.push(clause);
      allClauses.push(clause);
    }

    groups.push({ clauses });
  }

  return { groups, clauses: allClauses, raw };
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
      // Validate regex for matches operator
      if (clause.operator === "matches") {
        try {
          new RegExp(clause.value);
        } catch {
          return `Invalid regex in matches operator: ${clause.value}`;
        }
      }
    }
    return null;
  } catch (err) {
    return String(err);
  }
}

// ── Key resolution ──

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

// ── Evaluation ──

/**
 * Evaluate a single clause against outcome and context.
 */
function evaluateClause(
  clause: ConditionClause,
  outcome: Outcome,
  context: Context,
): boolean {
  const resolved = resolveKey(clause.key, outcome, context);
  let result: boolean;

  switch (clause.operator) {
    case "=":
      result = resolved === clause.value;
      break;
    case "!=":
      result = resolved !== clause.value;
      break;
    case "contains":
      result = resolved.includes(clause.value);
      break;
    case "matches": {
      try {
        const regex = new RegExp(clause.value);
        result = regex.test(resolved);
      } catch {
        result = false;
      }
      break;
    }
    case "<":
    case ">":
    case "<=":
    case ">=": {
      const numResolved = Number(resolved);
      const numValue = Number(clause.value);
      if (isNaN(numResolved) || isNaN(numValue)) {
        result = false;
      } else {
        switch (clause.operator) {
          case "<":
            result = numResolved < numValue;
            break;
          case ">":
            result = numResolved > numValue;
            break;
          case "<=":
            result = numResolved <= numValue;
            break;
          case ">=":
            result = numResolved >= numValue;
            break;
        }
      }
      break;
    }
    default:
      result = false;
  }

  return clause.negated ? !result : result;
}

/**
 * Evaluate a condition expression string.
 * Empty conditions always return true.
 *
 * OR groups: any group being true makes the whole expression true.
 * AND within groups: all clauses in a group must be true.
 */
export function evaluateCondition(
  condition: string,
  outcome: Outcome,
  context: Context,
): boolean {
  if (!condition.trim()) return true;
  const parsed = parseCondition(condition);

  if (parsed.groups.length === 0) return true;

  // OR: any group passing makes the expression true
  return parsed.groups.some((group) =>
    group.clauses.every((clause) => evaluateClause(clause, outcome, context)),
  );
}
