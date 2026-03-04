/**
 * CLAUDE CODE — Feature Flags & Session Gates (deobfuscated from binary v2.1.68)
 *
 * Original function names: OmD (session gates), IL (getFeatureFlag),
 * AG (isGateEnabled), various tengu_* flag names
 *
 * Claude Code uses GrowthBook for feature flags (A/B testing, gradual rollouts).
 * Flags are fetched at session start and cached for the session duration.
 *
 * The flags control virtually every behavioral aspect of Claude Code —
 * from output brevity to tool execution strategy to model defaults.
 *
 * Flag naming convention: tengu_<color>_<noun> (obfuscated codenames)
 * "tengu" is the internal codename for Claude Code.
 */

// ── Session Gates ────────────────────────────────────────────────────────
// Original: OmD
// Called once at the start of the agent loop to read session-level flags.
function getSessionGates() {
  return {
    sessionId: getSessionId(),
    gates: {
      // Whether to use streaming (concurrent) tool execution
      // vs sequential tool execution
      streamingToolExecution: isGateEnabled("tengu_streaming_tool_execution2"),

      // Whether to emit tool-use summary messages
      // (uses a small model to summarize tool results)
      emitToolUseSummaries: isEnabled(process.env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES),

      // Internal Anthropic employee mode
      isAnt: false,

      // Whether the /fast mode toggle is available
      fastModeEnabled: !isEnabled(process.env.CLAUDE_CODE_DISABLE_FAST_MODE),
    },
  };
}

// ── Known Feature Flags ──────────────────────────────────────────────────
// Extracted from the binary. Each flag is accessed via IL("flag_name", default).
// The obfuscated codenames make it hard to guess their purpose — annotations
// below are based on how they're used in the code.

const KNOWN_FEATURE_FLAGS = {
  // ── Output & Behavior ──
  "tengu_swann_brevity":          // Output verbosity level: "strict" | "focused" | "polished" | null
    "Controls output efficiency section in system prompt",

  "tengu_bergotte_lantern":       // boolean — controls concise vs short style in Tone section
    "If true, uses 'concise and polished' tone instead of 'short and concise'",

  // ── Tool Execution ──
  "tengu_streaming_tool_execution2":  // boolean — streaming vs sequential tool execution
    "Main gate for concurrent tool execution during streaming",

  // ── Model & Effort ──
  "tengu_grey_step2":             // { enabled: boolean, dialogTitle, dialogDescription }
    "Controls Opus 4.6 'medium' effort default in certain sessions",

  "tengu_quartz_falcon":          // { enabled: boolean } | null
    "Controls thinking/effort configuration from remote experiment",

  // ── Bash Security ──
  "tengu_cork_m4q":               // boolean
    "If true, puts the Bash policy spec in system prompt (cached) instead of user prompt",

  // ── Caching ──
  "tengu_system_prompt_global_cache":  // boolean
    "If true, adds global cache marker to system prompt",

  // ── Attribution ──
  "tengu_attribution_header":     // boolean (default true)
    "Whether to send x-anthropic-billing-header with version info",

  // ── Context & Memory ──
  // (flags related to compaction, context management)

  // ── Unknown/Obfuscated ──
  // These appear in the binary but their exact purpose isn't clear
  // from context alone:
  "tengu_amber_quartz":           "Unknown — referenced in telemetry context",
  "tengu_crimson_tide":           "Unknown — referenced in permission handling",
  "tengu_jade_river":             "Unknown — referenced in model selection",
  "tengu_silver_dawn":            "Unknown — referenced in session init",
  "tengu_copper_vine":            "Unknown — referenced in tool dispatch",
  "tengu_pearl_frost":            "Unknown — referenced in error recovery",
  "tengu_ruby_storm":             "Unknown — referenced in compaction logic",
  "tengu_azure_peak":             "Unknown — referenced in API call setup",
  "tengu_golden_gate":            "Unknown — referenced in streaming handler",
  "tengu_iron_leaf":              "Unknown — referenced in hook execution",
};

// ── Feature Flag Access Patterns ─────────────────────────────────────────
// The binary uses two main functions to access flags:
//
// IL(flagName, defaultValue) — getFeatureFlag
//   Returns the flag value if set, otherwise defaultValue.
//   Used for flags that return non-boolean values (strings, objects).
//   Example: IL("tengu_swann_brevity", null) → "focused" | null
//
// AG(flagName) — isGateEnabled
//   Returns boolean. Used for simple on/off gates.
//   Example: AG("tengu_streaming_tool_execution2") → true/false
//
// Both read from the GrowthBook client that was initialized at session start.

// ── Environment Variable Overrides ───────────────────────────────────────
// Some behavior can also be controlled via env vars, which take precedence:
const ENV_OVERRIDES = {
  "CLAUDE_CODE_SIMPLE":                     "Minimal system prompt mode",
  "CLAUDE_CODE_EFFORT_LEVEL":               "Override effort level (low/medium/high/max)",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS":          "Override max output tokens",
  "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES":    "Enable tool-use summary messages",
  "CLAUDE_CODE_DISABLE_FAST_MODE":          "Disable /fast mode toggle",
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY":        "Disable auto-memory (MEMORY.md)",
  "CLAUDE_CODE_DISABLE_CLAUDE_MDS":         "Disable CLAUDE.md loading",
  "CLAUDE_CODE_FORCE_GLOBAL_CACHE":         "Force global cache marker in system prompt",
  "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "Load CLAUDE.md from additional dirs",
  "CLAUDE_CODE_REMOTE":                     "Running in remote/headless mode",
  "CLAUDE_CODE_REMOTE_MEMORY_DIR":          "Override memory directory in remote mode",
  "CLAUDE_CODE_ENTRYPOINT":                 "Entry point for attribution (cli/sdk/etc)",
  "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION":   "Enable proactive prompt suggestions",
  "ANTHROPIC_LOG":                          "Debug logging level",
};
