#!/usr/bin/env node
/* global process, setTimeout */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const profile = argValue('--profile', 'codex');
const capturePath = argValue('--capture');
const transientReady = process.argv.includes('--transient-ready');

function write(text) {
  process.stdout.write(text);
}

function capture(payload) {
  if (!capturePath) return;
  mkdirSync(dirname(capturePath), { recursive: true });
  appendFileSync(capturePath, `${JSON.stringify({ profile, payload, at: Date.now() })}\n`);
}

function prompt() {
  if (profile === 'codex') {
    write('gpt-5 default  ~/fake-worktree\n› ');
    return;
  }
  write(`${profile} ready\n❯ `);
}

function settledPrompt() {
  write(`\r\n${'ready '.repeat(70)}\r\n`);
  prompt();
}

function transientPromptRedraw() {
  write(`\r\n${'ready '.repeat(70)}\r\n`);
  prompt();
  setTimeout(() => {
    write(`\r\n${`${profile} redraw `.repeat(500)}\r\n`);
  }, 250);
}

function boot() {
  if (profile === 'codex') {
    write('>_ OpenAI Codex (fake)\r\n› Explain this codebase\r\n');
    setTimeout(transientReady ? transientPromptRedraw : prompt, 100);
    return;
  }

  if (profile === 'claude') {
    write('Claude Code (fake)\r\nDo you trust the files in this folder?\r\n❯ Yes  No\r\n');
    setTimeout(() => {
      write('\r\nTrust accepted by fake harness\r\n');
      if (transientReady) {
        transientPromptRedraw();
      } else {
        settledPrompt();
      }
    }, 120);
    return;
  }

  if (profile === 'gemini') {
    write('Gemini CLI (fake)\r\nStarting MCP servers (0/1): parallel-code\r\n');
    setTimeout(() => {
      write('Starting MCP servers complete\r\n');
      if (transientReady) {
        transientPromptRedraw();
      } else {
        settledPrompt();
      }
    }, 120);
    return;
  }

  if (profile === 'copilot') {
    write('Copilot CLI (fake)\r\nConfirm folder trust\r\n❯ Yes  No\r\n');
    setTimeout(() => {
      write('\r\nInitializing instructions\r\n');
      setTimeout(transientReady ? transientPromptRedraw : settledPrompt, 120);
    }, 120);
    return;
  }

  write(`${profile} fake agent\r\n`);
  setTimeout(transientReady ? transientPromptRedraw : prompt, 100);
}

let inputBuffer = '';

process.stdin.setEncoding('utf8');
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  let submitIdx = inputBuffer.indexOf('\r');
  while (submitIdx >= 0) {
    const payload = inputBuffer.slice(0, submitIdx);
    inputBuffer = inputBuffer.slice(submitIdx + 1);
    if (payload.trim()) {
      capture(payload);
      write('\r\nworking...\r\n');
      setTimeout(prompt, 50);
    }
    submitIdx = inputBuffer.indexOf('\r');
  }
});

boot();
