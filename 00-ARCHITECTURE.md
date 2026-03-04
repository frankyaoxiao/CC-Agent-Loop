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

## Telemetry Events (selected)

- `tengu_query_started` — Turn begins
- `tengu_auto_compact_succeeded` — Context was compacted
- `tengu_streaming_tool_execution_used` — Concurrent tool execution path taken
- `tengu_query_error` — API call failed
- `tengu_model_fallback_triggered` — Switched to fallback model
- `tengu_post_autocompact_turn` — Turn after compaction
- `tengu_cancel` — User interrupted

("tengu" is the internal codename for Claude Code)
