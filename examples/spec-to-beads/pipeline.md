---
description: Break an RFC into an implementation epic with beads issues
argument-hint: "<path-to-rfc.md>"
---

Plan and file a beads epic that implements $ARGUMENTS from the current codebase state.

## Phase 1: Understand

- Read the RFC thoroughly.
- Read other docs in the same directory for architectural context (skim, don't deep-dive).
- Explore the codebase areas the RFC touches: find the structs, traits, modules, and wiring points that will change. Note file paths and line numbers.

## Phase 2: Decompose

Break the RFC into implementation steps. Iterate on granularity until each step is:
- **Small enough** to be implemented safely with strong tests and no big complexity jumps.
- **Big enough** to move the project forward — not just boilerplate.
- **Self-contained** — testable in isolation, no orphaned or dead code.
- **Builds on the previous** — each step integrates into what came before.

Identify which steps can run in parallel (no shared dependencies) and which form a critical path.

## Phase 3: File issues

Create a beads issue for each step. Every issue must include:

1. **What**: one-paragraph summary of the deliverable.
2. **RFC quotes**: the specific RFC sections this issue implements (block-quoted).
3. **Location**: file paths and line numbers of code to create or modify.
4. **Current code state**: what exists today that's relevant (structs, traits, methods, their signatures).
5. **Implementation approach**: enough guidance that an implementer doesn't need to re-derive the design, but not so much that it's writing the code.
6. **Tests**: concrete test cases (not vague "add tests"). Name the scenarios and expected outcomes.

Wire up dependency edges with `br dep add`. Collect all issues under a new epic.

The **final issue** must be an end-to-end demo script that:
- Tells realistic user stories exercising every feature of the epic.
- Makes concrete assertions (exit codes, log patterns, CLI output).
- Documents how to control test conditions (e.g. mock files, env vars, short timeouts).

## Phase 4: Review

Re-read every issue in dependency order. For each, mentally trace from the previous issue's output to this issue's starting point. Flag:

- **RFC gaps**: any RFC section not covered by an issue.
- **Ambiguity or large jumps**: missing intermediate steps, implicit assumptions, hidden dependencies between issues.
- **Redundancy**: work duplicated across issues or code that will be written then immediately rewritten.

Apply unambiguous fixes directly. Present choices to the user for anything with multiple valid options.

Run `br sync --flush-only` when done.
