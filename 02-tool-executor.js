/**
 * CLAUDE CODE — ToolExecutor (deobfuscated from binary v2.1.68)
 *
 * Original class name: UiH (minified)
 * Manages concurrent tool execution with a queue-based system.
 *
 * Key behavior:
 *   - Tools marked as "concurrency safe" can run in parallel
 *   - Non-concurrent tools block the queue until they complete
 *   - If a sibling tool errors, remaining queued tools get synthetic errors
 *   - Supports streaming progress updates while tools execute
 *   - Handles user interrupts and abort signals
 */

class ToolExecutor {
  toolDefinitions;    // Array of tool schemas with inputSchema, isConcurrencySafe, etc.
  canUseTool;         // Permission check function
  tools = [];         // Queue of tool executions
  toolUseContext;     // Shared context (abort controller, app state, etc.)
  hasErrored = false;
  discarded = false;
  progressAvailableResolve; // Resolves when any tool has new progress

  constructor(toolDefinitions, canUseTool, toolUseContext) {
    this.toolDefinitions = toolDefinitions;
    this.canUseTool = canUseTool;
    this.toolUseContext = toolUseContext;
  }

  /** Mark this executor as discarded (e.g. on streaming fallback) */
  discard() {
    this.discarded = true;
  }

  /**
   * Add a tool_use block to the execution queue.
   * Called as soon as a tool_use content block is parsed from the stream
   * (before the full response is complete — this is "streaming tool execution").
   */
  addTool(toolUseBlock, assistantMessage) {
    const toolDef = findTool(this.toolDefinitions, toolUseBlock.name);

    if (!toolDef) {
      // Unknown tool → immediate error result
      this.tools.push({
        id: toolUseBlock.id,
        block: toolUseBlock,
        assistantMessage,
        status: "completed",
        isConcurrencySafe: true,
        pendingProgress: [],
        results: [
          createUserMessage({
            content: [{
              type: "tool_result",
              content: `<tool_use_error>Error: No such tool available: ${toolUseBlock.name}</tool_use_error>`,
              is_error: true,
              tool_use_id: toolUseBlock.id,
            }],
            toolUseResult: `Error: No such tool available: ${toolUseBlock.name}`,
            sourceToolAssistantUUID: assistantMessage.uuid,
          }),
        ],
      });
      return;
    }

    // Validate + coerce input against the tool's schema
    toolUseBlock.input = coerceInput(toolDef, toolUseBlock.input);
    const parseResult = toolDef.inputSchema.safeParse(toolUseBlock.input);

    const isConcurrencySafe = parseResult?.success
      ? (() => { try { return Boolean(toolDef.isConcurrencySafe(parseResult.data)); } catch { return false; } })()
      : false;

    this.tools.push({
      id: toolUseBlock.id,
      block: toolUseBlock,
      assistantMessage,
      status: "queued",
      isConcurrencySafe,
      pendingProgress: [],
    });

    // Try to execute immediately if possible
    this.processQueue();
  }

  /**
   * Can we start executing this tool right now?
   * - If nothing is executing → yes
   * - If only concurrency-safe tools are executing and this one is too → yes
   */
  canExecuteTool(isConcurrencySafe) {
    const executing = this.tools.filter(t => t.status === "executing");
    return executing.length === 0 || (isConcurrencySafe && executing.every(t => t.isConcurrencySafe));
  }

  /** Process the queue: start any tools that can run now */
  async processQueue() {
    for (const tool of this.tools) {
      if (tool.status !== "queued") continue;

      if (this.canExecuteTool(tool.isConcurrencySafe)) {
        await this.executeTool(tool);
      } else if (!tool.isConcurrencySafe) {
        // Non-concurrent tool must wait → stop processing queue
        break;
      }
    }
  }

  /** Create a synthetic error message for tools that can't execute */
  createSyntheticErrorMessage(toolUseId, reason, assistantMessage) {
    if (reason === "user_interrupted") {
      return createUserMessage({
        content: [{ type: "tool_result", content: USER_INTERRUPTED_MESSAGE, is_error: true, tool_use_id: toolUseId }],
        toolUseResult: "User rejected tool use",
        sourceToolAssistantUUID: assistantMessage.uuid,
      });
    }
    if (reason === "streaming_fallback") {
      return createUserMessage({
        content: [{ type: "tool_result", content: "<tool_use_error>Error: Streaming fallback - tool execution discarded</tool_use_error>", is_error: true, tool_use_id: toolUseId }],
        toolUseResult: "Streaming fallback - tool execution discarded",
        sourceToolAssistantUUID: assistantMessage.uuid,
      });
    }
    // Sibling error
    return createUserMessage({
      content: [{ type: "tool_result", content: "<tool_use_error>Sibling tool call errored</tool_use_error>", is_error: true, tool_use_id: toolUseId }],
      toolUseResult: "Sibling tool call errored",
      sourceToolAssistantUUID: assistantMessage.uuid,
    });
  }

  /** Check if this tool should be aborted */
  getAbortReason(tool) {
    if (this.discarded) return "streaming_fallback";

    if (this.hasErrored && !this.allToolsAreWriteOrEdit()) return "sibling_error";

    if (this.toolUseContext.abortController.signal.aborted) {
      if (this.toolUseContext.abortController.signal.reason === "interrupt") {
        return this.getToolInterruptBehavior(tool) === "cancel" ? "user_interrupted" : null;
      }
      return "user_interrupted";
    }

    return null;
  }

