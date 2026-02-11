<!-- beads-agent-instructions-v1 -->

# Beads Issue Tracking

This project uses `br` (beads_rust) for issue tracking and `bv` (beads_viewer) for analysis. Issues are stored in `.beads/` and tracked in git.

## Quick Reference

| Task | Command |
| ---- | ------- |
| What to work on next | `bv --robot-next` |
| What to work on next in this epic | `br ready --parent <epic-id> --recursive --json` |
| View issue details | `br show <id>` |
| Claim an issue | `br update <id> --status=in_progress` |
| Complete an issue | `br close <id>` |
| Create an issue | `br create "Title" --type=task --priority=2` |
| Search issues | `bv --search "query"` |
| Plan parallel work | `bv --robot-plan` |
| Sync before commit | `br sync --flush-only` |

## Workflow

1. **Start**: pick the highest leverage task from the list of issues you get from:
    - `br ready --parent <epic-id> --recursive --json` - if you have an epic id.
    - `bv --robot-next` - if you don't have an epic id.
2. **Claim**: `br update <id> --status=in_progress`
3. **Work**: Implement the task
4. **Complete**: `br close <id>`
5. **Sync**: `br sync --flush-only` before committing

## Creating Issues

```bash
# Basic task
br create "Implement feature X" --type=task --priority=1

# Task under an epic
br create "Implement feature X" --type=task --priority=1 --parent=<epic-id>

# With markdown description
br create "Implement feature X" --type=task --priority=1 -d "$(cat <<'EOF'
## What to implement
- Item one
- Item two

## How to test
Run `cargo test`
EOF
)"

# Add blocking dependency: A is blocked BY B (A cannot start until B is done)
br dep add <A> <B>

# Add related link (no blocking, just informational)
br dep add <A> <B> --type=related

# Link to external system (GitHub, Jira, etc.)
br create "Fix bug" --type=bug --external-ref="github:org/repo#123"

# Close multiple issues at once
br close <id1> <id2> <id3>
```

**Gotchas:**
- Title is POSITIONAL: `br create "Title"` not `--title="Title"`
- Dependencies: `br dep add A B` means "A is blocked by B"

**Priority**: 0=critical, 1=high, 2=medium, 3=low, 4=backlog (use numbers, not words)

**Issue Types**: task, bug, feature, epic, question, docs

**Dep Types**: blocks, parent-child, conditional-blocks, waits-for, related, discovered-from, replies-to, relates-to, duplicates, supersedes, caused-by

## Staying on Target

When you discover problems while working on a task, resist the urge to fix them immediately. File an issue and stay focused.

**File an issue when you find:**

- Bugs unrelated to your current task
- Code that "should be refactored"
- Missing tests or documentation
- Tech debt or cleanup opportunities

**Fix immediately only if:**

- It directly blocks your current task
- It's a 1-2 line fix in code you're already touching
- Leaving it would break the build

```bash
# Quick capture: what you found and where you found it
br q "Auth token not validated in /api/users" --type=bug
br dep add <new-issue> <current-task> --type=discovered-from
```

Capture *what* and *where*. Let triage decide *how important*.

## Viewing the Plan

```bash
br epic status          # Progress by epic
br show <id>            # Full task description
br dep tree <id>        # Dependency visualization
bv --robot-insights     # Graph analysis (bottlenecks, critical paths)
```

## Debugging the Daemon

### Log Locations

| Mode | Location |
| ---- | -------- |
| Foreground | stderr |
| Detached (`--detach`) | `~/Library/Logs/daisey/daemon.log` and `daemon.err` |

Log level is controlled by `logging.level` in config (default: "info").

### Key Log Patterns

**Startup issues:**
- `"Daemon starting"` - daemon is initializing
- `"Daemon already running"` - another instance exists
- `"Failed to open database"` - database initialization failed

**Request tracing:**
- `"request{method=GET uri=/search...}: started"` - HTTP request received
- `"request{...}: finished latency=Xms status=200"` - request completed
- Look for the request span to trace the full request lifecycle

**Hot reload issues:**
- `"Config file changed, reloading"` - config change detected
- `"Config reloaded successfully sources=N"` - reload succeeded
- `"Invalid config, keeping previous"` - config parse error

**Errors:**
- `"Bad request (400)"` - client sent invalid input
- `"Not found (404)"` - requested resource doesn't exist
- `"Internal server error (500)"` - server-side failure
- `"Search failed"` - search operation error

### Debug Workflow

**For development/testing** - run in foreground:
```bash
cargo run --release -- daemon
```
Logs go to stderr. Ctrl+C to stop.

**For production issues** with a detached daemon:
1. Check daemon is running: `daisey status`
2. Tail logs: `tail -f ~/Library/Logs/daisey/daemon.log`
3. Reproduce the issue and note timestamps
4. Search logs for request span or error messages
5. Look for warnings/errors in that timeframe

### Increasing Verbosity

Set `logging.level = "debug"` in your config file for detailed logs including:
- File watcher events
- Pipeline worker activity
- Database operations

## Code Quality

All checks must pass before committing:

```bash
# Linting (auto-fixes issues)
cargo clippy --workspace --tests --allow-dirty --fix

# Formatting
cargo fmt --all

# Testing
cargo test --workspace  -- --include-ignored
```

## Session End Checklist

```bash
git status
cargo clippy --workspace --tests --allow-dirty --fix
cargo fmt --all
cargo test --workspace  -- --include-ignored
br sync --flush-only
git add .beads
git add <files>
git commit -m "..."
```

<!-- end-beads-agent-instructions -->
