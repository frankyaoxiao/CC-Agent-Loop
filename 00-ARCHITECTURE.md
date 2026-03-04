# Claude Code Internal Agent Loop — Reverse Engineered

Extracted and deobfuscated from `claude` binary v2.1.68 (Bun-compiled ELF, 227MB).

## Call Flow

```
User types input
       │
       ▼
┌─────────────────────┐
│  06-input-handler    │  handleUserInput() / vk$
│  (React component)   │  Parses input, handles /commands, interrupt logic
└──────────┬──────────┘
           │ calls onQuery(messages, abortController, ...)
           ▼
┌─────────────────────┐
│  01-core-agent-loop  │  coreAgentLoop() / fO — async generator
│  THE MAIN LOOP       │  while(true) {
│                      │    1. microcompact (trim individual messages)
│                      │    2. autocompact (summarize if context too long)
│                      │    3. call API (streaming)
│                      │    4. process response content blocks
│                      │    5. if tool_use → execute tools
│                      │    6. collect tool_results
│                      │    7. if no tool_use → return (done)
│                      │    8. loop with [messages + tool_results]
│                      │  }
└──────────┬──────────┘
           │ yields streaming events to UI
           │ calls deps.callModel()
           ▼
┌─────────────────────┐
│  05-api-call         │  callAnthropicAPI() / Yc
│                      │  POST /v1/messages (streaming SSE)
│                      │  anthropic-version: 2023-06-01
│                      │  Handles model selection, betas, prompt caching
└──────────┬──────────┘
           │ returns SSE stream
           ▼
┌─────────────────────┐
│  02-tool-executor    │  ToolExecutor / UiH
│  (concurrent queue)  │  Manages parallel tool execution:
│                      │  - Concurrency-safe tools run in parallel
│                      │  - Non-safe tools run sequentially
│                      │  - Tools start DURING streaming (eager execution)
│                      │  - Sibling error → abort remaining tools
│                      │  - User interrupt → cancel interruptible tools
└──────────┬──────────┘
           │ for each tool_use block
           ▼
┌─────────────────────┐
│  03-tool-call-handler│  toolCallHandler() / tcH — async generator
│  (per-tool dispatch) │  For each tool:
│                      │    1. Resolve tool definition
│                      │    2. Validate input (Zod schema)
│                      │    3. Check permissions (ask/allow/deny)
│                      │    4. Run pre-tool hooks
│                      │    5. Execute tool implementation
│                      │    6. Run post-tool hooks
│                      │    7. Yield tool_result message
│                      │
│  Sub-functions:      │
│    MmD → permission-gated execution
│    GmD → error wrapping + telemetry
│    UmD → core tool implementation call
└─────────────────────┘
```

## Tool Execution: Streaming vs Sequential

Claude Code has TWO tool execution paths, controlled by a feature flag:

### Streaming Tool Execution (default, via ToolExecutor/UiH)
- Tools are **queued as soon as** their `tool_use` content block arrives from the stream
- Concurrency-safe tools (e.g., GlobTool, GrepTool, FileReadTool) **execute in parallel**
- Non-concurrent tools (e.g., BashTool, FileEditTool) **block the queue**
- Results are yielded **in order** even if they complete out of order

### Sequential Tool Execution (fallback, via gO$)
- All tools execute one at a time, in order
- Simpler but slower

## Key Design Patterns

### Async Generators Everywhere
The entire pipeline is built on `async function*` generators. Each layer yields
events upstream to the React UI, which renders them in real-time. This allows:
- Streaming text display as tokens arrive
- Tool progress indicators while tools execute
- Interrupt handling at any point in the pipeline

### Context Modifiers
Some tools (notably BashTool) can modify the execution context (e.g., change cwd).
These modifications flow through `contextModifier` yields and are applied to the
`toolUseContext` for subsequent tools and turns.

### Compaction Pipeline
Before each API call, messages go through:
1. **Microcompaction**: Trims individual large messages
2. **Autocompaction**: If total tokens exceed threshold, summarizes old messages
   by calling the API with `x-stainless-helper: "compaction"` header

### Error Recovery
- **Model fallback**: If the primary model fails (overload), falls back to a secondary
- **Max output tokens recovery**: If response is cut off, asks model to continue (up to 3 retries)
- **Stop hooks**: Post-turn hooks can inject errors that force the model to address them
- **Streaming fallback**: If streaming fails, discards partial results and retries

## Internal Tool Names

| User-facing name | Internal name       |
|------------------|---------------------|
| Read             | FileReadTool        |
| Write            | FileWriteTool       |
| Edit             | FileEditTool        |
| Bash             | BashTool            |
| Glob             | GlobTool            |
| Grep             | GrepTool            |
| NotebookEdit     | NotebookEditTool    |
| Agent            | AgentTool           |
| WebSearch        | WebSearchTool       |
| WebFetch         | WebFetchTool        |
| Skill            | SkillTool           |
| Task*            | TaskTool            |
| AskUserQuestion  | AskUserQuestion     |
| EnterPlanMode    | (state transition)  |
| ExitPlanMode     | (state transition)  |

## Supporting Systems ("Secret Sauce")

