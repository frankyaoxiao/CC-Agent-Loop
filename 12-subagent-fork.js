/**
 * CLAUDE CODE — Subagent Conversation Forking (deobfuscated from binary v2.1.68)
 *
 * Original function names: q9D (fork builder), mc (tool filtering),
 * CzA (tool filter for subagents)
 *
 * When the AgentTool is invoked, Claude Code "forks" the conversation:
 *   1. The ENTIRE conversation history up to this point is passed to the subagent
 *   2. A "FORKING CONVERSATION CONTEXT" marker is injected
 *   3. The subagent's task prompt becomes the new user message
 *   4. The subagent gets a FILTERED set of tools (no Task tools, no nested AgentTool
 *      in some modes, etc.)
 *
 * This allows subagents to have full context of what the main agent has been
 * doing, while being scoped to a specific sub-task.
 *
 * Key design decisions:
 *   - Subagents see the FULL prior conversation (not a summary)
 *   - The fork marker tells the subagent that prior tool_use blocks may reference
 *     tools it doesn't have access to
 *   - Subagents can't use Task tools (TaskCreate, TaskUpdate, etc.) — only the
 *     main agent manages tasks
 *   - In async mode, subagents get a restricted tool set (read-only tools like
 *     FileReadTool, GlobTool, GrepTool + a few others)
 *   - Stop hooks on subagents trigger "SubagentStop" instead of "Stop"
 */

// ── Fork Conversation for Subagent ───────────────────────────────────────
// Original: q9D
// Creates the forked message array for a subagent invocation.
function forkConversationForSubagent(taskPrompt, parentAssistantMessage) {
  const userMessage = createUserMessage({ content: taskPrompt });

  // Find the tool_use block in the parent's response that triggered this AgentTool call
  const matchingToolUse = parentAssistantMessage.message.content.find(block => {
    if (block.type !== "tool_use" || getCanonicalToolName(block.name) !== "AgentTool") return false;
    const input = block.input;
    return "prompt" in input && input.prompt === taskPrompt;
  });

  if (!matchingToolUse) {
    debug(`Could not find matching AgentTool tool use for prompt: ${taskPrompt.slice(0, 50)}...`, { level: "error" });
    return [userMessage];
  }

  // Create a trimmed version of the parent message containing ONLY the matching tool_use
  const trimmedParentMessage = {
    ...parentAssistantMessage,
    uuid: crypto.randomUUID(),
    message: {
      ...parentAssistantMessage.message,
      content: [matchingToolUse],
    },
  };

  // ── The fork marker ──
  // This is injected as a tool_result to the AgentTool call, telling the
  // subagent that everything above is context from the main thread.
  const FORK_MARKER = `### FORKING CONVERSATION CONTEXT ###
### ENTERING SUB-AGENT ROUTINE ###
Entered sub-agent context

PLEASE NOTE:
- The messages above this point are from the main thread prior to sub-agent execution. They are provided as context only.
- Context messages may include tool_use blocks for tools that are not available in the sub-agent context. You should only use the tools specifically provided to you in the system prompt.
- Only complete the specific sub-agent task you have been assigned below.`;

  const forkStatus = {
    status: "sub_agent_entered",
    description: "Entered sub-agent context",
    message: FORK_MARKER,
  };

  const toolResultMessage = createUserMessage({
    content: [{
      type: "tool_result",
      tool_use_id: matchingToolUse.id,
      content: [{ type: "text", text: FORK_MARKER }],
    }],
    toolUseResult: forkStatus,
  });

  // Return: [trimmed parent assistant msg, tool_result with fork marker, new user task]
  return [trimmedParentMessage, toolResultMessage, userMessage];
}

