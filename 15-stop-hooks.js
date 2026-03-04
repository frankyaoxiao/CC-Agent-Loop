/**
 * CLAUDE CODE — Stop Hooks (deobfuscated from binary v2.1.68)
 *
 * Original function name: TmD
 *
 * Stop hooks run AFTER each agent turn completes (when the model returns
 * a response with no tool_use blocks, or after all tools have executed).
 * They're the primary mechanism for:
 *
 *   1. **Linting/formatting** — Run eslint, prettier, etc. after code changes
 *   2. **Test validation** — Run tests after modifications
 *   3. **Custom checks** — Any user-defined shell command
 *   4. **Continuation prevention** — A hook can STOP the agent loop entirely
 *
 * Stop hooks are configured in .claude/settings.json or via frontmatter
 * in skill files. They can be:
 *   - Shell commands (executed via subprocess)
 *   - Function hooks (registered programmatically by skills)
 *
 * Flow:
 *   1. Agent turn completes (no more tool_use blocks)
 *   2. TmD is called with the full message history
 *   3. Each registered Stop hook is executed
 *   4. Hooks can return:
 *      - Success (stdout/stderr) → may force another turn if output is non-empty
 *      - Blocking error → injected as a user message, forces the model to address it
 *      - Prevention → stops the agent loop entirely (returns "hook_stopped")
 *   5. If any hook returns blocking errors, the agent loop continues with
 *      those errors as new user messages
 *   6. If a hook prevents continuation, the loop exits with reason "hook_stopped"
 *
 * Subagents trigger "SubagentStop" instead of "Stop" hooks.
 *
 * Additionally, after stop hooks run, if task tools are active (TaskCreate, etc.),
 * in-progress task validation hooks also run to check task completion.
 */

