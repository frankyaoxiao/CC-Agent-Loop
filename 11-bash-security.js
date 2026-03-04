/**
 * CLAUDE CODE — Bash Security & Command Injection Detection
 * (deobfuscated from binary v2.1.68)
 *
 * Original function names: VR9 (pre-flight check), EBB (memoized wrapper),
 * eCH (command parser), t4 (subcommand extractor), WR9 (dangerous prefixes)
 *
 * Before executing any BashTool command, Claude Code runs a "pre-flight check"
 * that uses a fast LLM call (Haiku) to classify the command. This is the
 * mechanism that prevents command injection attacks.
 *
 * The flow:
 *   1. BashTool receives a command string
 *   2. The command is sent to a small/fast model (via g7/Haiku) with a policy prompt
 *   3. The model returns one of:
 *      - A command "prefix" (e.g., "npm", "git", "python") → allowed
 *      - "command_injection_detected" → BLOCKED
 *      - A dangerous shell prefix (sh, bash, zsh, etc.) → BLOCKED
 *      - "none" → BLOCKED (couldn't determine prefix)
 *   4. The prefix is cached (memoized by command string, TTL ~200ms)
 *   5. The tool executor uses the prefix for permission decisions
 *
 * The command parser (eCH) also splits compound commands (pipes, &&, ;)
 * into individual subcommands, each of which can be checked independently.
 */

// ── Dangerous Shell Prefixes ─────────────────────────────────────────────
// Original: WR9
// If the LLM returns any of these as the command prefix, the command is BLOCKED.
// This prevents the model from spawning a sub-shell to escape sandbox restrictions.
const DANGEROUS_SHELL_PREFIXES = new Set([
  "sh", "bash", "zsh", "fish", "csh", "tcsh", "ksh", "dash",
  "cmd", "cmd.exe",
  "powershell", "powershell.exe", "pwsh", "pwsh.exe", "bash.exe",
]);