### System Prompt Assembly (08-system-prompt-builder.js)
The system prompt is built from 7+ modular sections, assembled by `AY`:
1. **Identity** (CT1) — "You are Claude Code..."
2. **System** (wT1) — tool behavior, tags, compression
3. **Coding guidelines** (ZT1) — over-engineering avoidance
4. **Action safety** (qT1) — reversibility, blast radius rules
5. **Tool usage** (TT1) — tool preferences, parallel calls
6. **Tone/style** (NT1) — emoji policy, conciseness
7. **Output efficiency** (zT1) — brevity (strict/focused/polished), controlled by `tengu_swann_brevity` flag
8. Dynamic sections: memory, MCP instructions, output style, scratchpad

### Prompt Caching (09-prompt-caching.js)
`XR9` places `cache_control: { type: "ephemeral" }` on the last 2-3 user messages.
Older `tool_result` blocks get `cache_reference` fields (copied from `tool_use_id`)
so the API can match cached responses even when message ordering shifts.
`cache_edits` blocks handle stale cache deletion after compaction.

### Compaction Prompts (10-compaction-prompts.js)
Two modes:
- **Partial** (`Z0D`): Summarizes only RECENT messages (after retained context)
- **Full** (`q0D`): Summarizes the ENTIRE conversation

Both produce structured `<analysis>` + `<summary>` output with 9 sections
(intent, concepts, files, errors, problems, user messages, pending tasks,
current work, next step). The summary replaces the original messages.

### Bash Security (11-bash-security.js)
Before every BashTool execution, a fast LLM call (Haiku) classifies the command.
Returns a "prefix" (e.g., "npm", "git") or blocks with:
- `command_injection_detected` — injection attempt
- Dangerous shell prefix (sh, bash, zsh, etc.) — sub-shell escape attempt
- `none` — unclassifiable command
Results are memoized (200ms TTL). Compound commands are split and checked individually.

### Subagent Forking (12-subagent-fork.js)
When AgentTool fires, the FULL conversation is forked. A "FORKING CONVERSATION CONTEXT"
marker tells the subagent that prior messages are context-only. Subagents get a filtered
tool set (no TaskCreate, no nested AgentTool in most modes, read-only in async mode).

### Effort/Thinking Budget (13-effort-thinking.js)
Opus 4.6 defaults to "medium" effort in certain contexts (background mode, subagent sessions,
quartz falcon experiment). Valid levels: low/medium/high/max. Controlled by
`tengu_grey_step2` and `tengu_quartz_falcon` flags.

### CLAUDE.md Cascade (14-claudemd-loader.js)
Files loaded in order: Managed → User → Project (walks up directory tree) → Local →
Additional directories → AutoMem. All are merged (not overridden). Memoized and
invalidated on /refresh or file watcher changes.

### Stop Hooks (15-stop-hooks.js)
Run after each turn completes. Can:
- Return blocking errors (injected as user messages, forces model to address them)
- Prevent continuation (stops the loop with reason "hook_stopped")
- Trigger task validation hooks for in-progress tasks
Subagents trigger "SubagentStop" instead of "Stop".

### Feature Flags (16-feature-flags.js)
GrowthBook-based A/B testing. ~50 flags with obfuscated codenames (`tengu_*`).
Key flags: `tengu_swann_brevity` (output verbosity), `tengu_streaming_tool_execution2`
(concurrent tools), `tengu_grey_step2` (Opus effort), `tengu_cork_m4q` (bash caching).

## File Index

| File | Original | Description |
|------|----------|-------------|
| 01-core-agent-loop.js | fO | Main while(true) agent loop |
| 02-tool-executor.js | UiH | Concurrent tool execution queue |
| 03-tool-call-handler.js | tcH/MmD/GmD/UmD | Per-tool dispatch chain |
| 04-sdk-tool-runner.js | ToolRunner | SDK-level tool loop (for sub-tasks) |
| 05-api-call-function.js | Yc | Anthropic Messages API call |
| 06-input-handler.js | vk$/pKB | React-side input handler |
| 07-raw-minified/ | — | Verbatim minified source |
| 08-system-prompt-builder.js | AY/CT1/wT1/ZT1/qT1/TT1/NT1/zT1 | System prompt assembly |
| 09-prompt-caching.js | XR9/BR9/fR9 | Cache breakpoint placement |
| 10-compaction-prompts.js | Z0D/q0D/$l1/QmH | Compaction prompt templates |
| 11-bash-security.js | VR9/EBB/eCH/WR9 | Command injection detection |
| 12-subagent-fork.js | q9D/CzA/mc | Conversation forking for subagents |
| 13-effort-thinking.js | uQH/nyH/GUA | Effort level & thinking budget |
| 14-claudemd-loader.js | MF | CLAUDE.md cascade loader |
| 15-stop-hooks.js | TmD | Post-turn stop hooks |
| 16-feature-flags.js | OmD/IL/AG | Feature flags & session gates |

## Telemetry Events (selected)

- `tengu_query_started` — Turn begins
- `tengu_auto_compact_succeeded` — Context was compacted
- `tengu_streaming_tool_execution_used` — Concurrent tool execution path taken
- `tengu_query_error` — API call failed
- `tengu_model_fallback_triggered` — Switched to fallback model
- `tengu_post_autocompact_turn` — Turn after compaction
- `tengu_cancel` — User interrupted
- `tengu_claudemd__initial_load` — CLAUDE.md files loaded
- `tengu_stop_hook_error` — Stop hook failed
- `tengu_api_cache_breakpoints` — Cache breakpoints placed

("tengu" is the internal codename for Claude Code)
