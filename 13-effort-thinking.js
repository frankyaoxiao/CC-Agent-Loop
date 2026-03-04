/**
 * CLAUDE CODE — Effort Level & Thinking Budget Configuration
 * (deobfuscated from binary v2.1.68)
 *
 * Original function names: uQH (getEffectiveEffort), nyH (getGreyStep2Config),
 * GUA (getUserEffort), e4I (getEnvEffort), P0H (parseEffortLevel),
 * to (isModel46OrNewer)
 *
 * Claude Code controls how much "thinking" the model does via two mechanisms:
 *
 *   1. **Effort Level** (string: "low" | "medium" | "high" | "max")
 *      - Set via user config, env var (CLAUDE_CODE_EFFORT_LEVEL), or feature flag
 *      - Affects the model's internal processing depth
 *      - Opus 4.6 defaults to "medium" in certain contexts to save cost/latency
 *
 *   2. **Thinking Budget** (number of tokens allocated to extended thinking)
 *      - Configured via thinkingConfig: { type: "enabled", budget_tokens: N }
 *      - Capped at max_tokens - 1
 *      - Can be disabled: { type: "disabled" }
 *
 * The "quartz falcon" feature flag (tengu_quartz_falcon) controls a special
 * mode where thinking configuration comes from a remote experiment.
 */

// ── Valid Effort Levels ──────────────────────────────────────────────────
const EFFORT_LEVELS = ["low", "medium", "high", "max"];

// ── Default Grey Step 2 Config ───────────────────────────────────────────
// Feature flag: tengu_grey_step2
// Controls whether Opus 4.6 should default to "medium" effort in
// certain interactive contexts.
const DEFAULT_GREY_STEP2 = {
  enabled: false,
  dialogTitle: "",
  dialogDescription: "",
};

// ── Model Version Check ──────────────────────────────────────────────────
// Original: to
// Returns true for Claude 4.6+ models (opus-4-6, sonnet-4-6)
function isModel46OrNewer(modelId) {
  const lower = modelId.toLowerCase();
  if (lower.includes("opus-4-6") || lower.includes("sonnet-4-6")) return true;
  // Older models (haiku, sonnet, opus without -4-6) return false
  if (lower.includes("haiku") || lower.includes("sonnet") || lower.includes("opus")) return false;
  // Unknown models default to true (assume newest)
  return true;
}

// ── Parse Effort Level ───────────────────────────────────────────────────
// Original: P0H
// Accepts a string ("low", "medium", "high", "max") or integer.
function parseEffortLevel(value) {
  if (value === undefined || value === null || value === "") return undefined;

  const asNumber = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!isNaN(asNumber) && Number.isInteger(asNumber)) return asNumber;

  if (typeof value === "string" && EFFORT_LEVELS.includes(value)) return value;

  return undefined;
}

// ── Get User-Configured Effort ───────────────────────────────────────────
// Original: GUA — reads from user settings
function getUserConfiguredEffort() {
  const config = getConfig();
  return parseEffortLevel(config.effortLevel);
}

// ── Get Environment Effort ───────────────────────────────────────────────
// Original: e4I — reads from CLAUDE_CODE_EFFORT_LEVEL env var
function getEnvironmentEffort() {
  return parseEffortLevel(process.env.CLAUDE_CODE_EFFORT_LEVEL);
}

// ── Get Grey Step 2 Config ───────────────────────────────────────────────
// Original: nyH
function getGreyStep2Config() {
  const flagValue = getFeatureFlag("tengu_grey_step2", DEFAULT_GREY_STEP2);
  return { ...DEFAULT_GREY_STEP2, ...flagValue };
}

// ── Coerce Effort to String ──────────────────────────────────────────────
// Original: iyH
// If the effort level is a number (integer), convert to string name.
// Otherwise return as-is.
function effortToString(effort) {
  if (typeof effort === "string") return effort;
  return "high";  // numeric values default to "high"
}

// ── Get Effective Effort Level ───────────────────────────────────────────
// Original: uQH
// THE key function — determines what effort level to actually use
// for a given model. This is where the "Opus 4.6 defaults to medium"
// logic lives.
function getEffectiveEffort(modelId) {
  // ── Opus 4.6: Special handling ──
  if (modelId.toLowerCase().includes("opus-4-6")) {
    // If "quartz falcon" experiment is active, or running in background mode → "medium"
    if (isQuartzFalconEnabled() || isBackgroundMode()) {
      return "medium";
    }

    // If grey_step2 flag is enabled AND (certain session conditions are met)
    if (getGreyStep2Config().enabled && (isSubagentSession() || isRemoteSession())) {
      return "medium";
    }
  }

  // ── Any 4.6+ model in background/non-interactive mode → "medium"
  if (isBackgroundMode() && isModel46OrNewer(modelId)) {
    return "medium";
  }

  // ── Default: no effort override (use the model's natural behavior)
  return undefined;
}

// ── Quartz Falcon ────────────────────────────────────────────────────────
// Original: J$1, o4I
// Feature flag: tengu_quartz_falcon
// When enabled, provides thinking configuration from a remote experiment.
function getQuartzFalconConfig() {
  return getFeatureFlag("tengu_quartz_falcon", null);
}

function isQuartzFalconEnabled() {
  return getQuartzFalconConfig()?.enabled === true;
}

// ── Identity String Selection ────────────────────────────────────────────
// Original: UJ$
// Chooses which identity preamble to use based on context.
function selectIdentityString(modelId, options) {
  // Vertex AI always uses the CLI identity
  if (getProvider() === "vertex") return IDENTITY_CLI;

  // Non-interactive SDK sessions use a different identity
  if (options?.isNonInteractive) {
    if (options.hasAppendSystemPrompt) return IDENTITY_SDK;
    return IDENTITY_SDK_HEADLESS;
  }

  return IDENTITY_CLI;
}

const IDENTITY_CLI         = "You are Claude Code, Anthropic's official CLI for Claude.";
const IDENTITY_SDK         = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
const IDENTITY_SDK_HEADLESS = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
