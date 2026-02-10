import type { GraphEdge } from "../model/graph.js";
import type { Context } from "../state/context.js";
import type { Outcome } from "../state/types.js";
import { evaluateCondition } from "../conditions/index.js";

/**
 * Select the next edge from a node's outgoing edges.
 * Five-step priority: condition match -> preferred label -> suggested IDs -> weight -> lexical
 */
export function selectEdge(
  edges: GraphEdge[],
  outcome: Outcome,
  context: Context,
): GraphEdge | null {
  if (edges.length === 0) return null;

  // Step 1: Condition matching
  const conditionMatched: GraphEdge[] = [];
  for (const edge of edges) {
    if (edge.condition) {
      if (evaluateCondition(edge.condition, outcome, context)) {
        conditionMatched.push(edge);
      }
    }
  }
  if (conditionMatched.length > 0) {
    return bestByWeightThenLexical(conditionMatched);
  }

  // Step 2: Preferred label match
  if (outcome.preferredLabel) {
    for (const edge of edges) {
      if (
        normalizeLabel(edge.label) === normalizeLabel(outcome.preferredLabel)
      ) {
        return edge;
      }
    }
  }

  // Step 3: Suggested next IDs
  if (outcome.suggestedNextIds && outcome.suggestedNextIds.length > 0) {
    for (const suggestedId of outcome.suggestedNextIds) {
      for (const edge of edges) {
        if (edge.toNode === suggestedId) {
          return edge;
        }
      }
    }
  }

  // Step 4 & 5: Weight with lexical tiebreak (unconditional edges only)
  const unconditional = edges.filter((e) => !e.condition);
  if (unconditional.length > 0) {
    return bestByWeightThenLexical(unconditional);
  }

  // Fallback: any edge
  return bestByWeightThenLexical(edges);
}

/** Sort by weight descending, then target node ID ascending (lexical) */
function bestByWeightThenLexical(edges: GraphEdge[]): GraphEdge {
  const sorted = [...edges].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.toNode.localeCompare(b.toNode);
  });
  return sorted[0]!;
}

/**
 * Normalize a label for comparison:
 * lowercase, trim, strip accelerator prefixes like [Y], Y), Y -
 */
export function normalizeLabel(label: string): string {
  let s = label.trim().toLowerCase();
  // Strip [K] prefix
  s = s.replace(/^\[[a-z0-9]\]\s*/, "");
  // Strip K) prefix
  s = s.replace(/^[a-z0-9]\)\s*/, "");
  // Strip K - prefix
  s = s.replace(/^[a-z0-9]\s*-\s*/, "");
  return s.trim();
}
