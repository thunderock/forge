export type PtyOutput =
  | { type: 'Data'; data: string } // base64-encoded
  | {
      type: 'Exit';
      data: { exit_code: number | null; signal: string | null; last_output: string[] };
    };

export interface AgentDef {
  id: string;
  name: string;
  command: string;
  args: string[];
  resume_args: string[];
  skip_permissions_args: string[];
  description: string;
  available?: boolean;
  /** Per-agent override for the stability-check delay (ms) used before auto-sending
   *  the initial prompt.  Agents with multi-step init dialogs need a longer wait. */
  prompt_ready_delay_ms?: number;
  /** CLI flag used to pass an MCP config path to this agent. Omit when unsupported. */
  mcp_config_flag?: string;
  /** Selected model id/alias for this run, or undefined for the host CLI default
   *  (undefined = no model flag is emitted at launch). */
  model?: string;
  /** Reasoning effort: claude `--effort` (low|medium|high|xhigh|max) or codex
   *  `model_reasoning_effort` (low|medium|high|xhigh); undefined = none. */
  reasoningEffort?: string;
}

/** One visible codex model from `~/.codex/models_cache.json`, as returned by
 *  IPC.ListCodexModels. Mirrors the main-process shape in electron/ipc/agents.ts
 *  (duplicated across processes like AgentDef — renderer must not import electron/). */
export interface CodexModelInfo {
  slug: string;
  displayName: string;
  description?: string;
  defaultEffort?: string;
  efforts: string[];
}

export interface PersonalitySummary {
  id: string;
  name: string;
  badge: string;
  color: string;
  builtin: boolean;
  modifiedFromSeed: boolean;
}

export type PersonalityDefaultAgent = 'claude-code' | 'codex' | 'opencode';

export interface PersonalityDetail extends PersonalitySummary {
  markdown: string;
  defaultAgent?: PersonalityDefaultAgent;
  defaultModel?: string;
  defaultReasoningEffort?: string;
}

export interface PersonalityWriteFields {
  name: string;
  badge: string;
  color: string;
  markdown: string;
  defaultAgent?: PersonalityDefaultAgent;
  defaultModel?: string;
  defaultReasoningEffort?: string;
}

export interface CreateTaskResult {
  id: string;
  branch_name: string;
  worktree_path: string;
}

export interface ChangedFile {
  path: string;
  lines_added: number;
  lines_removed: number;
  status: string;
  committed: boolean;
}

export interface CoverageMetricSummary {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

export interface CoverageFileSummary {
  path: string;
  lines: CoverageMetricSummary;
  statements: CoverageMetricSummary;
  functions: CoverageMetricSummary;
  branches: CoverageMetricSummary;
}

export interface CoverageSummary {
  format: 'istanbul-summary' | 'lcov';
  generatedAt: string;
  reportPath: string;
  totals: Omit<CoverageFileSummary, 'path'>;
  files: Record<string, CoverageFileSummary>;
}

export interface WorktreeStatus {
  has_committed_changes: boolean;
  has_uncommitted_changes: boolean;
  current_branch: string | null;
}

export interface ImportableWorktree {
  path: string;
  branch_name: string;
  has_committed_changes: boolean;
  has_uncommitted_changes: boolean;
}

export interface MergeStatus {
  main_ahead_count: number;
  conflicting_files: string[];
  base_branch: string;
}

export interface MergeResult {
  main_branch: string;
  lines_added: number;
  lines_removed: number;
}

export interface FileDiffResult {
  diff: string;
  oldContent: string;
  newContent: string;
}

export interface CommitInfo {
  hash: string;
  message: string;
}

export type PrCheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
export type PrChecksOverall = 'pending' | 'success' | 'failure' | 'none';

export interface PrCheckRun {
  name: string;
  bucket: PrCheckBucket;
}

export interface PrChecksUpdatePayload {
  taskId: string;
  overall: PrChecksOverall;
  passing: number;
  pending: number;
  failing: number;
  checks: PrCheckRun[];
  checkedAt: string;
  /** True when the main process has stopped watching this task (PR merged or
   *  closed). The renderer should drop its bookkeeping so a later restart of
   *  the watcher (e.g. PR reopened) goes through cleanly. */
  cleared: boolean;
}

export interface BranchPrDetectionResult {
  url: string | null;
  unavailable?: 'missing' | 'auth';
}

export interface StepEntry {
  summary: string;
  detail?: string;
  next?: string;
  status: 'starting' | 'investigating' | 'implementing' | 'testing' | 'awaiting_review' | 'done';
  files_touched?: string[];
  /** Optional sub-agent identifier — short label (e.g. "auth-worker") so the UI can
   *  group entries written on behalf of delegated work. Omit for the top-level agent. */
  agent_id?: string;
  timestamp: string;
}
