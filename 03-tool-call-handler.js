/**
 * CLAUDE CODE — Tool Call Handler (deobfuscated from binary v2.1.68)
 *
 * Original function name: tcH (minified)
 * This is the per-tool dispatch function. For each tool_use block:
 *   1. Resolves the tool definition
 *   2. Checks permissions (ask user / auto-allow / deny)
 *   3. Runs pre-tool hooks
 *   4. Executes the tool implementation
 *   5. Runs post-tool hooks
 *   6. Yields the tool_result message
 *
 * Calls into: MmD (permission-gated execution), GmD (error wrapping), UmD (core execution)
 */

async function* toolCallHandler(toolUseBlock, assistantMessage, canUseTool, toolUseContext) {
  const toolName = toolUseBlock.name;
  const toolDef = findTool(toolUseContext.options.tools, toolName);

  // Handle tool aliases (e.g., "Bash" → "BashTool")
  if (!toolDef) {
    const aliasedDef = findTool(getAllToolDefinitions(), toolName);
    if (aliasedDef && aliasedDef.aliases?.includes(toolName)) {
      toolDef = aliasedDef;
    }
  }

  const messageId = assistantMessage.message.id;
  const requestId = assistantMessage.requestId;
  const toolUseId = toolUseBlock.id;

  // Parse and validate tool input
  if (!toolDef) {
    yield {
      message: createUserMessage({
        content: [{
          type: "tool_result",
          content: `<tool_use_error>Error: No such tool: ${toolName}</tool_use_error>`,
          is_error: true,
          tool_use_id: toolUseId,
        }],
        toolUseResult: `Error: No such tool: ${toolName}`,
        sourceToolAssistantUUID: assistantMessage.uuid,
      }),
    };
    return;
  }

  const parseResult = toolDef.inputSchema.safeParse(toolUseBlock.input);
  if (!parseResult.success) {
    const errorMessage = formatZodError(parseResult.error);
    yield {
      message: createUserMessage({
        content: [{
          type: "tool_result",
          content: `<tool_use_error>Error: Invalid input: ${errorMessage}</tool_use_error>`,
          is_error: true,
          tool_use_id: toolUseId,
        }],
        toolUseResult: `Error: Invalid input: ${errorMessage}`,
        sourceToolAssistantUUID: assistantMessage.uuid,
      }),
    };
    return;
  }

  const validatedInput = parseResult.data;

  // ── Permission check ──────────────────────────────────────
  // This is where the user gets prompted "Allow BashTool?" etc.
  // The permission system has multiple modes:
  //   - "allowAll": auto-approve everything
  //   - "default": follow tool-specific rules
  //   - "plan": read-only tools only
  //   - "ask": prompt for everything
  yield* permissionGatedExecution(
    toolUseContext,
    toolDef,
    toolUseBlock,
    assistantMessage,
    canUseTool,
    validatedInput,
    toolUseId,
    requestId,
    messageId
  );
}

/**
 * Original function: MmD
 * Handles the permission check, then delegates to error-wrapped execution.
 */
