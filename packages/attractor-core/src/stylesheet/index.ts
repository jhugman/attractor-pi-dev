/**
 * CSS-like model stylesheet parser and applicator.
 *
 * Grammar:
 *   Stylesheet ::= Rule+
 *   Rule       ::= Selector '{' Declaration (';' Declaration)* ';'? '}'
 *   Selector   ::= '*' | '#' Identifier | '.' ClassName | ShapeName
 *   ShapeName  ::= [A-Za-z]+   -- bare identifier matching a DOT shape name
 *   Declaration::= Property ':' PropertyValue
 *
 * Specificity: universal(0) < shape(1) < class(2) < id(3)
 */

export interface StyleRule {
  selector: StyleSelector;
  declarations: StyleDeclaration[];
}

export interface StyleSelector {
  type: "universal" | "shape" | "class" | "id";
  value: string; // "*" for universal, class name, shape name, or node id
  shape?: string; // populated when type is "shape"
  specificity: number;
}

export interface StyleDeclaration {
  property: string;
  value: string;
}

export class StylesheetParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StylesheetParseError";
  }
}

const VALID_PROPERTIES = new Set([
  "llm_model",
  "llm_provider",
  "reasoning_effort",
]);

/** Parse a model stylesheet string into rules */
export function parseStylesheet(source: string): StyleRule[] {
  const trimmed = source.trim();
  if (!trimmed) return [];

  const rules: StyleRule[] = [];
  let pos = 0;

  const skipWs = () => {
    while (pos < trimmed.length && /\s/.test(trimmed[pos]!)) pos++;
  };

  const readUntil = (ch: string): string => {
    const start = pos;
    while (pos < trimmed.length && trimmed[pos] !== ch) pos++;
    return trimmed.slice(start, pos);
  };

  while (pos < trimmed.length) {
    skipWs();
    if (pos >= trimmed.length) break;

    // Parse selector
    const selector = parseSelector();
    skipWs();

    // Expect '{'
    if (trimmed[pos] !== "{") {
      throw new StylesheetParseError(
        `Expected '{' after selector, got '${trimmed[pos]}'`,
      );
    }
    pos++; // skip {

    // Parse declarations
    const declarations: StyleDeclaration[] = [];
    skipWs();
    while (pos < trimmed.length && trimmed[pos] !== "}") {
      skipWs();
      if (pos < trimmed.length && trimmed[pos] === "}") break;

      const property = readUntil(":").trim();
      if (trimmed[pos] !== ":") {
        throw new StylesheetParseError(`Expected ':' after property '${property}'`);
      }
      pos++; // skip :

      // Read value until ; or }
      let value = "";
      while (
        pos < trimmed.length &&
        trimmed[pos] !== ";" &&
        trimmed[pos] !== "}"
      ) {
        value += trimmed[pos];
        pos++;
      }
      value = value.trim();

      if (property && value) {
        declarations.push({ property, value });
      }

      if (pos < trimmed.length && trimmed[pos] === ";") pos++; // skip ;
      skipWs();
    }

    if (pos < trimmed.length && trimmed[pos] === "}") pos++; // skip }

    rules.push({ selector, declarations });
  }

  return rules;

  function parseSelector(): StyleSelector {
    skipWs();
    const ch = trimmed[pos]!;
    if (ch === "*") {
      pos++;
      return { type: "universal", value: "*", specificity: 0 };
    }
    if (ch === ".") {
      pos++;
      let name = "";
      while (pos < trimmed.length && /[a-z0-9_-]/i.test(trimmed[pos]!)) {
        name += trimmed[pos];
        pos++;
      }
      return { type: "class", value: name, specificity: 2 };
    }
    if (ch === "#") {
      pos++;
      let name = "";
      while (pos < trimmed.length && /[A-Za-z0-9_]/.test(trimmed[pos]!)) {
        name += trimmed[pos];
        pos++;
      }
      return { type: "id", value: name, specificity: 3 };
    }
    // Bare identifier → shape selector
    if (/[A-Za-z]/.test(ch)) {
      let name = "";
      while (pos < trimmed.length && /[A-Za-z]/.test(trimmed[pos]!)) {
        name += trimmed[pos];
        pos++;
      }
      return { type: "shape", value: name, shape: name, specificity: 1 };
    }
    throw new StylesheetParseError(`Invalid selector character '${ch}'`);
  }
}

/** Validate stylesheet syntax. Returns null if valid, error message if not. */
export function validateStylesheetSyntax(source: string): string | null {
  try {
    parseStylesheet(source);
    return null;
  } catch (err) {
    return String(err);
  }
}

/**
 * Apply stylesheet rules to a node, returning resolved properties.
 * Only sets properties that the node doesn't already have explicitly.
 */
export function resolveStyleProperties(
  rules: StyleRule[],
  nodeId: string,
  nodeClasses: string[],
  nodeShape?: string,
): Record<string, string> {
  // Collect matching rules with specificity
  const matches: { specificity: number; index: number; decl: StyleDeclaration }[] = [];

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    const sel = rule.selector;
    let matched = false;

    if (sel.type === "universal") {
      matched = true;
    } else if (sel.type === "shape" && nodeShape && sel.shape === nodeShape) {
      matched = true;
    } else if (sel.type === "class" && nodeClasses.includes(sel.value)) {
      matched = true;
    } else if (sel.type === "id" && sel.value === nodeId) {
      matched = true;
    }

    if (matched) {
      for (const decl of rule.declarations) {
        matches.push({ specificity: sel.specificity, index: i, decl });
      }
    }
  }

  // Sort by specificity ascending, then by index ascending
  // Later (higher specificity or same specificity + later) overrides
  matches.sort((a, b) => {
    if (a.specificity !== b.specificity) return a.specificity - b.specificity;
    return a.index - b.index;
  });

  // Build result (later entries override)
  const result: Record<string, string> = {};
  for (const m of matches) {
    result[m.decl.property] = m.decl.value;
  }

  return result;
}
