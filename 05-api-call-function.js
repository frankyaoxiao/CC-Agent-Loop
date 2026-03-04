/**
 * CLAUDE CODE — API Call Function (deobfuscated from binary v2.1.68)
 *
 * Original function name: Yc (minified)
 * This is the function that actually calls the Anthropic Messages API.
 * Called by the core agent loop (fO) via deps.callModel().
 *
 * Handles:
 *   - Model selection and beta flags
 *   - System prompt construction (with caching)
 *   - Structured output format
 *   - Extended thinking configuration
 *   - Token counting and budget management
 *   - Retry logic with exponential backoff
 */

async function callAnthropicAPI(params) {
  const {
    model,
    system: systemPrompt,
    messages,
    tools,
    tool_choice: toolChoice,
    output_format: outputFormat,
    max_tokens = 1024,
    maxRetries = 2,
    signal,
    skipSystemPromptPrefix,
    temperature,
    thinking: thinkingConfig,
  } = params;

  // ── Create API client with retry configuration ──
  const client = await getApiClient({ maxRetries, model });

  // ── Determine beta flags ──
  const betas = [...getModelBetas(model)];

  // Add output format beta if needed (structured output)
  if (outputFormat && supportsStructuredOutput(model) && !betas.includes(STRUCTURED_OUTPUT_BETA)) {
    betas.push(STRUCTURED_OUTPUT_BETA);
  }

  // ── Build the system prompt ──
  // Uses cache_control: "ephemeral" for prompt caching
  const systemBlocks = buildSystemBlocks(systemPrompt, skipSystemPromptPrefix);

  // ── Compute max_tokens ──
  const resolvedMaxTokens = computeMaxTokens(model, messages, systemBlocks, max_tokens);

  // ── Build request parameters ──
  const requestParams = {
    model,
    messages,
    system: systemBlocks,
    max_tokens: resolvedMaxTokens,
    tools: tools?.length ? tools : undefined,
    tool_choice: toolChoice,
    ...(outputFormat ? { output_format: outputFormat } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
    stream: true,
  };

  // ── Make the API call ──
  // Uses beta.messages.stream for streaming responses
  const response = await client.beta.messages.stream(
    requestParams,
    {
      headers: {
        "anthropic-beta": betas.join(","),
      },
      signal,
    }
  );

  return response;
}

/**
 * callModel wrapper used by the core agent loop.
 * Adds model fallback, permission context, and telemetry.
 */
async function* callModel(params) {
  const {
    messages,
    systemPrompt,
    thinkingConfig,
    tools,
    signal,
    options,
  } = params;

  const {
    model,
    fallbackModel,
    onStreamingFallback,
    querySource,
    agents,
    maxOutputTokensOverride,
    mcpTools,
    effortValue,
    agentId,
  } = options;

  // ── Merge MCP tools with built-in tools ──
  const allTools = mergeTools(tools, mcpTools);

  // ── Call the API ──
  const stream = await callAnthropicAPI({
    model,
    system: systemPrompt,
    messages,
    tools: allTools,
    max_tokens: maxOutputTokensOverride || getDefaultMaxTokens(model),
    signal,
    thinking: thinkingConfig,
  });

  // ── Process streaming events ──
  // SSE events: message_start, content_block_start, content_block_delta,
  //             content_block_stop, message_delta, message_stop
  for await (const event of stream) {
    if (event.type === "message_start") {
      yield { type: "message_start", message: event.message };
    }
    else if (event.type === "content_block_start") {
      if (event.content_block.type === "tool_use") {
        yield { type: "tool_use_start", block: event.content_block };
      }
      else if (event.content_block.type === "text") {
        yield { type: "text_start", block: event.content_block };
      }
      else if (event.content_block.type === "thinking") {
        yield { type: "thinking_start", block: event.content_block };
      }
    }
    else if (event.type === "content_block_delta") {
      yield { type: "content_delta", delta: event.delta, index: event.index };
    }
    else if (event.type === "content_block_stop") {
      yield { type: "content_stop", index: event.index };
    }
    else if (event.type === "message_delta") {
      // Contains stop_reason, usage stats
      yield { type: "message_delta", delta: event.delta, usage: event.usage };
    }
    else if (event.type === "message_stop") {
      yield { type: "message_stop" };
    }
  }
}