// Original: TmD — async generator
async function* runStopHooks(
  priorMessages,        // Messages before this turn
  newAssistantMessages, // Messages from this turn (assistant responses)
  systemPrompt,
  userContext,
  systemContext,
  toolUseContext,
  querySource,
  stopHookAlreadyActive, // Whether stop hooks were already active (prevents infinite recursion)
) {
  const startTime = Date.now();

  // Build the full context for hook evaluation
  const hookContext = {
    messages: [...priorMessages, ...newAssistantMessages],
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    querySource,
  };

  // ── Prompt Suggestions ──
  // (Side effect: triggers proactive prompt suggestions if enabled)
  if (process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION !== "false") {
    if (querySource === "repl_main_thread" || querySource === "sdk") {
      triggerPromptSuggestionAsync(getAllMessages(hookContext));
    }
    triggerContextualSuggestions(hookContext);
  }

  try {
    const blockingErrors = [];
    const permissionMode = (await toolUseContext.getAppState()).toolPermissionContext.mode;

    // ── Execute Stop Hooks ──
    // auA creates the hook execution pipeline:
    //   - Reads hook definitions from settings + session hooks
    //   - Matches hooks against the current event ("Stop" or "SubagentStop")
    //   - Executes each matching hook as a subprocess
    const hookRunner = executeStopHookPipeline(
      permissionMode,
      toolUseContext.abortController.signal,
      undefined,                    // no specific tool use ID
      stopHookAlreadyActive ?? false,
      toolUseContext.agentId,
      toolUseContext,
      [...priorMessages, ...newAssistantMessages],
      toolUseContext.agentType,
    );

    let lastToolUseID = "";
    let hookCount = 0;
    let preventContinuation = false;
    let stopReason = "";
    let hasNonEmptyOutput = false;
    const hookErrors = [];
    const hookCommands = [];

    for await (const hookResult of hookRunner) {
      // ── Yield hook progress/results to the UI ──
      if (hookResult.message) {
        yield hookResult.message;

        // Track progress messages (one per hook)
        if (hookResult.message.type === "progress" && hookResult.message.toolUseID) {
          lastToolUseID = hookResult.message.toolUseID;
          hookCount++;
          const data = hookResult.message.data;
          if (data.command) {
            hookCommands.push({ command: data.command, promptText: data.promptText });
          }
        }

        // Track attachment results
        if (hookResult.message.type === "attachment") {
          const attachment = hookResult.message.attachment;
          if ("hookEvent" in attachment &&
              (attachment.hookEvent === "Stop" || attachment.hookEvent === "SubagentStop")) {

            if (attachment.type === "hook_non_blocking_error") {
              hookErrors.push(attachment.stderr || `Exit code ${attachment.exitCode}`);
              hasNonEmptyOutput = true;
            }
            else if (attachment.type === "hook_error_during_execution") {
              hookErrors.push(attachment.content);
              hasNonEmptyOutput = true;
            }
            else if (attachment.type === "hook_success") {
              if ((attachment.stdout && attachment.stdout.trim()) ||
                  (attachment.stderr && attachment.stderr.trim())) {
                hasNonEmptyOutput = true;
              }
            }

            // Track duration
            if ("durationMs" in attachment && "command" in attachment) {
              const cmd = hookCommands.find(
                c => c.command === attachment.command && c.durationMs === undefined
              );
              if (cmd) cmd.durationMs = attachment.durationMs;
            }
          }
        }
      }

      // ── Handle blocking errors ──
      // These become user messages that the model must address
      if (hookResult.blockingError) {
        const errorMessage = createUserMessage({
          content: formatBlockingError(hookResult.blockingError),
          isMeta: true,
        });
        blockingErrors.push(errorMessage);
        yield errorMessage;
        hasNonEmptyOutput = true;
        hookErrors.push(hookResult.blockingError.blockingError);
      }

      // ── Handle continuation prevention ──
      if (hookResult.preventContinuation) {
        preventContinuation = true;
        stopReason = hookResult.stopReason || "Stop hook prevented continuation";

        yield createAttachment({
          type: "hook_stopped_continuation",
          message: stopReason,
          hookName: "Stop",
          toolUseID: lastToolUseID,
          hookEvent: "Stop",
        });
      }

      // ── Abort check ──
      if (toolUseContext.abortController.signal.aborted) {
        telemetry("tengu_pre_stop_hooks_cancelled", {
          queryChainId: toolUseContext.queryTracking?.chainId,
          queryDepth: toolUseContext.queryTracking?.depth,
        });
        yield createAbortNotification({ toolUse: false });
        return { blockingErrors: [], preventContinuation: true };
      }
    }

    // ── Emit summary ──
    if (hookCount > 0) {
      yield buildStopHookSummary(
        hookCount, hookCommands, hookErrors,
        preventContinuation, stopReason, hasNonEmptyOutput,
        "suggestion", lastToolUseID
      );

      if (hookErrors.length > 0) {
        const shortcut = getKeybinding("app:toggleTranscript", "Global", "ctrl+o");
        toolUseContext.addNotification?.({
          key: "stop-hook-error",
          text: `Stop hook error occurred · ${shortcut} to see`,
          priority: "immediate",
        });
      }
    }

    if (preventContinuation) {
      return { blockingErrors: [], preventContinuation: true };
    }

    if (blockingErrors.length > 0) {
      return { blockingErrors, preventContinuation: false };
    }

    // ── Task Validation Hooks ──
    // If task tools are active, also run validation on in-progress tasks
    if (isTaskToolsEnabled()) {
      const agentName = getAgentName() ?? "";
      const sessionId = getSessionId() ?? "";
      const taskErrors = [];

      const tasks = getTaskStore();
      const inProgressTasks = (await listTasks(tasks))
        .filter(t => t.status === "in_progress" && t.owner === agentName);

      for (const task of inProgressTasks) {
        const taskHookRunner = runTaskValidation(
          task.id, task.subject, task.description,
          agentName, sessionId, permissionMode,
          toolUseContext.abortController.signal,
          undefined, toolUseContext
        );

        for await (const result of taskHookRunner) {
          if (result.message) yield result.message;
          if (result.blockingError) {
            const errorMessage = createUserMessage({
              content: formatTaskBlockingError(result.blockingError),
              isMeta: true,
            });
            taskErrors.push(errorMessage);
            yield errorMessage;
          }
          if (toolUseContext.abortController.signal.aborted) {
            return { blockingErrors: [], preventContinuation: true };
          }
        }
      }

      // Also run global task validation
      const globalTaskRunner = runGlobalTaskValidation(
        agentName, sessionId, permissionMode,
        toolUseContext.abortController.signal
      );

      for await (const result of globalTaskRunner) {
        if (result.message) yield result.message;
        if (result.blockingError) {
          const errorMessage = createUserMessage({
            content: formatGlobalTaskError(result.blockingError),
            isMeta: true,
          });
          taskErrors.push(errorMessage);
          yield errorMessage;
        }
        if (toolUseContext.abortController.signal.aborted) {
          return { blockingErrors: [], preventContinuation: true };
        }
      }

      if (taskErrors.length > 0) {
        return { blockingErrors: taskErrors, preventContinuation: false };
      }
    }

    return { blockingErrors: [], preventContinuation: false };

  } catch (error) {
    const duration = Date.now() - startTime;
    telemetry("tengu_stop_hook_error", {
      duration,
      queryChainId: toolUseContext.queryTracking?.chainId,
      queryDepth: toolUseContext.queryTracking?.depth,
    });
    yield createNotification(
      `Stop hook failed: ${error instanceof Error ? error.message : String(error)}`,
      "warning"
    );
    return { blockingErrors: [], preventContinuation: false };
  }
}
