# Attractor Cookbook

Practical recipes for common AI workflow patterns.

## Pipeline Layout

```
my-pipeline/
    pipeline.dot                # Pipeline definition
    prompts/                    # @path prompt files (relative to .dot file)
        plan.md
        implement.md
    commands/                   # /command files (also searched in .attractor/commands/)
        careful-review.md
```

A project can have several pipelines, each in its own directory. Add `.attractor-runs/` to your `.gitignore` -- that's where run logs go.

## 1. Simple Linear Pipeline

A straightforward sequence of LLM tasks.

```dot
digraph WriteTests {
    graph [goal="Write unit tests for the auth module"]
    rankdir=LR

    start [shape=Mdiamond]
    exit  [shape=Msquare]

    analyze [label="Analyze", prompt="Read the auth module and identify untested code paths"]
    write   [label="Write Tests", prompt="Write unit tests for the identified code paths"]
    review  [label="Review", prompt="Review the tests for correctness and coverage"]

    start -> analyze -> write -> review -> exit
}
```

```bash
attractor run write-tests.dot
```

## 2. Implement-Validate Loop

A coding loop that retries implementation until tests pass.

```dot
digraph ImplementLoop {
    graph [goal="Implement and validate a feature"]
    rankdir=LR
    node [shape=box, timeout="900s"]

    start     [shape=Mdiamond]
    exit      [shape=Msquare]

    plan      [label="Plan", prompt="Plan the implementation of $goal"]
    implement [label="Implement", prompt="Implement the plan", goal_gate=true]
    validate  [label="Validate", prompt="Run the test suite"]
    gate      [shape=diamond, label="Tests pass?"]

    start -> plan -> implement -> validate -> gate
    gate -> exit      [condition="outcome=success"]
    gate -> implement [condition="outcome!=success", label="Retry"]
}
```

The `goal_gate=true` on `implement` means the pipeline cannot exit until implementation succeeds. If validation fails, the conditional routes back to `implement`.

## 3. Human Approval Gate

Pause for human review before proceeding.

```dot
digraph DeployWithApproval {
    graph [goal="Deploy with human approval"]
    rankdir=LR

    start [shape=Mdiamond]
    exit  [shape=Msquare]

    prepare [label="Prepare", prompt="Prepare the deployment package"]
    review  [shape=hexagon, label="Review Deployment"]
    deploy  [label="Deploy", prompt="Deploy the package to production"]
    fix     [label="Fix Issues", prompt="Address the review feedback"]

    start -> prepare -> review
    review -> deploy [label="[A] Approve"]
    review -> fix    [label="[F] Fix"]
    deploy -> exit
    fix -> review
}
```

The human sees:

```
[?] Review Deployment
  [A] Approve
  [F] Fix
Select:
```

Pressing `A` proceeds to deploy; pressing `F` loops through fixes.

## 4. Parameterized Pipeline

Use variables to make pipelines reusable.

```dot
digraph Deploy {
    graph [
        goal="Deploy $service to $env",
        vars="service, env=staging, region=us-east-1"
    ]
    rankdir=LR

    start  [shape=Mdiamond]
    exit   [shape=Msquare]

    build  [label="Build $service", prompt="Build the $service service for $env"]
    test   [label="Test", prompt="Run integration tests for $service in $region"]
    deploy [label="Deploy to $env", prompt="Deploy $service to $env in $region"]

    start -> build -> test -> deploy -> exit
}
```

```bash
# Uses defaults: env=staging, region=us-east-1
attractor run deploy.dot --set service=api

# Override all variables
attractor run deploy.dot --set service=api --set env=production --set region=eu-west-1
```

## 5. Multi-Model Pipeline

Use different LLM models for different stages via the model stylesheet.

```dot
digraph MultiModel {
    graph [
        goal="Implement with specialized models",
        model_stylesheet="
            * { llm_model: claude-sonnet-4-5; llm_provider: anthropic; }
            .code { llm_model: claude-opus-4-6; reasoning_effort: high; }
            .fast { llm_model: claude-haiku-4-5; reasoning_effort: low; }
        "
    ]
    rankdir=LR

    start [shape=Mdiamond]
    exit  [shape=Msquare]

    plan      [label="Plan", class="fast", prompt="Outline the approach"]
    implement [label="Implement", class="code", prompt="Write the implementation"]
    review    [label="Review", class="code", prompt="Review for correctness"]
    summarize [label="Summarize", class="fast", prompt="Write a summary of changes"]

    start -> plan -> implement -> review -> summarize -> exit
}
```

