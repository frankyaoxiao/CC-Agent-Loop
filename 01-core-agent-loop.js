/**
 * CLAUDE CODE — Core Agent Loop (deobfuscated from binary v2.1.68)
 *
 * Original function name: fO (minified)
 * This is THE central agentic loop. It:
 *   1. Takes user messages + system prompt
 *   2. Calls the Anthropic API (streaming)
 *   3. Processes assistant response content blocks
 *   4. If tool_use blocks exist → dispatches tool execution
 *   5. Collects tool_results
 *   6. Loops back to step 2 with updated messages
 *   7. Exits when the model returns end_turn (no tool_use blocks)
 *
 * This is an async generator — it yields UI events as they happen
 * (stream chunks, tool progress, attachments, errors, etc.)
 */

const MAX_OUTPUT_TOKEN_RECOVERY_ATTEMPTS = 3;

async function* coreAgentLoop(params) {
  const {
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,         // permission checker function
    fallbackModel,      // model to try if primary fails
    querySource,        // where this query originated (e.g. "repl_main_thread", "sdk")
    maxTurns,           // optional cap on agentic turns
    skipCacheWrite,
  } = params;

  const deps = params.deps ?? getDefaultDeps(); // uuid generator, API client, compactor, etc.

  // ── Mutable loop state ──────────────────────────────────────
  let loopState = {
    messages:                     params.messages,
    toolUseContext:               params.toolUseContext,
    maxOutputTokensOverride:      params.maxOutputTokensOverride,
    autoCompactTracking:          undefined,
    stopHookActive:               undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact:  false,
    turnCount:                    1,
    pendingToolUseSummary:        undefined,
    transition:                   undefined,
  };

  const featureFlags = getFeatureFlags();

  // ╔══════════════════════════════════════════════════════════╗
  // ║              MAIN AGENTIC WHILE LOOP                     ║
  // ╚══════════════════════════════════════════════════════════╝
  while (true) {
    const { toolUseContext } = loopState;
    let {
      messages,
      autoCompactTracking,
      maxOutputTokensRecoveryCount,
      hasAttemptedReactiveCompact,
      maxOutputTokensOverride,
      pendingToolUseSummary,
      stopHookActive,
      turnCount,
    } = loopState;

    const messageSnapshot = cloneMessages(messages, toolUseContext);

    yield { type: "stream_request_start" };
    markPerf("query_fn_entry");

    if (!toolUseContext.agentId) {
      emitGlobalEvent("query_started");
    }

    // Query tracking (for telemetry chain IDs)
    const queryTracking = toolUseContext.queryTracking
      ? { chainId: toolUseContext.queryTracking.chainId, depth: toolUseContext.queryTracking.depth + 1 }
      : { chainId: deps.uuid(), depth: 0 };
    const chainId = queryTracking.chainId;
    toolUseContext.queryTracking = queryTracking;

    let workingMessages = [...flattenMessages(messages)];
    let compactTrack = autoCompactTracking;

    // ── Step 1: Micro-compaction (trim individual messages) ───
    markPerf("query_microcompact_start");
    const microResult = await deps.microcompact(workingMessages, toolUseContext, querySource);
    workingMessages = microResult.messages;
    if (microResult.compactionInfo?.boundaryMessage) {
      yield microResult.compactionInfo.boundaryMessage;
    }
    markPerf("query_microcompact_end");

    // ── Step 2: Auto-compaction (summarize old messages if too long) ──
    const systemTokens = countTokens(buildFullSystemPrompt(systemPrompt, systemContext));
    markPerf("query_autocompact_start");
    const { compactionResult } = await deps.autocompact(
      workingMessages, toolUseContext,
      { systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages: workingMessages },
      querySource
    );
    markPerf("query_autocompact_end");

    if (compactionResult) {
      const { preCompactTokenCount, postCompactTokenCount, compactionUsage } = compactionResult;
      telemetry("tengu_auto_compact_succeeded", {
        originalMessageCount: messages.length,
        compactedMessageCount: compactionResult.summaryMessages.length,
        preCompactTokenCount,
        postCompactTokenCount,
        queryChainId: chainId,
        queryDepth: queryTracking.depth,
      });

      if (!compactTrack?.compacted) {
        compactTrack = { compacted: true, turnId: deps.uuid(), turnCounter: 0 };
      }

      const compactedMessages = buildCompactedMessages(compactionResult);
      for (const msg of compactedMessages) yield msg;
      workingMessages = compactedMessages;
      resetContext();
    }

    toolUseContext.messages = workingMessages;

    let assistantMessages = [];
    let toolResultMessages = [];

    // ── Step 3: Set up tool executor ──────────────────────────
    markPerf("query_setup_start");
    // ToolExecutor handles concurrent tool execution with a queue
    const toolExecutor = featureFlags.streamingToolExecution
      ? new ToolExecutor(toolUseContext.options.tools, canUseTool, toolUseContext)
      : null;

    const appState = await toolUseContext.getAppState();
    const permissionMode = appState.toolPermissionContext.mode;
    const modelOverride = selectModel({
      permissionMode,
      mainLoopModel: toolUseContext.options.mainLoopModel,
      exceeds200kTokens: permissionMode === "plan" && exceeds200kTokens(workingMessages),
    });
    markPerf("query_setup_end");

    // Check blocking limit
    if (!compactionResult && querySource !== "compact" && querySource !== "session_memory") {
      const { isAtBlockingLimit } = checkTokenLimit(
        countTokens(workingMessages), toolUseContext.options.mainLoopModel
      );
      if (isAtBlockingLimit) {
        yield errorMessage({ content: BLOCKING_LIMIT_ERROR, error: "invalid_request" });
        return { reason: "blocking_limit" };
      }
    }

    // ╔════════════════════════════════════════════════════════╗
    // ║        INNER LOOP: API CALL + STREAM PROCESSING        ║
    // ╚════════════════════════════════════════════════════════╝
    let shouldRetryApiCall = true;
    markPerf("query_api_loop_start");

    try {
      while (shouldRetryApiCall) {
        shouldRetryApiCall = false;

        try {
          let hadStreamingFallback = false;
          markPerf("query_api_streaming_start");

          // ── Call the Anthropic Messages API (streaming) ─────
          for await (const event of deps.callModel({
            messages: injectUserContext(workingMessages, userContext),
            systemPrompt: systemTokens,
            thinkingConfig: toolUseContext.options.thinkingConfig,
            tools: toolUseContext.options.tools,
            signal: toolUseContext.abortController.signal,
            options: {
              async getToolPermissionContext() {
                return (await toolUseContext.getAppState()).toolPermissionContext;
              },
              model: modelOverride,
              ...(featureFlags.fastModeEnabled ? { fastMode: appState.fastMode } : {}),
              toolChoice: undefined,
              isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
              fallbackModel,
              onStreamingFallback: () => { hadStreamingFallback = true; },
              querySource,
              agents: toolUseContext.options.agentDefinitions.activeAgents,
              allowedAgentTypes: toolUseContext.options.agentDefinitions.allowedAgentTypes,
              maxOutputTokensOverride,
              mcpTools: appState.mcp.tools,
              hasPendingMcpServers: appState.mcp.clients.some(c => c.type === "pending"),
              queryTracking,
              effortValue: appState.effortValue,
              skipCacheWrite,
              agentId: toolUseContext.agentId,
            },
          })) {
            // Handle streaming fallback (discard orphaned messages)
            if (hadStreamingFallback) {
              for (const msg of assistantMessages) {
                yield { type: "tombstone", message: msg };
              }
              assistantMessages.length = 0;
              toolResultMessages.length = 0;
              if (toolExecutor) {
                toolExecutor.discard();
                // Re-create executor for fresh start
                toolExecutor = new ToolExecutor(toolUseContext.options.tools, canUseTool, toolUseContext);
              }
            }

            // Yield the streaming event to the UI
            yield event;

            // ── Collect assistant messages and start tool execution eagerly ──
            if (event.type === "assistant") {
              assistantMessages.push(event);

              if (toolExecutor && !toolUseContext.abortController.signal.aborted) {
                const toolUseBlocks = event.message.content.filter(b => b.type === "tool_use");
                for (const block of toolUseBlocks) {
                  // This queues tool execution WHILE streaming continues
                  toolExecutor.addTool(block, event);
                }
              }
            }

            // ── Yield completed tool results as they finish ──
            if (toolExecutor && !toolUseContext.abortController.signal.aborted) {
              for (const result of toolExecutor.getCompletedResults()) {
                if (result.message) {
                  yield result.message;
                  toolResultMessages.push(
                    ...extractToolResults([result.message], toolUseContext.options.tools)
                      .filter(m => m.type === "user")
                  );
                }
              }
            }
          }

          markPerf("query_api_streaming_end");

        } catch (error) {
          // ── Model fallback on specific errors ──
          if (error instanceof ModelOverloadError && fallbackModel) {
            modelOverride = fallbackModel;
            shouldRetryApiCall = true;
            yield* tombstoneMessages(assistantMessages, "Model fallback triggered");
            assistantMessages.length = 0;
            toolResultMessages.length = 0;
            if (toolExecutor) {
              toolExecutor.discard();
              toolExecutor = new ToolExecutor(toolUseContext.options.tools, canUseTool, toolUseContext);
            }
            toolUseContext.options.mainLoopModel = fallbackModel;
            yield infoMessage(`Model fallback: switching to ${fallbackModel}`);
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      // ── Fatal error handling ──
      logError(error);
      telemetry("tengu_query_error", {
        assistantMessages: assistantMessages.length,
        toolUses: assistantMessages.flatMap(m => m.message.content.filter(b => b.type === "tool_use")).length,
        queryChainId: chainId,
        queryDepth: queryTracking.depth,
      });

      if (error instanceof ImageError || error instanceof ContentFilterError) {
        yield errorMessage({ content: error.message });
        return { reason: "image_error" };
      }

      yield* tombstoneMessages(assistantMessages, error.message);
      yield turnComplete({ toolUse: false });
      return { reason: "model_error", error };
    }

    // ── Post-sampling hooks ──
    if (assistantMessages.length > 0) {
      runPostSamplingHooks([...workingMessages, ...assistantMessages], systemPrompt, userContext, systemContext, toolUseContext, querySource);
    }

    // ── Handle abort ──
    if (toolUseContext.abortController.signal.aborted) {
      if (toolExecutor) {
        for await (const result of toolExecutor.getRemainingResults()) {
          if (result.message) yield result.message;
        }
      } else {
        yield* tombstoneMessages(assistantMessages, "Interrupted by user");
      }
      if (toolUseContext.abortController.signal.reason !== "interrupt") {
        yield turnComplete({ toolUse: false });
      }
      return { reason: "aborted_streaming" };
    }

    // ╔════════════════════════════════════════════════════════╗
    // ║    CHECK: Does the response contain tool_use blocks?   ║
    // ╚════════════════════════════════════════════════════════╝
    const toolUseBlocks = assistantMessages.flatMap(
      m => m.message.content.filter(b => b.type === "tool_use")
    );

    // Emit any pending tool use summary from previous turn
    if (pendingToolUseSummary) {
      const summary = await pendingToolUseSummary;
      if (summary) yield summary;
    }

    // ── NO tool_use → turn is complete ──
    if (!assistantMessages.length || !toolUseBlocks.length) {
      const lastMessage = assistantMessages[assistantMessages.length - 1];

      // Handle max_output_tokens recovery (ask model to continue)
      if (lastMessage?.apiError === "max_output_tokens" && maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKEN_RECOVERY_ATTEMPTS) {
        const continuationMessage = createUserMessage({
          content: "Your response was cut off because it exceeded the output token limit. Please break your work into smaller pieces. Continue from where you left off.",
          isMeta: true,
        });
        loopState = {
          messages: [...workingMessages, ...assistantMessages, continuationMessage],
          toolUseContext,
          autoCompactTracking: compactTrack,
          maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
          hasAttemptedReactiveCompact,
          maxOutputTokensOverride: undefined,
          pendingToolUseSummary: undefined,
          stopHookActive: undefined,
          turnCount,
          transition: { reason: "max_output_tokens_recovery", attempt: maxOutputTokensRecoveryCount + 1 },
        };
        continue; // ← LOOP BACK
      }

      // Run stop hooks (pre-commit checks, etc.)
      const hookResult = yield* runStopHooks(workingMessages, assistantMessages, systemPrompt, userContext, systemContext, toolUseContext, querySource, stopHookActive);
      if (hookResult.preventContinuation) {
        return { reason: "stop_hook_prevented" };
      }
      if (hookResult.blockingErrors.length > 0) {
        loopState = {
          messages: [...workingMessages, ...assistantMessages, ...hookResult.blockingErrors],
          toolUseContext,
          autoCompactTracking: compactTrack,
          maxOutputTokensRecoveryCount: 0,
          hasAttemptedReactiveCompact: false,
          maxOutputTokensOverride: undefined,
          pendingToolUseSummary: undefined,
          stopHookActive: true,
          turnCount,
          transition: { reason: "stop_hook_blocking" },
        };
        continue; // ← LOOP BACK (hook injected errors → model must address them)
      }

      // ✅ DONE — model returned end_turn with no tool_use
      return { reason: "completed" };
    }

    // ╔════════════════════════════════════════════════════════╗
    // ║     TOOL EXECUTION (tool_use blocks found)             ║
    // ╚════════════════════════════════════════════════════════╝
    let hookStoppedContinuation = false;
    let updatedContext = toolUseContext;

    markPerf("query_tool_execution_start");

    if (toolExecutor) {
      // ── Streaming tool execution (tools started eagerly during streaming) ──
      telemetry("tengu_streaming_tool_execution_used", {
        tool_count: toolUseBlocks.length,
        queryChainId: chainId,
      });

      // Drain remaining results from the executor
      for await (const result of toolExecutor.getRemainingResults()) {
        if (!result.message) continue;
        yield result.message;
        if (result.message.type === "attachment" && result.message.attachment.type === "hook_stopped_continuation") {
          hookStoppedContinuation = true;
        }
        toolResultMessages.push(
          ...extractToolResults([result.message], toolUseContext.options.tools)
            .filter(m => m.type === "user")
        );
      }
      updatedContext = { ...toolExecutor.getUpdatedContext(), queryTracking };

    } else {
      // ── Sequential tool execution (fallback path) ──
      telemetry("tengu_streaming_tool_execution_not_used", {
        tool_count: toolUseBlocks.length,
      });

      for await (const result of executeToolsSequentially(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)) {
        if (result.message) {
          yield result.message;
          if (result.message.type === "attachment" && result.message.attachment.type === "hook_stopped_continuation") {
            hookStoppedContinuation = true;
          }
          toolResultMessages.push(
            ...extractToolResults([result.message], toolUseContext.options.tools)
              .filter(m => m.type === "user")
          );
        }
        if (result.newContext) {
          updatedContext = { ...result.newContext, queryTracking };
        }
      }
    }

    markPerf("query_tool_execution_end");

    // Handle abort after tool execution
    if (toolUseContext.abortController.signal.aborted) {
      if (toolUseContext.abortController.signal.reason !== "interrupt") {
        yield turnComplete({ toolUse: true });
      }
      const nextTurn = turnCount + 1;
      if (maxTurns && nextTurn > maxTurns) {
        yield infoAttachment({ type: "max_turns_reached", maxTurns, turnCount: nextTurn });
      }
      return { reason: "aborted_tools" };
    }

    if (hookStoppedContinuation) {
      return { reason: "hook_stopped" };
    }

    // Post-compaction tracking
    if (compactTrack?.compacted) {
      compactTrack.turnCounter++;
    }

    // Process system attachments (file change notifications, etc.)
    const proactiveMessages = querySource.startsWith("repl_main_thread") || querySource === "sdk"
      ? (isProactiveActive() ? getProactiveMessages("now") : getScheduledMessages())
      : [];
    for await (const attachment of processAttachments(null, updatedContext, null, proactiveMessages, [...workingMessages, ...assistantMessages, ...toolResultMessages], querySource)) {
      yield attachment;
      toolResultMessages.push(attachment);
    }

    // Refresh tools if needed
    if (updatedContext.options.refreshTools) {
      const newTools = updatedContext.options.refreshTools();
      if (newTools !== updatedContext.options.tools) {
        updatedContext = { ...updatedContext, options: { ...updatedContext.options, tools: newTools } };
      }
    }

    // ── Check max turns ──
    const nextTurnCount = turnCount + 1;
    if (maxTurns && nextTurnCount > maxTurns) {
      yield infoAttachment({ type: "max_turns_reached", maxTurns, turnCount: nextTurnCount });
      return { reason: "max_turns", turnCount: nextTurnCount };
    }

    // ╔════════════════════════════════════════════════════════╗
    // ║         LOOP BACK → Next agentic turn                  ║
    // ╚════════════════════════════════════════════════════════╝
    markPerf("query_recursive_call");
    loopState = {
      messages:                     [...workingMessages, ...assistantMessages, ...toolResultMessages],
      toolUseContext:               updatedContext,
      autoCompactTracking:          compactTrack,
      turnCount:                    nextTurnCount,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact:  false,
      pendingToolUseSummary:        undefined, // will be set above if feature flag enabled
      maxOutputTokensOverride:      undefined,
      stopHookActive,
      transition:                   { reason: "next_turn" },
    };
    // ← continues the while(true) loop
  }
}
