# Attractor CLI Reference

## Synopsis

```
attractor <command> [options]
```

## Commands

### `attractor run`

Execute a pipeline from a DOT file.

```
attractor run <file.dot> [options]
```

**Options:**

| Flag                  | Description |
|-----------------------|-------------|
| `--simulate`          | Run in simulation mode (no LLM calls). Stages return canned responses. |
| `--auto-approve`      | Auto-approve all human gates (selects the first option). |
| `--logs-dir <path>`   | Output directory for logs and checkpoints. Default: `.attractor-runs/<timestamp>`. |
| `--provider <name>`   | LLM provider. Default: `anthropic`. |
| `--model <id>`        | LLM model ID. Default: `claude-sonnet-4-5-20250929`. |
| `--set <key=value>`   | Set a pipeline variable. Repeatable. Overrides defaults from `graph[vars]`. |
| `--verbose`           | Show detailed event output (checkpoint saves, stage completions, agent events). |

**Examples:**

```bash
# Run a pipeline
attractor run workflow.dot

# Dry run without LLM calls
attractor run workflow.dot --simulate

# Override pipeline variables
attractor run deploy.dot --set feature=auth --set env=production

# Use a specific model
attractor run workflow.dot --provider openai --model gpt-5.2

# Verbose output with custom log directory
attractor run workflow.dot --verbose --logs-dir ./logs/run-001

# Auto-approve human gates (for CI/CD)
attractor run workflow.dot --auto-approve
```

**Output:**

```
Pipeline: MyWorkflow
Goal: Implement the feature
Nodes: 6
Edges: 7
---
[10:30:01] Pipeline started: MyWorkflow
[10:30:01] Stage 1: plan
[10:30:15] Stage 2: implement
[10:30:45] Stage 3: validate
[10:31:02] Stage 4: review

---
Result: success
Completed: plan -> implement -> validate -> review
Logs: .attractor-runs/1707654601000
```

When execution reaches a human gate, the CLI presents choices interactively:

```
[10:30:45] Human gate: Review Changes
  [A] Approve
  [F] Fix
  [R] Reject
Select:
```

### `attractor validate`

Check a DOT file for errors without executing it.

```
attractor validate <file.dot>
```

**Output on success:**

```
Valid pipeline: MyWorkflow (6 nodes, 7 edges)
```

**Output on error:**

```
ERRORS:
  [start_node] Pipeline must have exactly one start node
  [reachability] Node "orphan_node" is not reachable from start
WARNINGS:
  [prompt_on_llm_nodes] Node "plan" has no prompt attribute
```

Exit code 1 on validation errors.

### `attractor serve`

Start an HTTP server for web-based pipeline management.

```
attractor serve [options]
```

**Options:**

| Flag              | Description |
|-------------------|-------------|
| `--port <number>` | Port to listen on. Default: `3000`. |
| `--host <addr>`   | Host to bind to. Default: `127.0.0.1`. |

**Endpoints:**

| Method | Path              | Description |
|--------|-------------------|-------------|
| `POST` | `/run`            | Start a pipeline. JSON body: `{ "dotSource": "..." }`. |
| `GET`  | `/status/:id`     | Get run status. |
| `POST` | `/answer/:id`     | Submit a human-in-the-loop answer. |
| `GET`  | `/events/:id`     | SSE event stream. |

## General Options

| Flag          | Description |
|---------------|-------------|
| `--help`, `-h` | Show help. |

## Run Directory

Each `attractor run` creates a log directory (default: `.attractor-runs/<timestamp>/`) containing:

```
.attractor-runs/1707654601000/
    checkpoint.json              # Serialized checkpoint after each node
    manifest.json                # Pipeline metadata (name, goal, start time)
    plan/
        prompt.md                # Rendered prompt sent to LLM
        response.md              # LLM response text
        status.json              # Node execution outcome
    implement/
        prompt.md
        response.md
        status.json
    artifacts/
        {artifact_id}.json       # File-backed artifacts
```

## Environment Variables

| Variable                  | Description |
|---------------------------|-------------|
| `ATTRACTOR_COMMANDS_PATH` | Comma-separated directories to search for `/command` prompt files (in addition to `.attractor/commands/`). |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0    | Success. |
| 1    | Validation error, execution failure, or missing file. |