// ── Pre-flight Check (core) ─────────────────────────────────────────────
// Original: VR9
// Makes a fast LLM call to classify the command.
async function prefightCheck(
  command,      // The shell command to check
  signal,       // AbortSignal
  isNonInteractive,  // Whether running in non-interactive/headless mode
  toolName,     // "Bash" (for the prompt)
  policySpec,   // The policy specification text
  eventName,    // Telemetry event name
  querySource,  // Query source for telemetry
  preCheck,     // Optional synchronous pre-check function
) {
  // Fast path: synchronous pre-check can short-circuit
  if (preCheck) {
    const result = preCheck(command);
    if (result !== null) return result;
  }

  let timeout;
  const startTime = Date.now();
  let result = null;

  try {
    // Show a warning if the check takes >10 seconds
    timeout = setTimeout(() => {
      const msg = `[${toolName}Tool] Pre-flight check is taking longer than expected. Run with ANTHROPIC_LOG=debug to check for failed or slow API requests.`;
      if (isNonInteractive) {
        process.stderr.write(formatLog({ level: "warn", message: msg }) + "\n");
      } else {
        console.warn(chalk.yellow(`⚠️  ${msg}`));
      }
    }, 10_000);

    // Feature flag controls whether the policy spec is in system prompt or user prompt
    const useCachedPolicy = getFeatureFlag("tengu_cork_m4q", false);

    // Call the fast model (Haiku) to classify the command
    const response = await callFastModel({
      systemPrompt: toArray(
        useCachedPolicy
          ? [`Your task is to process ${toolName} commands that an AI coding agent wants to run.\n\n${policySpec}`]
          : [`Your task is to process ${toolName} commands that an AI coding agent wants to run.\n\nThis policy spec defines how to determine the prefix of a ${toolName} command:`]
      ),
      userPrompt: useCachedPolicy
        ? `Command: ${command}`
        : `${policySpec}\n\nCommand: ${command}`,
      signal,
      options: {
        enablePromptCaching: useCachedPolicy,
        querySource,
        agents: [],
        isNonInteractiveSession: isNonInteractive,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    });

    clearTimeout(timeout);
    const durationMs = Date.now() - startTime;

    // Extract the text response
    const responseText = typeof response.message.content === "string"
      ? response.message.content
      : Array.isArray(response.message.content)
        ? response.message.content.find(b => b.type === "text")?.text ?? "none"
        : "none";

    // ── Classify the response ──
    if (responseText.startsWith(API_ERROR_PREFIX)) {
      // API error — allow the command (fail open)
      telemetry(eventName, { success: false, error: "API error", durationMs });
      result = null;
    }
    else if (responseText === "command_injection_detected") {
      // BLOCKED: Command injection detected
      telemetry(eventName, { success: false, error: "command_injection_detected", durationMs });
      result = { commandPrefix: null };
    }
    else if (responseText === "git" || DANGEROUS_SHELL_PREFIXES.has(responseText.toLowerCase())) {
      // BLOCKED: Dangerous shell prefix (spawning sub-shell)
      telemetry(eventName, { success: false, error: "dangerous_shell_prefix", durationMs });
      result = { commandPrefix: null };
    }
    else if (responseText === "none") {
      // BLOCKED: Couldn't determine a prefix
      telemetry(eventName, { success: false, error: 'prefix "none"', durationMs });
      result = { commandPrefix: null };
    }
    else if (!command.startsWith(responseText)) {
      // BLOCKED: The returned prefix doesn't match the start of the command
      telemetry(eventName, { success: false, error: "command did not start with prefix", durationMs });
      result = { commandPrefix: null };
    }
    else {
      // ALLOWED: Valid prefix returned
      telemetry(eventName, { success: true, durationMs });
      result = { commandPrefix: responseText };
    }

    return result;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── Memoized Pre-flight Check ────────────────────────────────────────────
// Original: EBB
// Wraps prefightCheck with memoization (cache keyed by command string, TTL 200ms).
// This prevents duplicate LLM calls for the same command within a short window.
function createMemoizedPreflight(config) {
  const { toolName, policySpec, eventName, querySource, preCheck } = config;

  const memoized = memoize(
    (command, signal, isNonInteractive) => {
      const promise = prefightCheck(command, signal, isNonInteractive, toolName, policySpec, eventName, querySource, preCheck);
      // On failure, evict from cache so it can be retried
      promise.catch(() => {
        if (memoized.cache.get(command) === promise) {
          memoized.cache.delete(command);
        }
      });
      return promise;
    },
    (command) => command,  // cache key = command string
    200,                    // TTL = 200ms
  );

  return memoized;
}

// ── Subcommand-Aware Pre-flight ──────────────────────────────────────────
// Original: MBB + PR9
// For compound commands (pipes, &&, ;), also checks each subcommand independently.
function createSubcommandPreflight(extractSubcommands, singleCheck) {
  const memoized = memoize(
    async (command, signal, isNonInteractive) => {
      const subcommands = await extractSubcommands(command);
      const [mainResult, ...subResults] = await Promise.all([
        singleCheck(command, signal, isNonInteractive),
        ...subcommands.map(async (sub) => ({
          subcommand: sub,
          prefix: await singleCheck(sub, signal, isNonInteractive),
        })),
      ]);

      if (!mainResult) return null;

      const subcommandPrefixes = subResults.reduce((map, { subcommand, prefix }) => {
        if (prefix) map.set(subcommand, prefix);
        return map;
      }, new Map());

      return { ...mainResult, subcommandPrefixes };
    },
    (command) => command,
    200,
  );

  return memoized;
}

// ── Shell Command Parser ─────────────────────────────────────────────────
// Original: eCH
// Parses shell commands into individual subcommands by splitting on
// pipes (|), logical operators (&&, ||), semicolons (;), and subshells.
// Uses a tokenizer (bE) that handles quoting, escaping, and heredocs.
function parseShellCommand(command) {
  const subcommands = [];
  const placeholders = generatePlaceholders();  // random hex-based placeholders

  // Pre-process: handle heredocs separately, escape quotes with placeholders
  const { processedCommand, heredocs } = extractHeredocs(command);

  // Handle line continuations (backslash-newline)
  let normalized = processedCommand.replace(/\\+\n/g, (match) => {
    const backslashCount = match.length - 1;
    if (backslashCount % 2 === 1) return "\\".repeat(backslashCount - 1);
    return match;
  });

  // Tokenize with placeholder substitution
  const tokenResult = tokenize(
    normalized
      .replaceAll('"', `"${placeholders.DOUBLE_QUOTE}`)
      .replaceAll("'", `'${placeholders.SINGLE_QUOTE}`)
      .replaceAll("\n", `\n${placeholders.NEW_LINE}\n`)
      .replaceAll("\\(", placeholders.ESCAPED_OPEN_PAREN)
      .replaceAll("\\)", placeholders.ESCAPED_CLOSE_PAREN),
    (expr) => `$${expr}`,  // variable expansion handler
  );

  if (!tokenResult.success) return restoreHeredocs([command], heredocs);

  const tokens = tokenResult.tokens;
  if (tokens.length === 0) return [];

  // Merge tokens back into command strings, splitting on operators
  try {
    for (const token of tokens) {
      if (typeof token === "string") {
        if (subcommands.length > 0 && typeof subcommands[subcommands.length - 1] === "string") {
          if (token === placeholders.NEW_LINE) {
            subcommands.push(null);  // newline separator
          } else {
            subcommands[subcommands.length - 1] += " " + token;
            continue;
          }
        }
      } else if ("op" in token && token.op === "glob") {
        if (subcommands.length > 0 && typeof subcommands[subcommands.length - 1] === "string") {
          subcommands[subcommands.length - 1] += " " + token.pattern;
          continue;
        }
      }
      subcommands.push(token);
    }

    // Restore placeholders back to original characters
    const restored = subcommands
      .map(cmd => {
        if (cmd === null) return null;
        if (typeof cmd === "string") return cmd;
        if ("comment" in cmd) return "#" + cmd.comment;
        if ("op" in cmd && cmd.op === "glob") return cmd.pattern;
        if ("op" in cmd) return cmd.op;
        return null;
      })
      .filter(cmd => cmd !== null)
      .map(cmd =>
        cmd
          .replaceAll(`${placeholders.SINGLE_QUOTE}`, "'")
          .replaceAll(`${placeholders.DOUBLE_QUOTE}`, '"')
          .replaceAll(`\n${placeholders.NEW_LINE}\n`, "\n")
          .replaceAll(placeholders.ESCAPED_OPEN_PAREN, "\\(")
          .replaceAll(placeholders.ESCAPED_CLOSE_PAREN, "\\)")
      );

    return restoreHeredocs(restored, heredocs);
  } catch {
    return [command];  // fallback: return original command as-is
  }
}

// ── Subcommand Extractor ─────────────────────────────────────────────────
// Original: t4
// Takes a parsed command and extracts individual subcommands for
// independent pre-flight checking. Handles redirections (>, >>)
// and filters out noise tokens.
function extractSubcommands(command) {
  const parsed = parseShellCommand(command);
  // Filter out common noise tokens that aren't real commands
  // (ZR9 = set of tokens to skip)
  return parsed.filter(cmd => !NOISE_TOKENS.has(cmd));
}
