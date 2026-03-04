/**
 * CLAUDE CODE — Input Handler (deobfuscated from binary v2.1.68)
 *
 * Original function name: vk$ (minified)
 * This is the React-side entry point that handles user input and
 * feeds it into the agent loop. It:
 *   1. Processes raw user input (slash commands, pasted content, images)
 *   2. Handles special commands (/exit, /help, etc.)
 *   3. Manages the interrupt flow (abort in-progress turns)
 *   4. Queues messages and feeds them into the onQuery callback
 *
 * The onQuery callback is what eventually calls the core agent loop (fO).
 */

async function handleUserInput(params) {
  const {
    helpers,             // UI helpers (setCursorOffset, clearBuffer, resetHistory)
    queryGuard,          // Mutex that prevents concurrent queries
    isExternalLoading = false,
    commands,            // Available slash commands
    onInputChange,
    setPastedContents,
    setToolJSX,
    getToolUseContext,
    messages,            // Current conversation messages
    mainLoopModel,       // Current model
    ideSelection,        // IDE selection context (if connected)
    setUserInputOnProcessing,
    setAbortController,
    onQuery,             // THE callback that triggers the agent loop
    setAppState,
    onBeforeQuery,
    canUseTool,
    queuedCommands,
    uuid,
    skipSlashCommands,
  } = params;

  const { setCursorOffset, clearBuffer, resetHistory } = helpers;

  // ── Handle queued commands (e.g., from CLI args) ──
  if (queuedCommands?.length) {
    markPerf("query_user_input_received");
    await processQueuedCommands({
      queuedCommands, messages, mainLoopModel, ideSelection,
      querySource: params.querySource, commands, queryGuard,
      setToolJSX, getToolUseContext, setUserInputOnProcessing,
      setAbortController, onQuery, setAppState, onBeforeQuery,
      resetHistory, canUseTool, onInputChange,
    });
    return;
  }

  const rawInput = params.input ?? "";
  const mode = params.mode ?? "prompt";
  const pastedContents = params.pastedContents ?? {};
  const hasImage = Object.values(pastedContents).some(p => p.type === "image");

  // ── Empty input check ──
  if (rawInput.trim() === "" && !hasImage) return;

  // ── Exit commands ──
  if (!skipSlashCommands && ["exit", "quit", ":q", ":q!", ":wq", ":wq!"].includes(rawInput.trim())) {
    const exitCmd = commands.find(c => c.name === "exit");
    if (exitCmd) handleUserInput({ ...params, input: "/exit" });
    else processExit();
    return;
  }

  // ── Slash command handling ──
  if (!skipSlashCommands && rawInput.trim().startsWith("/")) {
    const trimmed = rawInput.trim();
    const spaceIdx = trimmed.indexOf(" ");
    const cmdName = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
    const cmdArgs = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

    // Check for immediate (local) commands that don't need the agent
    const immediateCmd = commands.find(c =>
      c.immediate && c.isEnabled() &&
      (c.name === cmdName || c.aliases?.includes(cmdName) || c.userFacingName() === cmdName)
    );

    if (immediateCmd && immediateCmd.type === "local-jsx" && (queryGuard.isActive || isExternalLoading)) {
      telemetry("tengu_immediate_command_executed", { commandName: immediateCmd.name });
      onInputChange("");
      setCursorOffset(0);
      clearBuffer();

      const context = getToolUseContext(messages, [], createAbortController(), [], mainLoopModel);
      const onComplete = (result, options) => {
        setToolJSX({ jsx: null, shouldHidePromptInput: false, clearLocalJSX: true });
        if (result && options?.display !== "skip" && params.addNotification) {
          params.addNotification({ key: `immediate-${immediateCmd.name}`, text: result, priority: "immediate" });
        }
        if (options?.nextInput) {
          if (options.submitNextInput) submitInput({ value: options.nextInput, mode: "prompt" });
          else onInputChange(options.nextInput);
        }
      };

      const jsx = await (await immediateCmd.load()).call(onComplete, context, cmdArgs);
      if (jsx) setToolJSX({ jsx, shouldHidePromptInput: false, isLocalJSXCommand: true });
      return;
    }
  }

  // ── Expand pasted text inline ──
  let processedInput = rawInput;
  const pasteRefs = extractPasteReferences(rawInput);
  let pasteCount = 0;
  for (const ref of pasteRefs) {
    const paste = pastedContents[ref.id];
    if (paste && paste.type === "text") {
      processedInput = processedInput.replace(ref.match, paste.content);
      pasteCount++;
    }
  }
  telemetry("tengu_paste_text", { pastedTextCount: pasteCount });

  // ── If a query is already running → queue input as interrupt ──
  if (queryGuard.isActive || isExternalLoading) {
    if (mode !== "prompt" && mode !== "bash") return;

    // Interrupt the current turn if an interruptible tool is running
    if (params.hasInterruptibleToolInProgress) {
      debug(`[interrupt] Aborting current turn: streamMode=${params.streamMode}`);
      telemetry("tengu_cancel", { source: "interrupt_on_submit", streamMode: params.streamMode });
      params.abortController?.abort("interrupt");
    }

    // Queue the input for after the current turn
    submitInput({
      value: processedInput.trim(),
      mode,
      pastedContents: hasImage ? pastedContents : undefined,
      skipSlashCommands,
      uuid,
    });
    onInputChange("");
    setCursorOffset(0);
    setPastedContents({});
    resetHistory();
    clearBuffer();
    return;
  }

  // ── Normal path: submit to agent loop ──
  markPerf("query_user_input_received");
  await processQueuedCommands({
    queuedCommands: [{
      value: processedInput,
      mode,
      pastedContents: hasImage ? pastedContents : undefined,
      skipSlashCommands,
      uuid,
    }],
    messages, mainLoopModel, ideSelection,
    querySource: params.querySource, commands, queryGuard,
    setToolJSX, getToolUseContext, setUserInputOnProcessing,
    setAbortController, onQuery, setAppState, onBeforeQuery,
    resetHistory, canUseTool, onInputChange,
  });
}