- `plan` and `summarize` use Haiku (fast, cheap).
- `implement` and `review` use Opus (capable, thorough).

## 6. Retry with Backoff

Automatically retry flaky stages.

```dot
digraph RetryExample {
    graph [goal="Process data reliably"]
    rankdir=LR

    start [shape=Mdiamond]
    exit  [shape=Msquare]

    fetch   [label="Fetch Data", prompt="Fetch data from the API", max_retries=3]
    process [label="Process", prompt="Transform the data", max_retries=1]
    store   [label="Store", prompt="Write results to the database"]

    start -> fetch -> process -> store -> exit
}
```

`fetch` retries up to 3 additional times (4 total) with exponential backoff. `process` retries once.

## 7. Goal Gate with Retry Target

Ensure a critical stage succeeds, routing back to an earlier stage if it hasn't by exit time.

```dot
digraph GoalGateExample {
    graph [goal="Ship tested code"]
    rankdir=LR

    start [shape=Mdiamond]
    exit  [shape=Msquare]

    plan      [label="Plan", prompt="Plan the changes"]
    implement [label="Implement", prompt="Write the code"]
    test      [
        label="Test",
        prompt="Run all tests",
        goal_gate=true,
        retry_target="implement"
    ]
    gate [shape=diamond, label="Tests pass?"]

    start -> plan -> implement -> test -> gate
    gate -> exit      [condition="outcome=success"]
    gate -> implement [condition="outcome!=success"]
}
```

If the pipeline reaches `exit` but `test` hasn't recorded a SUCCESS, the engine jumps back to `implement` instead of exiting.

## 8. External Tool Execution

Run shell commands as pipeline stages.

```dot
digraph ToolExample {
    graph [goal="Build and test"]
    rankdir=LR

    start [shape=Mdiamond]
    exit  [shape=Msquare]

    build     [shape=parallelogram, label="Build", tool_command="npm run build"]
    run_tests [shape=parallelogram, label="Test", tool_command="npm test"]
    report    [label="Report", prompt="Summarize the build and test results"]

    start -> build -> run_tests -> report -> exit
}
```

Tool nodes use `shape=parallelogram` and the `tool_command` attribute.

## 9. Shared Context Between Stages

Use `full` fidelity and `thread_id` to keep LLM conversation context across stages.

```dot
digraph SharedContext {
    graph [goal="Iterative development"]
    rankdir=LR

    start [shape=Mdiamond]
    exit  [shape=Msquare]

    plan      [label="Plan", prompt="Plan the approach", fidelity="full", thread_id="main"]
    implement [label="Implement", prompt="Now implement the plan", fidelity="full", thread_id="main"]
    refine    [label="Refine", prompt="Improve the implementation", fidelity="full", thread_id="main"]

    start -> plan -> implement -> refine -> exit
}
```

All three stages share the same LLM session (`thread_id="main"`), so `implement` sees the plan and `refine` sees both.

With a subgraph, this is cleaner:

```dot
subgraph cluster_dev {
    label = "Development"
    node [fidelity="full", thread_id="dev"]

    plan      [label="Plan", prompt="Plan the approach"]
    implement [label="Implement", prompt="Now implement the plan"]
    refine    [label="Refine", prompt="Improve the implementation"]
}
```

## 10. Prompt Files

Keep large prompts in separate files.

```
workflows/
    build.dot
    prompts/
        plan.md
        implement.md
        review.md
```

```dot
digraph Build {
    graph [goal="Build the feature"]
    rankdir=LR

    start [shape=Mdiamond]
    exit  [shape=Msquare]

    plan      [label="Plan", prompt="@prompts/plan.md"]
    implement [label="Implement", prompt="@prompts/implement.md"]
    review    [label="Review", prompt="@prompts/review.md"]

    start -> plan -> implement -> review -> exit
}
```

`@` paths are relative to the DOT file's directory.

## 11. Reusable Commands

Store prompt templates in `.attractor/commands/` and reference them with `/command`.

```
.attractor/
    commands/
        implement.md
        review.md
        my/
            careful-review.md
```

`.attractor/commands/implement.md`:
```markdown
Implement the following feature: $goal

Requirements:
- Write clean, tested code
- Follow existing patterns in the codebase
- Priority: $priority
```

```dot
digraph WithCommands {
    graph [
        goal="Add user authentication",
        vars="priority=high"
    ]

    start     [shape=Mdiamond]
    exit      [shape=Msquare]
    implement [label="Implement", prompt="/implement"]
    review    [label="Review", prompt="/my:careful-review"]

    start -> implement -> review -> exit
}
```

