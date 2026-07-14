export interface AgentFrameFixture {
  name: string;
  frame: string;
}

export interface NotReadyAgentFrameFixture extends AgentFrameFixture {
  reason: 'startup_or_dialog' | 'busy' | 'no_prompt';
}

export const READY_AGENT_FRAME_FIXTURES: AgentFrameFixture[] = [
  {
    name: 'Claude prompt above long status footer',
    frame: [
      '│ >',
      '❯',
      '',
      'opus · /Users/brooksc/git/forge/.worktrees/task-023-10-loading-states · ctx:24k/200k',
    ].join('\n'),
  },
  {
    name: 'Claude empty insert mode at fresh prompt',
    frame: [
      '│ >',
      '-- INSERT --',
      'opus · /Users/brooksc/git/forge/.worktrees/task-029-linting · ctx:0/200k',
    ].join('\n'),
  },
  {
    name: 'Claude insert mode with inline status footer',
    frame: [
      '▐▛███▜▌ Claude Code v2.1.153',
      '────────────────────────────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────────────────────────────',
      '--INSERT--⏵⏵ bypass permissions on (shift+tab to cycle)',
      'Sonnet 4 | ~/git/forge/.worktrees/task/example',
    ].join('\r'),
  },
  {
    name: 'Codex prompt above long status footer',
    frame: [
      '›',
      '',
      'gpt-5.5 default · /Users/brooksc/git/forge/.worktrees/task-028-unit-tests',
    ].join('\n'),
  },
  {
    name: 'Gemini typed-message prompt',
    frame: [
      'workspace /Users/brooksc/git/forge/.worktrees/task-gemini branch sandbox',
      '> Type your message or @path/to/file',
    ].join('\n'),
  },
];

export const NOT_READY_AGENT_FRAME_FIXTURES: NotReadyAgentFrameFixture[] = [
  {
    name: 'Codex still working with visible input line',
    reason: 'busy',
    frame: [
      '› Implement the requested fix',
      'gpt-5.5 default · /Users/brooksc/git/forge/.worktrees/task-028-unit-tests',
      'Working (18m 51s • esc to interrupt) • 1 background terminal running • /stop to close',
    ].join('\n'),
  },
  {
    name: 'Codex MCP startup screen',
    reason: 'startup_or_dialog',
    frame: ['Starting MCP servers (0/2): codex_apps, forge', 'Booting MCP server forge', '›'].join(
      '\n',
    ),
  },
  {
    name: 'Agent trust dialog',
    reason: 'startup_or_dialog',
    frame: [
      'Do you trust the contents of this directory?',
      '› 1. Yes, continue',
      '2. No, quit',
      'Press enter to continue',
    ].join('\n'),
  },
  {
    name: 'TUI selection menu',
    reason: 'no_prompt',
    frame: ['❯ Option A', '  Option B', '  Option C', 'Choose an option to continue'].join('\n'),
  },
  {
    // Two-option selection cursor: `❯ Yes` is a selection cursor, NOT the bare
    // agent prompt. The line-anchored ready pattern `^\s*❯\s*$` requires a lone
    // ❯, which `❯ Yes` fails — so it must read not-ready (SC4 correctness #2).
    name: 'Two-option ❯ selection cursor',
    reason: 'no_prompt',
    frame: ['❯ Yes', '  No', 'Continue?'].join('\n'),
  },
  {
    // A diff hunk whose body line begins with `>` while the agent is busy. The
    // busy marker (`esc to interrupt`) short-circuits detection to `busy` before
    // any prompt scan runs.
    name: 'Busy diff hunk with quoted > line',
    reason: 'busy',
    frame: ['diff --git a/x b/x', '@@ -1 +1 @@', '> quoted diff line', 'esc to interrupt'].join(
      '\n',
    ),
  },
  {
    // Load-bearing: the SAME quoted `>` diff line with NO busy marker to
    // short-circuit. This proves the line-anchored Gemini ready pattern
    // `^\s*>\s*(?:Type your message|$)` does NOT treat a bare quoted `>` diff
    // line as the `> ` ready prompt — `> quoted diff line` has neither
    // end-of-line nor "Type your message" after `>`, so it reads not-ready
    // via the prompt scan (reason `no_prompt`), not the busy short-circuit.
    name: 'Diff hunk with quoted > line, no busy marker',
    reason: 'no_prompt',
    frame: ['diff --git a/x b/x', '@@ -1 +1 @@', '> quoted diff line'].join('\n'),
  },
];

/**
 * READY frames modelling a just-sent prompt echoed back above the agent's bare
 * prompt marker. Used by 07-02's prompt-echo suppression test and by the
 * broadcast readiness suite (the echoed body followed by a lone ❯/› still reads
 * ready, so a delivered broadcast does not wedge the queue).
 */
export const PROMPT_ECHO_FRAME_FIXTURES: AgentFrameFixture[] = [
  {
    name: 'Claude prompt echo above bare ❯',
    frame: ['Refactor the auth module and add tests', '', '❯'].join('\n'),
  },
  {
    name: 'Codex prompt echo above bare ›',
    frame: ['Summarize the recent changes', '', '›'].join('\n'),
  },
];