/**
 * Original function: pKB
 * Processes queued commands: parses input, runs slash commands,
 * creates messages, and calls onQuery to start the agent loop.
 */
async function processQueuedCommands(params) {
  const {
    messages, mainLoopModel, ideSelection, querySource,
    queryGuard, setToolJSX, getToolUseContext,
    setUserInputOnProcessing, setAbortController,
    onQuery, setAppState, onBeforeQuery, resetHistory,
    canUseTool, queuedCommands,
  } = params;

  const abortController = createAbortController();
  setAbortController(abortController);

  function createContext() {
    return getToolUseContext(messages, [], abortController, [], mainLoopModel);
  }

  try {
    queryGuard.reserve();
    markPerf("query_process_user_input_start");

    let allMessages = [];
    let shouldQuery = false;
    let allowedTools, modelOverride, nextInput, submitNextInput;

    // ── Process each queued command ──
    for (let i = 0; i < queuedCommands.length; i++) {
      const cmd = queuedCommands[i];
      const isFirst = i === 0;

      const result = await processInput({
        input: cmd.value,
        mode: cmd.mode,
        setToolJSX,
        context: createContext(),
        pastedContents: isFirst ? cmd.pastedContents : undefined,
        messages,
        setUserInputOnProcessing: isFirst ? setUserInputOnProcessing : undefined,
        isAlreadyProcessing: !isFirst,
        querySource,
        canUseTool,
        uuid: cmd.uuid,
        ideSelection: isFirst ? ideSelection : undefined,
        skipSlashCommands: cmd.skipSlashCommands,
        isMeta: cmd.isMeta,
        skipAttachments: !isFirst,
      });

      allMessages.push(...result.messages);

      if (isFirst) {
        shouldQuery = result.shouldQuery;
        allowedTools = result.allowedTools;
        modelOverride = result.model;
        nextInput = result.nextInput;
        submitNextInput = result.submitNextInput;
      }
    }

    markPerf("query_process_user_input_end");

    // ── Take file history snapshot (for undo) ──
    if (isFileCheckpointingEnabled()) {
      markPerf("query_file_history_snapshot_start");
      allMessages.filter(isUserMessage).forEach(msg => {
        snapshotFileHistory(updater => {
          setAppState(state => ({ ...state, fileHistory: updater(state.fileHistory) }));
        }, msg.uuid);
      });
      markPerf("query_file_history_snapshot_end");
    }

    // ── Trigger the agent loop ──
    if (allMessages.length) {
      resetHistory();
      setToolJSX({ jsx: null, shouldHidePromptInput: false, clearLocalJSX: true });

      const firstCmd = queuedCommands[0];
      const mode = firstCmd?.mode ?? "prompt";
      const inputText = firstCmd && typeof firstCmd.value === "string" ? firstCmd.value : undefined;

      await onQuery(
        allMessages,                           // user messages to add
        abortController,                       // abort signal
        shouldQuery,                           // whether to call the API
        allowedTools ?? [],                    // tool allowlist (from slash commands)
        modelOverride ?? mainLoopModel,        // model to use
        mode === "prompt" ? onBeforeQuery : undefined,
        inputText,                             // raw input text for display
      );
    } else {
      queryGuard.cancelReservation();
      setToolJSX({ jsx: null, shouldHidePromptInput: false, clearLocalJSX: true });
      resetHistory();
      setAbortController(null);
    }

    // Handle chained input (e.g., slash command returns next input)
    if (nextInput) {
      if (submitNextInput) submitInput({ value: nextInput, mode: "prompt" });
      else params.onInputChange(nextInput);
    }
  } finally {
    queryGuard.cancelReservation();
    setUserInputOnProcessing(undefined);
  }
}
