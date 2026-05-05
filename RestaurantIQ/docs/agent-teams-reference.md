# Claude Code Agent Teams — Master Reference Guide

> Built from official docs at `code.claude.com/docs/en/agent-teams` plus research.  
> Purpose: help build better, more effective agent teams in future sessions.

---

## Quick Start

```json
// .claude/settings.local.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

Requires Claude Code **v2.1.32 or later**. Check with `claude --version`.

Spawn a team in natural language:

```
Create an agent team to review this PR from three angles:
one focused on security, one on performance, one on test coverage.
```

---

## Architecture

| Component | Role |
|-----------|------|
| **Team Lead** | The original session. Creates the team, spawns teammates, coordinates work, synthesizes results. Fixed for the team's lifetime — cannot be transferred. |
| **Teammates** | Independent Claude Code sessions. Each has its own context window. Work on assigned tasks and communicate directly with each other. |
| **Task List** | Shared queue with states: pending → in progress → completed. Tasks can block other tasks. File-locked to prevent race conditions. |
| **Mailbox** | Async messaging between any agents. Messages deliver automatically — no polling needed. |

**Storage locations (auto-managed, do not hand-edit):**
- Team config: `~/.claude/teams/{team-name}/config.json`
- Tasks: `~/.claude/tasks/{team-name}/`

The `members` array in team config holds each teammate's name, agent ID, and agent type — teammates can read this to discover each other.

---

## Agent Teams vs Subagents

| | Subagents | Agent Teams |
|---|---|---|
| Context | Own window; results return to caller | Own window; fully independent |
| Communication | Report to main agent only | Teammates message each other directly |
| Coordination | Main agent manages all work | Shared task list, self-coordination |
| Token cost | Lower (results summarized back) | Higher (each teammate = full Claude instance) |
| Best for | Focused tasks where only the result matters | Complex work requiring discussion and collaboration |

**Rule of thumb:** use subagents when workers don't need to talk to each other. Use agent teams when teammates need to share findings, challenge each other, or coordinate independently.

---

## When to Use Agent Teams

### Strong Use Cases

- **Parallel research/review** — multiple teammates investigate different aspects simultaneously
- **New modules/features** — each teammate owns a separate piece with no file overlap
- **Debugging with competing hypotheses** — teammates test different theories in parallel and converge
- **Cross-layer coordination** — frontend, backend, tests each owned by a different teammate
- **Adversarial investigation** — teammates actively try to disprove each other's theories

### Weak Use Cases (use single session or subagents instead)

- Sequential tasks (work depends on prior work completing)
- Same-file edits (causes overwrites)
- Many tight dependencies between pieces of work
- Routine or small tasks (coordination overhead exceeds benefit)
- Cost-sensitive work (each teammate is a full Claude instance)

---

## Display Modes

### In-Process (default, works everywhere)

All teammates run inside the main terminal.

| Key | Action |
|-----|--------|
| `Shift+Down` | Cycle through teammates (wraps back to lead) |
| `Enter` | Open selected teammate's full session |
| `Escape` | Return from focused session to cycling view |
| `Ctrl+T` | Toggle task list |

### Split Panes (requires tmux or iTerm2)

Each teammate gets its own pane. See all outputs simultaneously. Click to interact.

**Requirements:**
- tmux: `brew install tmux` / `apt-get install tmux`
- iTerm2: install `it2` CLI, enable Python API in iTerm2 → Settings → General → Magic

**Configure:**
```json
// ~/.claude/settings.json
{ "teammateMode": "in-process" }  // or "tmux", "auto" (default)
```

Or per-session: `claude --teammate-mode in-process`

**Auto mode:** uses split panes if already in a tmux session, in-process otherwise.

**Not supported** in VS Code integrated terminal, Windows Terminal, or Ghostty.

---

## Task Management

### Task States

```
pending → in progress → completed
           ↑
        blocked (unresolved dependencies — auto-unblocks when deps complete)
```

### Claiming Work

- **Lead assigns**: explicitly tell lead which task goes to which teammate
- **Self-claim**: after finishing, a teammate picks up the next unassigned, unblocked task autonomously

File locking prevents two teammates from claiming the same task simultaneously.

### Good Task Sizing

- **Too small**: coordination overhead exceeds the benefit
- **Too large**: teammate works too long without check-ins, risk of wasted effort
- **Target**: self-contained units with a clear deliverable (a function, a test file, a review category)

**Team sizing formula:** 5–6 tasks per teammate. 15 independent tasks → 3 teammates.

---

## Communication Patterns

### Teammate → Lead
Delivered automatically when a teammate sends a message. Lead doesn't poll.

### Lead → Teammate
```
Message the [name] teammate: "..."
```

### Teammate → Teammate
Any teammate can message any other by name. The lead assigns names at spawn time — specify names explicitly in your prompt if you need to reference them later.

### Broadcast
No broadcast tool — send individual messages to each recipient.

### Idle Notifications
When a teammate finishes and stops, it automatically notifies the lead.

---

## Spawning & Context

### What Teammates Load Automatically
- CLAUDE.md files from working directory
- MCP servers (from project/user settings)
- Skills (from project/user settings)

### What Teammates Do NOT Get
- Lead's conversation history
- Lead's session context

**This is the most important thing to get right.** Teammates start with only their spawn prompt + project context. Put all task-specific details, constraints, and relevant background directly in the spawn prompt.

### Spawn Prompt Template

```
Spawn a [role] teammate with this prompt:

"[Role description and perspective]

Task: [specific what to do]
Location: [file paths or areas to focus on]
Context: [key facts they'd need to know, that aren't in CLAUDE.md]
Constraints: [any rules, conventions, or limits]
Output format: [how to report findings or what to produce]
[If cross-teammate coordination needed]: Message [other teammate name] if you find X"
```

### Specifying Models

```
Create a team with 4 teammates. Use Haiku for the explorers, Sonnet for the implementers.
```

---

## Subagent Definitions as Teammates

You can reuse subagent definitions as teammate roles.

```
Spawn a teammate using the security-reviewer agent type to audit the auth module.
```

**What carries over from the definition:**
- `tools` allowlist (enforced)
- `model` (used)
- Body/prompt (appended to teammate's system prompt as additional instructions)
- `hooks`, `permissionMode`, `effort`, `maxTurns`, `isolation`, `background`

**What does NOT carry over:**
- `skills` frontmatter — teammates load skills from project/user settings like any regular session
- `mcpServers` frontmatter — same, loaded from settings not the definition

**Team coordination tools (`SendMessage`, task management) are always available to teammates**, even when the `tools` field restricts other tools.

### Example Subagent Definition for Teams

```markdown
---
name: security-reviewer
description: Security-focused auditor for auth, data protection, and input validation
tools: Read, Grep, Glob, Bash
model: claude-sonnet-4-6
---

You are a senior security architect. When auditing code:
1. Focus on authentication and authorization flows
2. Check for SQL injection, XSS, CSRF
3. Verify cryptography usage and key management
4. Validate input sanitization at system boundaries
5. Review access control implementations

