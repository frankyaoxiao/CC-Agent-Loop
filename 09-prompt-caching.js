/**
 * CLAUDE CODE — Prompt Caching Strategy (deobfuscated from binary v2.1.68)
 *
 * Original function names: XR9 (main), BR9/fR9 (per-message), FR9 (system prompt)
 *
 * Claude Code uses Anthropic's prompt caching feature to avoid re-processing
 * the same tokens on every turn. The strategy:
 *
 *   1. The last 2-3 user messages get `cache_control: { type: "ephemeral" }`
 *      on their content blocks — this tells the API to cache them.
 *   2. Older tool_result blocks get their `tool_use_id` copied to a
 *      `cache_reference` field, enabling the API to match cached responses
 *      even when message ordering shifts.
 *   3. `cache_edits` blocks can be injected to delete stale cache entries
 *      (e.g., when context is compacted).
 *   4. System prompt blocks get cache_control based on their "scope"
 *      (some are session-stable, some change per-turn).
 *
 * The caching saves significant cost — without it, every turn would
 * re-process the entire conversation from scratch.
 */

/**
 * Main cache breakpoint placement function.
 * Called before every API request to annotate messages with cache hints.
 *
 * Original: XR9
 *
 * @param {Array} messages           - The conversation messages
 * @param {boolean} cachingEnabled   - Whether prompt caching is enabled
 * @param {string} querySource       - Where the query originated (repl, sdk, etc.)
 * @param {boolean} enableCacheEdits - Whether to use cache_edits blocks
 * @param {Object} globalCacheEdits  - Global cache deletion edits
 * @param {Array} perMessageEdits    - Per-message cache deletion edits
 * @param {boolean} skipCacheWrite   - If true, don't add cache_control to the last message
 */
function placeCacheBreakpoints(
  messages,
  cachingEnabled,
  querySource,
  enableCacheEdits = false,
  globalCacheEdits,
  perMessageEdits,
  skipCacheWrite = false
) {
  telemetry("tengu_api_cache_breakpoints", {
    totalMessageCount: messages.length,
    cachingEnabled,
    skipCacheWrite,
  });

  // Step 1: Process each message — add cache_control to recent user messages
  const processed = messages.map((msg, index) => {
    const isLastMessage = index === messages.length - 1;
    // Cache the last 2-3 messages (but skip the very last if skipCacheWrite)
    const shouldCache = index > messages.length - 3 && !(skipCacheWrite && isLastMessage);

    if (msg.type === "user") {
      return processUserMessage(msg, shouldCache, cachingEnabled, querySource);  // BR9
    }
    return processAssistantMessage(msg, shouldCache, cachingEnabled, querySource);  // fR9
  });

  // Step 2: If cache_edits are not enabled, return as-is
  if (!enableCacheEdits) return processed;

  // Step 3: Inject per-message cache_edits blocks (deduplicated)
  const seenReferences = new Set();
  const deduplicateEdits = (block) => {
    const uniqueEdits = block.edits.filter(edit => {
      if (seenReferences.has(edit.cache_reference)) return false;
      seenReferences.add(edit.cache_reference);
      return true;
    });
    return { ...block, edits: uniqueEdits };
  };

  for (const edit of perMessageEdits ?? []) {
    const targetMsg = processed[edit.userMessageIndex];
    if (targetMsg && targetMsg.role === "user") {
      if (!Array.isArray(targetMsg.content)) {
        targetMsg.content = [{ type: "text", text: targetMsg.content }];
      }
      const dedupedBlock = deduplicateEdits(edit.block);
      if (dedupedBlock.edits.length > 0) {
        injectCacheEdits(targetMsg.content, dedupedBlock);
      }
    }
  }

  // Step 4: Inject global cache_edits into the last user message
  if (globalCacheEdits && processed.length > 0) {
    const dedupedGlobal = deduplicateEdits(globalCacheEdits);
    if (dedupedGlobal.edits.length > 0) {
      // Find last user message (searching backward)
      for (let i = processed.length - 1; i >= 0; i--) {
        const msg = processed[i];
        if (msg && msg.role === "user") {
          if (!Array.isArray(msg.content)) {
            msg.content = [{ type: "text", text: msg.content }];
          }
          injectCacheEdits(msg.content, dedupedGlobal);
          debug(`Added cache_edits block with ${dedupedGlobal.edits.length} deletion(s) to message[${i}]: ${dedupedGlobal.edits.map(e => e.cache_reference).join(", ")}`);
          break;
        }
      }
    }
  }

  // Step 5: Convert tool_use_id → cache_reference on older tool_result blocks
  // This allows the API to match cached results even if message order changes.
  if (cachingEnabled) {
    // Find the last message that has any cache_control annotation
    let lastCachedIndex = -1;
    for (let i = 0; i < processed.length; i++) {
      const msg = processed[i];
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object" && "cache_control" in block) {
            lastCachedIndex = i;
          }
        }
      }
    }

    // For all user messages BEFORE the last cached one,
    // copy tool_use_id to cache_reference on tool_result blocks
    if (lastCachedIndex >= 0) {
      for (let i = 0; i < lastCachedIndex; i++) {
        const msg = processed[i];
        if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

        let copied = false;
        for (let j = 0; j < msg.content.length; j++) {
          const block = msg.content[j];
          if (block && isToolResultBlock(block)) {
            if (!copied) {
              msg.content = [...msg.content];  // shallow copy for mutation
              copied = true;
            }
            msg.content[j] = Object.assign({}, block, {
              cache_reference: block.tool_use_id,
            });
          }
        }
      }
    }
  }

  return processed;
}

/**
 * Check if a content block is a tool_result.
 * Original: JR9
 */
function isToolResultBlock(block) {
  return (
    block !== null &&
    typeof block === "object" &&
    "type" in block &&
    block.type === "tool_result" &&
    "tool_use_id" in block
  );
}

/**
 * Build cached system prompt blocks.
 * Original: FR9
 *
 * Splits the system prompt into segments, each with appropriate
 * cache_control scope (session-level vs turn-level).
 */
function buildCachedSystemBlocks(systemPrompt, cachingEnabled, options) {
  return splitSystemPrompt(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map(segment => ({
    type: "text",
    text: segment.text,
    ...(cachingEnabled && segment.cacheScope !== null
      ? { cache_control: buildCacheControl({ scope: segment.cacheScope, querySource: options?.querySource }) }
      : {}),
  }));
}

/**
 * Cap max_tokens and thinking budget to a limit.
 * Original: QR9
 */
function capMaxTokens(params, limit) {
  const cappedMax = Math.min(params.max_tokens, limit);
  const updated = { ...params };
  if (updated.thinking?.type === "enabled" && updated.thinking.budget_tokens) {
    updated.thinking = {
      ...updated.thinking,
      budget_tokens: Math.min(updated.thinking.budget_tokens, cappedMax - 1),
    };
  }
  return { ...updated, max_tokens: cappedMax };
}