  getToolInterruptBehavior(tool) {
    const toolDef = findTool(this.toolDefinitions, tool.block.name);
    if (!toolDef?.interruptBehavior) return "block";
    try { return toolDef.interruptBehavior(); } catch { return "block"; }
  }

  allToolsAreWriteOrEdit() {
    return this.tools.every(({ block: { name } }) =>
      name === "FileWriteTool" || name === "FileEditTool"
    );
  }

  /** Update whether in-progress tools are interruptible */
  updateInterruptibleState() {
    const executing = this.tools.filter(t => t.status === "executing");
    this.toolUseContext.setHasInterruptibleToolInProgress?.(
      executing.length > 0 && executing.every(t => this.getToolInterruptBehavior(t) === "cancel")
    );
  }

  /**
   * Execute a single tool.
   * This is the core per-tool execution path:
   *   1. Check abort/error conditions
   *   2. Call the tool handler (permission check → execute → collect results)
   *   3. Track errors for sibling abort
   *   4. Apply context modifiers (e.g., cwd changes from BashTool)
   */
  async executeTool(tool) {
    tool.status = "executing";
    this.toolUseContext.setInProgressToolUseIDs(ids => new Set([...ids, tool.id]));
    this.updateInterruptibleState();

    let results = [];
    let contextModifiers = [];

    const execution = (async () => {
      // Pre-flight abort check
      const abortReason = this.getAbortReason(tool);
      if (abortReason) {
        results.push(this.createSyntheticErrorMessage(tool.id, abortReason, tool.assistantMessage));
        tool.results = results;
        tool.contextModifiers = contextModifiers;
        tool.status = "completed";
        this.updateInterruptibleState();
        return;
      }

      // ── Execute the tool via toolCallHandler (tcH) ──
      const toolStream = toolCallHandler(tool.block, tool.assistantMessage, this.canUseTool, this.toolUseContext);
      let hasOwnError = false;

      for await (const event of toolStream) {
        const midAbortReason = this.getAbortReason(tool);
        if (midAbortReason && !hasOwnError) {
          results.push(this.createSyntheticErrorMessage(tool.id, midAbortReason, tool.assistantMessage));
          break;
        }

        // Track tool errors for sibling abort
        if (event.message.type === "user"
            && Array.isArray(event.message.message.content)
            && event.message.message.content.some(c => c.type === "tool_result" && c.is_error === true)) {
          this.hasErrored = true;
          hasOwnError = true;
        }

        if (event.message) {
          if (event.message.type === "progress") {
            tool.pendingProgress.push(event.message);
            if (this.progressAvailableResolve) {
              this.progressAvailableResolve();
              this.progressAvailableResolve = undefined;
            }
          } else {
            results.push(event.message);
          }
        }

        if (event.contextModifier) {
          contextModifiers.push(event.contextModifier.modifyContext);
        }
      }

      tool.results = results;
      tool.contextModifiers = contextModifiers;
      tool.status = "completed";
      this.updateInterruptibleState();

      // Apply context modifiers from non-concurrent tools
      if (!tool.isConcurrencySafe && contextModifiers.length > 0) {
        for (const modifier of contextModifiers) {
          this.toolUseContext = modifier(this.toolUseContext);
        }
      }
    })();

    tool.promise = execution;
    execution.finally(() => { this.processQueue(); });
  }

  /** Yield completed results in order */
  *getCompletedResults() {
    if (this.discarded) return;

    for (const tool of this.tools) {
      // Yield pending progress first
      while (tool.pendingProgress.length > 0) {
        yield { message: tool.pendingProgress.shift() };
      }

      if (tool.status === "yielded") continue;

      if (tool.status === "completed" && tool.results) {
        tool.status = "yielded";
        for (const result of tool.results) {
          yield { message: result };
        }
        removeFromInProgress(this.toolUseContext, tool.id);
      } else if (tool.status === "executing" && !tool.isConcurrencySafe) {
        // Non-concurrent tool still executing → stop yielding (preserve order)
        break;
      }
    }
  }

  /** Wait for and yield ALL remaining results */
  async *getRemainingResults() {
    if (this.discarded) return;

    while (this.hasUnfinishedTools()) {
      await this.processQueue();

      for (const result of this.getCompletedResults()) yield result;

      // If tools are still executing, wait for any to complete or produce progress
      if (this.hasExecutingTools() && !this.hasCompletedResults() && !this.hasPendingProgress()) {
        const executingPromises = this.tools
          .filter(t => t.status === "executing" && t.promise)
          .map(t => t.promise);
        const progressPromise = new Promise(resolve => { this.progressAvailableResolve = resolve; });

        if (executingPromises.length > 0) {
          await Promise.race([...executingPromises, progressPromise]);
        }
      }
    }

    // Final drain
    for (const result of this.getCompletedResults()) yield result;
  }

  hasPendingProgress()   { return this.tools.some(t => t.pendingProgress.length > 0); }
  hasCompletedResults()  { return this.tools.some(t => t.status === "completed"); }
  hasExecutingTools()    { return this.tools.some(t => t.status === "executing"); }
  hasUnfinishedTools()   { return this.tools.some(t => t.status !== "yielded"); }
  getUpdatedContext()    { return this.toolUseContext; }
}