async function* permissionGatedExecution(
  toolUseContext, toolDef, toolUseBlock, assistantMessage,
  canUseTool, validatedInput, toolUseId, requestId, messageId
) {
  const startTime = Date.now();

  try {
    const appState = await toolUseContext.getAppState();
    const permissionMode = appState.toolPermissionContext.mode;
    let decision = undefined; // will be set by permission check

    // ── Check tool permissions ──
    for await (const event of checkToolPermission(
      toolDef.name,
      validatedInput,
      toolUseContext,
      toolDef,
      toolUseBlock,
      assistantMessage,
      canUseTool,
      permissionMode,
      requestId
    )) {
      if (event.type === "permission_decision") {
        decision = event;
      } else {
        yield event; // progress events during permission check
      }
    }

    // If permission denied → yield error result
    if (decision && decision.behavior === "deny") {
      yield {
        message: createUserMessage({
          content: [{
            type: "tool_result",
            content: decision.message || "Permission denied",
            is_error: true,
            tool_use_id: toolUseId,
          }],
          toolUseResult: decision.message || "Permission denied",
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
      };
      return;
    }

    // ── Execute the tool ──
    yield* errorWrappedExecution(
      toolUseContext, toolDef, toolUseBlock, assistantMessage,
      validatedInput, toolUseId, decision, startTime
    );

  } catch (error) {
    // Catch-all error handling for tool execution
    const errorMsg = error instanceof Error ? error.message : String(error);
    yield {
      message: createUserMessage({
        content: [{
          type: "tool_result",
          content: `<tool_use_error>Error: ${errorMsg}</tool_use_error>`,
          is_error: true,
          tool_use_id: toolUseId,
        }],
        toolUseResult: `Error: ${errorMsg}`,
        sourceToolAssistantUUID: assistantMessage.uuid,
      }),
    };
  }
}

/**
 * Original function: GmD
 * Wraps tool execution with error handling and telemetry.
 */
async function* errorWrappedExecution(
  toolUseContext, toolDef, toolUseBlock, assistantMessage,
  validatedInput, toolUseId, decision, startTime
) {
  const appState = await toolUseContext.getAppState();
  const permissionMode = appState.toolPermissionContext.mode;

  try {
    // ── Pre-tool hooks ──
    for await (const hookEvent of runPreToolHooks(
      toolDef.name, toolUseBlock, toolUseContext, permissionMode
    )) {
      yield hookEvent;
    }

    // ── Core tool execution ──
    yield* coreToolExecution(
      toolUseContext, toolDef, toolUseBlock, assistantMessage,
      validatedInput, toolUseId, startTime
    );

  } catch (error) {
    // ── Error telemetry ──
    const duration = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);

    telemetry("tool_result", {
      tool_name: sanitizeToolName(toolDef.name),
      use_id: toolUseId,
      success: "false",
      duration_ms: String(duration),
      error: errorMsg,
      ...(decision ? { decision_source: decision.source, decision_type: decision.decision } : {}),
    });

    const sanitizedError = sanitizeErrorMessage(error);

    // Run post-tool error hooks
    const errorHookResults = [];
    for await (const hookEvent of runPostToolErrorHooks(
      toolUseContext, toolDef, toolUseId, assistantMessage, sanitizedError, /*isError*/ true, requestId
    )) {
      errorHookResults.push(hookEvent);
    }

    yield {
      message: createUserMessage({
        content: [{
          type: "tool_result",
          content: sanitizedError,
          is_error: true,
          tool_use_id: toolUseId,
        }],
        toolUseResult: `Error: ${sanitizedError}`,
        sourceToolAssistantUUID: assistantMessage.uuid,
      }),
    };

    for (const hookResult of errorHookResults) yield hookResult;
  }
}

/**
 * Original function: UmD
 * The actual tool implementation execution.
 */
async function* coreToolExecution(
  toolUseContext, toolDef, toolUseBlock, assistantMessage,
  validatedInput, toolUseId, startTime
) {
  const appState = await toolUseContext.getAppState();

  // ── Call the tool's execute() function ──
  // Each tool (BashTool, FileReadTool, etc.) has an execute() that returns
  // the tool result content and optional context modifiers.
  for await (const event of executeToolImplementation(
    toolDef.name,
    validatedInput,
    toolUseBlock,
    toolUseContext,
    appState.toolPermissionContext.mode,
    assistantMessage
  )) {
    if (event.type === "tool_result") {
      const duration = Date.now() - startTime;

      // ── Telemetry ──
      telemetry("tool_result", {
        tool_name: sanitizeToolName(toolDef.name),
        use_id: toolUseId,
        success: "true",
        duration_ms: String(duration),
      });

      // ── Post-tool hooks ──
      for await (const hookEvent of runPostToolHooks(
        toolUseContext, toolDef, toolUseId, assistantMessage,
        event.content, /*isError*/ false
      )) {
        yield hookEvent;
      }

      // ── Yield the tool_result ──
      yield {
        message: createUserMessage({
          content: [{
            type: "tool_result",
            content: event.content,
            is_error: false,
            tool_use_id: toolUseId,
          }],
          toolUseResult: event.summary || event.content,
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
      };

      // ── Context modifiers (e.g., BashTool changes cwd) ──
      if (event.contextModifier) {
        yield { contextModifier: event.contextModifier };
      }

    } else if (event.type === "progress") {
      yield { message: { type: "progress", ...event } };
    }
  }
}