// ── Tool Filtering for Subagents ─────────────────────────────────────────
// Original: CzA
// Filters the tool set for subagent contexts.
function filterToolsForSubagent({ tools, isBuiltIn, isAsync = false, permissionMode }) {
  return tools.filter(tool => {
    // MCP tools always pass through
    if (tool.name.startsWith("mcp__")) return true;

    // ExitPlanMode is available in plan mode
    if (isToolMatch(tool, "ExitPlanMode") && permissionMode === "plan") return true;

    // These tools are NEVER available to subagents:
    // EnterPlanMode, ExitPlanMode (unless plan mode), EnterWorktree, AgentTool, AskUserQuestion, SkillTool
    if (ALWAYS_EXCLUDED_TOOLS.has(tool.name)) return false;

    // For non-built-in tools, also exclude the extended exclusion set
    if (!isBuiltIn && EXTENDED_EXCLUDED_TOOLS.has(tool.name)) return false;

    // In async mode, only allow read-only/safe tools
    if (isAsync && !ASYNC_ALLOWED_TOOLS.has(tool.name)) {
      // Exception: if teammate tools are enabled, allow AgentTool and certain others
      if (isTeammateMode() && isTeammateEnabled()) {
        if (isToolMatch(tool, "AgentTool")) return true;
        if (TEAMMATE_ASYNC_TOOLS.has(tool.name)) return true;
      }
      return false;
    }

    return true;
  });
}

// Tool sets used for filtering:

// Tools that are NEVER available to subagents
// Original: cVH
const ALWAYS_EXCLUDED_TOOLS = new Set([
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "AgentTool",
  "AskUserQuestion",
  "SkillTool",
]);

// Extended exclusion set (also excludes the above)
// Original: YzA
const EXTENDED_EXCLUDED_TOOLS = new Set([
  ...ALWAYS_EXCLUDED_TOOLS,
]);

// Tools allowed in async subagent mode
// Original: RC$
const ASYNC_ALLOWED_TOOLS = new Set([
  "FileReadTool",      // Read
  "WebFetchTool",      // WebFetch
  "WebSearchTool",     // WebSearch
  "GrepTool",          // Grep
  "ToolSearchTool",    // ToolSearch
  "GlobTool",          // Glob
  // ... plus hook-related tools
  "FileEditTool",      // Edit
  "FileWriteTool",     // Write
  "NotebookEditTool",  // NotebookEdit
  "SkillTool",         // Skill
  "StructuredOutputTool", // StructuredOutput
  "EnterWorktree",
]);

// Teammate-specific tools allowed in async mode
// Original: C9D
const TEAMMATE_ASYNC_TOOLS = new Set([
  "BashTool",
  "FileEditTool",
  "FileWriteTool",
  "TaskTool",
  "TaskCreate",
  // ... (varies by configuration)
]);

// ── Tool Allowlist Resolution ────────────────────────────────────────────
// Original: mc
// Resolves the tool allowlist from slash commands or user configuration.
// Handles wildcards ("*"), specific tool names, and AgentTool type restrictions.
function resolveToolAllowlist(config, allTools, isAsync = false, skipFiltering = false) {
  const { tools: allowedToolNames, disallowedTools, source, permissionMode } = config;

  // Apply subagent filtering unless explicitly skipped
  const filteredTools = skipFiltering
    ? allTools
    : filterToolsForSubagent({
        tools: allTools,
        isBuiltIn: source === "built-in",
        isAsync,
        permissionMode,
      });

  // Remove explicitly disallowed tools
  const disallowedSet = new Set(
    disallowedTools?.map(d => { const { toolName } = parseToolSpec(d); return toolName; }) ?? []
  );
  const available = filteredTools.filter(t => !disallowedSet.has(t.name));

  // Wildcard: all tools are available
  if (allowedToolNames === undefined || (allowedToolNames.length === 1 && allowedToolNames[0] === "*")) {
    return { hasWildcard: true, validTools: [], invalidTools: [], resolvedTools: available };
  }

  // Resolve specific tool names
  const toolMap = new Map();
  for (const tool of available) toolMap.set(tool.name, tool);

  const validTools = [];
  const invalidTools = [];
  const resolvedTools = [];
  const seen = new Set();
  let allowedAgentTypes;

  for (const spec of allowedToolNames) {
    const { toolName, ruleContent } = parseToolSpec(spec);

    // Special handling for AgentTool restrictions
    if (toolName === "AgentTool") {
      if (ruleContent) {
        allowedAgentTypes = ruleContent.split(",").map(t => t.trim());
      }
      if (!skipFiltering) {
        validTools.push(spec);
        continue;
      }
    }

    const tool = toolMap.get(toolName);
    if (tool) {
      validTools.push(spec);
      if (!seen.has(tool)) {
        resolvedTools.push(tool);
        seen.add(tool);
      }
    } else {
      invalidTools.push(spec);
    }
  }

  return { hasWildcard: false, validTools, invalidTools, resolvedTools, allowedAgentTypes };
}
