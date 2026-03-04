/**
 * CLAUDE CODE — CLAUDE.md Cascade Loader (deobfuscated from binary v2.1.68)
 *
 * Original function name: MF (memoized)
 *
 * CLAUDE.md files are the user's persistent instructions that get injected
 * into the system prompt. They're loaded from multiple locations in a
 * specific cascade order, giving users control at different scopes:
 *
 * Loading order (all are merged, not overridden):
 *   1. **Managed**   — /etc/claude-code/CLAUDE.md (system-wide, admin-managed)
 *                      + rules dir at managed rules path
 *   2. **User**      — ~/.claude/CLAUDE.md (per-user global settings)
 *                      + rules dir at user rules path
 *   3. **Project**   — Walk UP from cwd to filesystem root:
 *                      For each directory:
 *                        - <dir>/CLAUDE.md
 *                        - <dir>/.claude/CLAUDE.md
 *                        - <dir>/.claude/rules/ (directory of rule files)
 *   4. **Local**     — Walk UP from cwd to filesystem root:
 *                        - <dir>/CLAUDE.local.md (gitignored, personal)
 *   5. **Additional dirs** — If CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD env is set:
 *                        - <dir>/CLAUDE.md
 *                        - <dir>/.claude/CLAUDE.md
 *                        - <dir>/.claude/rules/
 *   6. **AutoMem**   — Auto-generated memory file (MEMORY.md in the memory dir)
 *
 * Each file gets a `type` tag: "Managed", "User", "Project", "Local", or "AutoMem"
 * These types affect how the content is presented in the system prompt and
 * what permissions are granted (e.g., User files can include external content,
 * Project files may need approval for external includes).
 *
 * The loader is memoized (VA) — it caches results until explicitly invalidated
 * (e.g., when the user runs /refresh or a file watcher detects changes).
 */

// Original: MF = VA((hasApprovedExternalIncludes = false) => { ... })
const loadClaudeMdFiles = memoize((hasApprovedExternalIncludes = false) => {
  const startTime = Date.now();
  logInfo("info", "memory_files_started");

  const results = [];
  const processedPaths = new Set();  // dedup: don't load same file twice

  const config = getConfig();
  const includeExternal = hasApprovedExternalIncludes
    || config.hasClaudeMdExternalIncludesApproved
    || false;

  // ── 1. Managed ──
  const managedPath = getManagedClaudeMdPath("Managed");
  results.push(...loadSingleFile(managedPath, "Managed", processedPaths, includeExternal));

  const managedRulesDir = getManagedRulesDir();
  results.push(...loadRulesDirectory({
    rulesDir: managedRulesDir,
    type: "Managed",
    processedPaths,
    includeExternal,
    conditionalRule: false,
  }));

  // ── 2. User ──
  if (isSettingsEnabled("userSettings")) {
    const userPath = getManagedClaudeMdPath("User");
    results.push(...loadSingleFile(userPath, "User", processedPaths, true));  // always include external for User

    const userRulesDir = getUserRulesDir();
    results.push(...loadRulesDirectory({
      rulesDir: userRulesDir,
      type: "User",
      processedPaths,
      includeExternal: true,
      conditionalRule: false,
    }));
  }

  // ── 3. Project + 4. Local ──
  // Walk UP the directory tree from cwd to root
  const pathSegments = [];
  let currentDir = getCwd();
  while (currentDir !== path.parse(currentDir).root) {
    pathSegments.push(currentDir);
    currentDir = path.dirname(currentDir);
  }

  // Process in reverse (root → cwd) so parent directories come first
  for (const dir of pathSegments.reverse()) {
    // Project files
    if (isSettingsEnabled("projectSettings")) {
      const claudeMd = path.join(dir, "CLAUDE.md");
      results.push(...loadSingleFile(claudeMd, "Project", processedPaths, includeExternal));

      const dotClaudeMd = path.join(dir, ".claude", "CLAUDE.md");
      results.push(...loadSingleFile(dotClaudeMd, "Project", processedPaths, includeExternal));

      const rulesDir = path.join(dir, ".claude", "rules");
      results.push(...loadRulesDirectory({
        rulesDir,
        type: "Project",
        processedPaths,
        includeExternal,
        conditionalRule: false,
      }));
    }

    // Local files (gitignored, personal overrides)
    if (isSettingsEnabled("localSettings")) {
      const localMd = path.join(dir, "CLAUDE.local.md");
      results.push(...loadSingleFile(localMd, "Local", processedPaths, includeExternal));
    }
  }

  // ── 5. Additional directories ──
  if (isEnabled(process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD)) {
    const additionalDirs = getAdditionalDirectories();
    for (const dir of additionalDirs) {
      const claudeMd = path.join(dir, "CLAUDE.md");
      results.push(...loadSingleFile(claudeMd, "Project", processedPaths, includeExternal));

      const dotClaudeMd = path.join(dir, ".claude", "CLAUDE.md");
      results.push(...loadSingleFile(dotClaudeMd, "Project", processedPaths, includeExternal));

      const rulesDir = path.join(dir, ".claude", "rules");
      results.push(...loadRulesDirectory({
        rulesDir,
        type: "Project",
        processedPaths,
        includeExternal,
        conditionalRule: false,
      }));
    }
  }

  // ── 6. AutoMem ──
  if (isAutoMemoryEnabled()) {
    const autoMemFile = loadAutoMemFile(getAutoMemPath(), "AutoMem");
    if (autoMemFile && !processedPaths.has(normalizePath(autoMemFile.path))) {
      processedPaths.add(normalizePath(autoMemFile.path));
      results.push(autoMemFile);
    }
  }

  // ── Telemetry ──
  const totalContentLength = results.reduce((sum, file) => sum + file.content.length, 0);
  logInfo("info", "memory_files_completed", {
    duration_ms: Date.now() - startTime,
    file_count: results.length,
    total_content_length: totalContentLength,
  });

  const typeCounts = {};
  for (const file of results) {
    typeCounts[file.type] = (typeCounts[file.type] ?? 0) + 1;
  }

  // Only emit telemetry on first load
  if (!hasEmittedInitialLoad) {
    hasEmittedInitialLoad = true;
    telemetry("tengu_claudemd__initial_load", {
      file_count: results.length,
      total_content_length: totalContentLength,
      user_count: typeCounts.User ?? 0,
      project_count: typeCounts.Project ?? 0,
      local_count: typeCounts.Local ?? 0,
      managed_count: typeCounts.Managed ?? 0,
      automem_count: typeCounts.AutoMem ?? 0,
      duration_ms: Date.now() - startTime,
    });
  }

  return results;
});

