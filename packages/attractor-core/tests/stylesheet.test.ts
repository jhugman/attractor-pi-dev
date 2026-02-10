import { describe, it, expect } from "vitest";
import {
  parseStylesheet,
  resolveStyleProperties,
  validateStylesheetSyntax,
} from "../src/stylesheet/index.js";
import { preparePipeline } from "../src/engine/pipeline.js";

describe("Stylesheet Parser", () => {
  it("parses universal selector", () => {
    const rules = parseStylesheet("* { llm_model: claude-sonnet-4-5; }");
    expect(rules.length).toBe(1);
    expect(rules[0]!.selector.type).toBe("universal");
    expect(rules[0]!.declarations[0]!.property).toBe("llm_model");
    expect(rules[0]!.declarations[0]!.value).toBe("claude-sonnet-4-5");
  });

  it("parses class selector", () => {
    const rules = parseStylesheet(".code { llm_model: claude-opus-4-6; }");
    expect(rules[0]!.selector.type).toBe("class");
    expect(rules[0]!.selector.value).toBe("code");
  });

  it("parses ID selector", () => {
    const rules = parseStylesheet("#review { reasoning_effort: high; }");
    expect(rules[0]!.selector.type).toBe("id");
    expect(rules[0]!.selector.value).toBe("review");
  });

  it("parses multiple rules", () => {
    const rules = parseStylesheet(`
      * { llm_model: sonnet; llm_provider: anthropic; }
      .code { llm_model: opus; }
      #review { reasoning_effort: high; }
    `);
    expect(rules.length).toBe(3);
  });

  it("validates empty stylesheet", () => {
    expect(validateStylesheetSyntax("")).toBeNull();
  });

  it("returns error for invalid stylesheet", () => {
    expect(validateStylesheetSyntax("bad { no-colon }")).not.toBeNull();
  });
});

describe("Style Resolution", () => {
  it("universal applies to all nodes", () => {
    const rules = parseStylesheet("* { llm_model: sonnet; }");
    const props = resolveStyleProperties(rules, "any_node", []);
    expect(props["llm_model"]).toBe("sonnet");
  });

  it("class selector overrides universal", () => {
    const rules = parseStylesheet(`
      * { llm_model: sonnet; }
      .code { llm_model: opus; }
    `);
    const props = resolveStyleProperties(rules, "impl", ["code"]);
    expect(props["llm_model"]).toBe("opus");
  });

  it("ID selector overrides class", () => {
    const rules = parseStylesheet(`
      .code { llm_model: opus; }
      #review { llm_model: gpt-5; }
    `);
    const props = resolveStyleProperties(rules, "review", ["code"]);
    expect(props["llm_model"]).toBe("gpt-5");
  });

  it("specificity: universal < class < ID", () => {
    const rules = parseStylesheet(`
      * { llm_model: sonnet; llm_provider: anthropic; }
      .code { llm_model: opus; llm_provider: anthropic; }
      #critical { llm_model: gpt-5; llm_provider: openai; reasoning_effort: high; }
    `);

    // universal only
    const plan = resolveStyleProperties(rules, "plan", ["planning"]);
    expect(plan["llm_model"]).toBe("sonnet");

    // class match
    const impl = resolveStyleProperties(rules, "impl", ["code"]);
    expect(impl["llm_model"]).toBe("opus");

    // ID match (highest)
    const critical = resolveStyleProperties(rules, "critical", ["code"]);
    expect(critical["llm_model"]).toBe("gpt-5");
    expect(critical["reasoning_effort"]).toBe("high");
  });
});

describe("Stylesheet integration with transforms", () => {
  it("applies stylesheet to nodes during preparePipeline", () => {
    const { graph } = preparePipeline(`
      digraph G {
        graph [
          goal="test",
          model_stylesheet="* { llm_model: claude-sonnet-4-5; llm_provider: anthropic; } .code { llm_model: claude-opus-4-6; } #critical_review { llm_model: gpt-5; llm_provider: openai; reasoning_effort: high; }"
        ]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        plan [label="Plan", class="planning", prompt="Plan"]
        implement [label="Implement", class="code", prompt="Implement"]
        critical_review [label="Critical Review", class="code", prompt="Review"]
        start -> plan -> implement -> critical_review -> exit
      }
    `);

    // plan: gets sonnet from *
    expect(graph.getNode("plan").llmModel).toBe("claude-sonnet-4-5");
    // implement: gets opus from .code
    expect(graph.getNode("implement").llmModel).toBe("claude-opus-4-6");
    // critical_review: gets gpt-5 from #critical_review
    expect(graph.getNode("critical_review").llmModel).toBe("gpt-5");
  });

  it("explicit node attributes override stylesheet", () => {
    const { graph } = preparePipeline(`
      digraph G {
        graph [
          goal="test",
          model_stylesheet="* { llm_model: sonnet; }"
        ]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [prompt="Do A", llm_model="explicit-model"]
        start -> a -> exit
      }
    `);

    expect(graph.getNode("a").llmModel).toBe("explicit-model");
  });
});