## 12. Branching with Human Triage

Use a human gate to route work to different paths.

```dot
digraph HumanTriage {
    graph [goal="Triage and handle incoming work"]
    rankdir=LR

    start [shape=Mdiamond]
    exit  [shape=Msquare]

    analyze [label="Analyze", prompt="Analyze the issue and summarize it"]
    triage  [shape=hexagon, label="What kind of work is this?"]

    handle_bug     [label="Fix Bug", prompt="Fix the identified bug"]
    handle_feature [label="Build Feature", prompt="Implement the feature"]
    handle_refactor [label="Refactor", prompt="Refactor the identified code"]

    start -> analyze -> triage
    triage -> handle_bug      [label="[B] Bug fix"]
    triage -> handle_feature  [label="[F] Feature"]
    triage -> handle_refactor [label="[R] Refactor"]

    handle_bug -> exit
    handle_feature -> exit
    handle_refactor -> exit
}
```

The human reads the analysis summary and chooses how to route. For fully automated branching, use outcome-based conditions:

```dot
// Route on outcome status (available after every node)
gate -> next  [condition="outcome=success"]
gate -> retry [condition="outcome=fail"]

// Route on tool output (available after parallelogram nodes)
test -> pass [condition="tool.output contains \"PASS\""]
test -> fail [condition="tool.output contains \"FAIL\""]

// Use weights for priority fallbacks (no conditions needed)
route -> preferred [weight=10]
route -> fallback  [weight=1]
```

Context keys are a fixed set determined by the handlers -- see the language spec for the complete list. You cannot set arbitrary context keys from the DOT file or via LLM responses.

## 13. Simulation Mode

Test pipeline structure without making LLM calls.

```bash
# Validate the graph structure
attractor validate workflow.dot

# Run with simulated LLM responses
attractor run workflow.dot --simulate

# Simulate with verbose output to see every event
attractor run workflow.dot --simulate --verbose
```

Simulation mode replaces LLM calls with `[Simulated] Response for stage: {node_id}`. The pipeline executes normally otherwise -- edge conditions are evaluated, human gates are presented (unless `--auto-approve`), and checkpoints are saved.

## 14. CI/CD Integration

Run pipelines in automated environments.

```bash
# Fully automated: no human interaction, simulated LLM
attractor run workflow.dot --simulate --auto-approve

# With real LLM but auto-approved gates
attractor run workflow.dot --auto-approve --logs-dir ./ci-logs/$BUILD_ID

# Validate in CI before merge
attractor validate workflow.dot || exit 1
```

## 15. Combining Patterns

A production-grade pipeline combining multiple techniques.

```dot
digraph ProductionPipeline {
    graph [
        goal="Implement $feature with full validation",
        vars="feature, branch=main, test_cmd=npm test",
        model_stylesheet="
            * { llm_model: claude-sonnet-4-5; llm_provider: anthropic; }
            .heavy { llm_model: claude-opus-4-6; reasoning_effort: high; }
            .fast { llm_model: claude-haiku-4-5; reasoning_effort: low; }
        "
    ]
    rankdir=LR

    start [shape=Mdiamond]
    exit  [shape=Msquare]

    // Planning phase (fast model)
    plan [label="Plan", class="fast", prompt="@prompts/plan.md"]

    // Implementation phase (heavy model, shared context)
    subgraph cluster_impl {
        label = "Implementation"
        node [fidelity="full", thread_id="impl", class="heavy"]

        implement [label="Implement", prompt="@prompts/implement.md", goal_gate=true]
        refine    [label="Refine", prompt="Refine based on test results"]
    }

    // Validation
    run_tests [shape=parallelogram, label="Run Tests", tool_command="$test_cmd"]
    check     [shape=diamond, label="Tests pass?"]

    // Human review
    review [shape=hexagon, label="Review Changes"]
    fixup  [label="Fix Issues", class="heavy", prompt="Address review feedback"]

    // Summary (fast model)
    summarize [label="Summarize", class="fast", prompt="Write a changelog entry"]

    start -> plan -> implement -> run_tests -> check
    check -> review       [condition="outcome=success"]
    check -> refine       [condition="outcome!=success"]
    refine -> run_tests

    review -> summarize [label="[A] Approve"]
    review -> fixup     [label="[F] Fix"]
    fixup -> review

    summarize -> exit
}
```

```bash
attractor run production.dot --set feature="user-authentication" --set test_cmd="pytest -x"
```
