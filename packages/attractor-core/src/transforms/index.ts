import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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
 * Find the project root by walking up from the given directory,
 * looking for `.git/` or `.attractor/`.
 */
function findProjectRoot(startDir: string): string | undefined {
  let dir = startDir;
  while (true) {
    if (
      fs.existsSync(path.join(dir, ".git")) ||
      fs.existsSync(path.join(dir, ".attractor"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return undefined;
}

/**
 * Build the command search path for /command prompt lookups.
 *
 * Search order:
 *   1. {dot_file_dir}/{name}.md
 *   2. {project}/.attractor/commands/{name}.md
 *   3. For each extra dir from ATTRACTOR_COMMANDS_PATH: {project}/{extra_dir}/{name}.md
 *   4. ~/.attractor/commands/{name}.md
 *   5. For each extra dir from ATTRACTOR_COMMANDS_PATH: ~/{extra_dir}/{name}.md
 */
function buildCommandSearchPaths(
  dotFileDir: string,
  commandName: string,
  envPath?: string,
): string[] {
  const mdFile = `${commandName}.md`;
  const paths: string[] = [];

  // 1. Relative to DOT file directory
  paths.push(path.join(dotFileDir, mdFile));

  // Parse extra dirs from ATTRACTOR_COMMANDS_PATH
  const extraDirs: string[] = [];
  if (envPath) {
    for (const segment of envPath.split(",")) {
      const trimmed = segment.trim();
      if (trimmed) extraDirs.push(trimmed);
    }
  }

  // 2 & 3. Project-level paths
  const projectRoot = findProjectRoot(dotFileDir);
  if (projectRoot) {
    paths.push(path.join(projectRoot, ".attractor", "commands", mdFile));
    for (const extraDir of extraDirs) {
      paths.push(path.join(projectRoot, extraDir, mdFile));
    }
  }

  // 4 & 5. User-level paths
  const homeDir = os.homedir();
  paths.push(path.join(homeDir, ".attractor", "commands", mdFile));
  for (const extraDir of extraDirs) {
    paths.push(path.join(homeDir, extraDir, mdFile));
  }

  return paths;
}

/**
 * Prompt Resolution Transform: resolves @file includes and /command lookups.
 *
 * When a node's prompt starts with `@`, reads the referenced file relative
 * to the DOT file's directory and replaces the prompt with file contents.
 *
 * When a node's prompt starts with `/`, searches for a command `.md` file
 * in the search path, replaces the prompt with file contents, and injects
 * $ARGUMENTS for later variable expansion.
 *
 * This transform MUST run before VariableExpansionTransform.
 */
export class PromptResolutionTransform implements Transform {
  private dotFilePath?: string;

  constructor(dotFilePath?: string) {
    this.dotFilePath = dotFilePath;
  }

  apply(graph: Graph): Graph {
    if (!this.dotFilePath) return graph;

    const dotFileDir = path.dirname(path.resolve(this.dotFilePath));

    // Track unresolved prompts for validation
    const unresolvedFiles: Array<{ nodeId: string; filePath: string }> = [];
    const unresolvedCommands: Array<{ nodeId: string; commandName: string; searchedPaths: string[] }> = [];

    for (const node of graph.nodes.values()) {
      if (!node.prompt) continue;

      if (node.prompt.startsWith("@")) {
        // @file include
        const filePath = node.prompt.slice(1);
        const resolvedPath = path.resolve(dotFileDir, filePath);
        if (fs.existsSync(resolvedPath)) {
          node.prompt = fs.readFileSync(resolvedPath, "utf-8");
        } else {
          unresolvedFiles.push({ nodeId: node.id, filePath: resolvedPath });
        }
      } else if (node.prompt.startsWith("/")) {
        // /command lookup
        const raw = node.prompt.slice(1);
        const spaceIdx = raw.indexOf(" ");
        let commandName: string;
        let args: string;
        if (spaceIdx >= 0) {
          commandName = raw.slice(0, spaceIdx);
          args = raw.slice(spaceIdx + 1);
        } else {
          commandName = raw;
          args = "";
        }

        // Translate colons to path separators
        commandName = commandName.replace(/:/g, "/");

        const envPath = process.env["ATTRACTOR_COMMANDS_PATH"];
        const searchPaths = buildCommandSearchPaths(dotFileDir, commandName, envPath);

        let found = false;
        for (const searchPath of searchPaths) {
          if (fs.existsSync(searchPath)) {
            node.prompt = fs.readFileSync(searchPath, "utf-8");
            found = true;
            break;
          }
        }

        if (found) {
          // Inject $ARGUMENTS into the graph's vars for variable expansion
          const existingVar = graph.attrs.vars.find((v) => v.name === "ARGUMENTS");
          if (existingVar) {
            existingVar.defaultValue = args;
          } else {
            graph.attrs.vars.push({ name: "ARGUMENTS", defaultValue: args });
          }
        } else {
          unresolvedCommands.push({ nodeId: node.id, commandName, searchedPaths: searchPaths });
        }
      }
    }

    // Store resolution failures on graph attrs for validation rules to pick up
    if (unresolvedFiles.length > 0) {
      graph.attrs._unresolvedPromptFiles = unresolvedFiles;
    }
    if (unresolvedCommands.length > 0) {
      graph.attrs._unresolvedPromptCommands = unresolvedCommands;
    }

    return graph;
  }
}

/**
 * Variable Expansion Transform: expands $identifier references in node prompts
 * using declared variables (from graph[vars]) merged with runtime overrides.
 */
export class VariableExpansionTransform implements Transform {
  private overrides: Record<string, string>;

  constructor(overrides: Record<string, string> = {}) {
    this.overrides = overrides;
  }

  apply(graph: Graph): Graph {
    // Build resolved variables map: defaults from vars declarations, then overrides
    const resolved: Record<string, string> = {};
    for (const v of graph.attrs.vars) {
      if (v.defaultValue !== undefined) {
        resolved[v.name] = v.defaultValue;
      }
    }
    // Overrides win
    for (const [k, v] of Object.entries(this.overrides)) {
      resolved[k] = v;
    }

    // Expand $identifier in prompts and goal
    const expand = (text: string): string =>
      text.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, name) => {
        if (name in resolved) return resolved[name]!;
        return match; // leave unresolved variables as-is
      });

    for (const node of graph.nodes.values()) {
      if (node.prompt) node.prompt = expand(node.prompt);
      if (node.label) node.label = expand(node.label);
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
      const resolved = resolveStyleProperties(rules, node.id, node.classes, node.shape);

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

/** Build the default transform list, optionally with variable overrides and dotFilePath */
export function defaultTransforms(
  variables?: Record<string, string>,
  dotFilePath?: string,
): Transform[] {
  return [
    new PromptResolutionTransform(dotFilePath),
    new VariableExpansionTransform(variables),
    new StylesheetApplicationTransform(),
  ];
}

/** @deprecated Use defaultTransforms() */
export const DEFAULT_TRANSFORMS: Transform[] = defaultTransforms();

/** Apply all transforms to a graph */
export function applyTransforms(
  graph: Graph,
  transforms?: Transform[],
  variables?: Record<string, string>,
  dotFilePath?: string,
): Graph {
  const list = transforms ?? defaultTransforms(variables, dotFilePath);
  let result = graph;
  for (const transform of list) {
    result = transform.apply(result);
  }
  return result;
}
