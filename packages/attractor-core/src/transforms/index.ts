import type { Graph } from "../model/graph.js";
import {
  parseStylesheet,
  resolveStyleProperties,
} from "../stylesheet/index.js";

/** Transform interface: modifies the graph between parsing and validation */
export interface Transform {
  apply(graph: Graph): Graph;
}

/**
 * Variable Expansion Transform: expands $goal in node prompts.
 */
export class VariableExpansionTransform implements Transform {
  apply(graph: Graph): Graph {
    const goal = graph.attrs.goal;
    for (const node of graph.nodes.values()) {
      if (node.prompt.includes("$goal")) {
        node.prompt = node.prompt.replaceAll("$goal", goal);
      }
    }
    return graph;
  }
}

/**
 * Stylesheet Application Transform: applies model_stylesheet
 * rules to resolve llm_model, llm_provider, reasoning_effort for each node.
 */
export class StylesheetApplicationTransform implements Transform {
  apply(graph: Graph): Graph {
    const stylesheetSource = graph.attrs.modelStylesheet;
    if (!stylesheetSource) return graph;

    const rules = parseStylesheet(stylesheetSource);
    if (rules.length === 0) return graph;

    for (const node of graph.nodes.values()) {
      const resolved = resolveStyleProperties(rules, node.id, node.classes);

      // Only set properties that the node doesn't already have explicitly
      if (!node.llmModel && resolved["llm_model"]) {
        node.llmModel = resolved["llm_model"];
      }
      if (!node.llmProvider && resolved["llm_provider"]) {
        node.llmProvider = resolved["llm_provider"];
      }
      if (
        node.reasoningEffort === "high" &&
        resolved["reasoning_effort"]
      ) {
        // Only override if still at default
        node.reasoningEffort = resolved["reasoning_effort"];
      }
    }

    return graph;
  }
}

/** Default set of transforms applied during preparePipeline */
export const DEFAULT_TRANSFORMS: Transform[] = [
  new VariableExpansionTransform(),
  new StylesheetApplicationTransform(),
];

/** Apply all transforms to a graph */
export function applyTransforms(
  graph: Graph,
  transforms: Transform[] = DEFAULT_TRANSFORMS,
): Graph {
  let result = graph;
  for (const transform of transforms) {
    result = transform.apply(result);
  }
  return result;
}