Rate findings: CRITICAL (fix now), HIGH (high risk), MEDIUM (should fix), LOW (consider).
Provide specific remediation steps for each issue.
```

---

## Plan Approval for Teammates

For risky or complex tasks, require teammates to plan before implementing:

```
Spawn an architect teammate to refactor the authentication module.
Require plan approval before they make any changes.
```

**Flow:**
1. Teammate works in read-only plan mode
2. Sends plan approval request to lead
3. Lead reviews and approves or rejects with feedback
4. If rejected → teammate revises and resubmits
5. Once approved → teammate exits plan mode and implements

The lead makes approval decisions autonomously. Influence its judgment in your prompt:
```
Only approve plans that include test coverage and don't modify the database schema.
```

---

## Permissions

- Teammates start with the **lead's permission mode**
- If lead uses `--dangerously-skip-permissions`, all teammates do too
- Can change individual teammate modes **after spawning**
- Cannot set per-teammate modes at spawn time
- Pre-approve common operations in permission settings before spawning to reduce interruptions

---

## Hooks for Agent Teams

Three specialized hook events:

### `TeammateIdle`
Fires when a teammate is about to go idle (no more work).  
Exit code 2 → send feedback and keep teammate working.

```json
{
  "hooks": {
    "TeammateIdle": [{
      "hooks": [{
        "type": "command",
        "command": "echo '{\"systemMessage\": \"Teammate finished. Checking quality gates...\"}'"
      }]
    }]
  }
}
```

### `TaskCreated`
Fires when a task is being created via TaskCreate.  
Exit code 2 → prevent creation and send feedback.

Use for: requiring description fields, preventing duplicate tasks, enforcing task structure.

### `TaskCompleted`
Fires when a task is being marked complete.  
Exit code 2 → prevent completion and send feedback.

Use for: enforcing peer review, requiring test evidence, quality gates before closing.

All three support: `command`, `http`, `mcp_tool`, `prompt`, `agent` hook types. All support `matcher`, `timeout`, `statusMessage`.

---

## Best Practices

### 1. Front-load context in spawn prompts
Teammates have no memory of why the team was created. Spell out: role, task, file locations, relevant constraints, how to report results, who to message if blocked.

### 2. Name teammates explicitly
```
Spawn three teammates named 'security', 'performance', and 'coverage' to review PR #142.
```
Predictable names let you reference them in follow-up messages without ambiguity.

### 3. Aim for 3–5 teammates
Sweet spot for most workflows. Coordination overhead grows faster than throughput beyond this. Three focused teammates often outperform five scattered ones.

### 4. Keep task count at ~5–6 per teammate
Keeps everyone productive without excessive context switching. If work isn't dividing cleanly, ask the lead to split tasks further.

### 5. Prevent file conflicts
Two teammates editing the same file = overwrites. Divide work by file ownership:
- Frontend teammate: `ui/`, `components/`
- Backend teammate: `api/`, `services/`
- Database teammate: `migrations/`, `models/`

### 6. Tell the lead to wait
The lead sometimes starts implementing instead of delegating:
```
Wait for your teammates to complete their tasks before proceeding.
```

### 7. Start with research/review
Clearest boundaries, no file conflict risk, fastest to show value. Graduate to parallel implementation once comfortable with coordination patterns.

### 8. Monitor and steer actively
Don't let a team run unattended for long. Check progress with Shift+Down, redirect approaches that aren't working, synthesize findings incrementally.

### 9. Make tasks adversarial when investigating
For debugging or root cause analysis, instruct teammates to actively try to disprove each other's theories — not just explore their own hypothesis. This eliminates anchoring bias.

### 10. Use CLAUDE.md for shared team guidance
Teammates read CLAUDE.md automatically. Put project-wide conventions, constraints, and context there rather than repeating them in every spawn prompt.

---

## Anti-Patterns

| Anti-Pattern | Problem | Fix |
|---|---|---|
| Vague spawn prompt | Teammate doesn't know what "done" looks like | Include specific deliverables, file paths, and output format |
| Identical work across teammates | Wastes tokens, no benefit | Assign distinct perspectives or file ownership |
| No file ownership plan | Multiple teammates overwrite each other | Divide files before spawning |
| Lead works instead of delegates | Defeats the purpose of the team | Tell lead explicitly to wait for teammates |
| Team size > 7 | Coordination overhead dominates | Keep to 3–5; add more only with genuine justification |
| Circular task dependencies | Deadlock | Review dependency graph before creating tasks |
| Ignoring permission pre-approval | Background agents fail mid-task | Pre-approve required tools before spawning |
| Letting team run unattended | Wasted effort, hard to course-correct | Check in frequently, steer mid-course |

---

## Shutdown & Cleanup

### Graceful teammate shutdown
```
Ask the [name] teammate to shut down.
```
Teammate can accept (exits) or reject with explanation.

### Team cleanup
```
Clean up the team.
```
Removes shared team resources. Fails if any teammates are still active — shut them down first.

**Always use the lead to clean up.** Teammates running cleanup may leave resources in an inconsistent state.

### Orphaned tmux sessions
```bash
tmux ls
tmux kill-session -t <session-name>
```

---

## Troubleshooting

| Problem | Likely Cause | Fix |
|---|---|---|
| Teammates not appearing | In-process: they're running but not visible | Press Shift+Down to cycle |
| Too many permission prompts | Tools not pre-approved | Pre-approve in permission settings before spawning |
| Teammate stops on error | Hit an unrecoverable state | Give direct instructions via Shift+Down, or spawn a replacement |
| Lead shuts down early | Thinks team is finished | Tell it to keep going and wait for all tasks to complete |
| Task appears stuck/blocked | Teammate failed to mark it complete | Manually update task status or ask lead to nudge the teammate |
| Split panes not working | tmux not installed / wrong terminal | Verify with `which tmux`; use in-process mode as fallback |

---

## Limitations (as of May 2026)

| Limitation | Detail |
|---|---|
| No session resumption | `/resume` and `/rewind` don't restore in-process teammates. Tell lead to spawn fresh ones. |
| Task status lag | Teammates sometimes don't mark tasks complete. Check manually if something looks stuck. |
| Slow shutdown | Teammates finish current tool call before shutting down. |
| One team per lead | Clean up current team before starting a new one. |
| No nested teams | Teammates cannot spawn their own teams. Only the lead manages the team. |
| Fixed lead | The session that creates the team is always the lead. Cannot be transferred. |
| Permissions set at spawn | Teammates inherit lead's mode. Can be changed per-teammate after spawning. |
| Split panes: terminal support | tmux and iTerm2 only. Not VS Code integrated terminal, Windows Terminal, or Ghostty. |

---

## Quick Reference: Key Prompts

```
# Create a team
Create an agent team with 3 teammates named 'alpha', 'beta', 'gamma' to [task].

# Use a subagent definition
Spawn a teammate using the security-reviewer agent type to audit src/auth/.

# Require plan approval
Spawn an architect teammate to refactor [module]. Require plan approval before changes.

# Control the lead
Wait for your teammates to complete their tasks before proceeding.
Split this work into at least 8 tasks so teammates can work more granularly.

# Direct teammate message
Message the [name] teammate: "[instructions]"

# Shut down
Ask the [name] teammate to shut down.
Clean up the team.
```

---

## Token Cost Considerations

- Token usage scales **linearly** with active teammates
- Each teammate has its own full context window
- For routine tasks, a single session is more cost-effective
- Optimization strategies:
  - Use Haiku for read-only / research teammates
  - Keep CLAUDE.md concise (loaded by every teammate)
  - Use subagents instead of teams when inter-agent communication isn't needed
  - Shut down teammates as soon as their work is done

---

*Source: [Official docs](https://code.claude.com/docs/en/agent-teams) + claude-code-guide research. Last updated: 2026-05-04.*