let hasEmittedInitialLoad = false;

// ── Cache Invalidation ───────────────────────────────────────────────────
// Original: xlI
// Called when CLAUDE.md files change (file watcher, /refresh command)
function invalidateClaudeMdCache(newConfig) {
  configOverride = newConfig;
  loadClaudeMdFiles.cache.clear?.();
  loadUserContext.cache.clear?.();
}

// ── Auto Memory Check ────────────────────────────────────────────────────
// Original: ff
// Determines if auto-memory (MEMORY.md) feature is enabled.
function isAutoMemoryEnabled() {
  const envDisable = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  if (isEnabled(envDisable)) return false;
  if (isDisabled(envDisable)) return true;

  // Remote mode without explicit memory dir → disabled
  if (isEnabled(process.env.CLAUDE_CODE_REMOTE) && !process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    return false;
  }

  const config = getConfig();
  if (config.autoMemoryEnabled !== undefined) return config.autoMemoryEnabled;

  return true;  // enabled by default
}

// ── System Context Builder ───────────────────────────────────────────────
// Original: q5 (memoized)
// Builds the system context: git status + any injected context.
const buildSystemContext = memoize(async () => {
  const startTime = Date.now();
  logInfo("info", "system_context_started");

  const gitStatus = isEnabled(process.env.CLAUDE_CODE_REMOTE) ? null : await loadGitStatus();

  logInfo("info", "system_context_completed", {
    duration_ms: Date.now() - startTime,
    has_git_status: gitStatus !== null,
  });

  return {
    ...(gitStatus ? { gitStatus } : {}),
  };
});

// ── User Context Builder ─────────────────────────────────────────────────
// Original: u4 (memoized)
// Builds user context: CLAUDE.md content + current date.
const buildUserContext = memoize(async () => {
  const startTime = Date.now();
  logInfo("info", "user_context_started");

  const claudeMdDisabled = process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS
    || isEnabled(process.env.CLAUDE_CODE_SIMPLE);
  const claudeMdContent = claudeMdDisabled ? null : formatClaudeMdContent();

  logInfo("info", "user_context_completed", {
    duration_ms: Date.now() - startTime,
    claudemd_length: claudeMdContent?.length ?? 0,
    claudemd_disabled: Boolean(claudeMdDisabled),
  });

  return {
    ...(claudeMdContent ? { claudeMd: claudeMdContent } : {}),
    currentDate: `Today's date is ${getFormattedDate()}.`,
  };
});
