import { describe, expect, it } from 'vitest';
import { hasTerminalUserActivity, nextTerminalInputPending } from './terminalInputPending';

describe('nextTerminalInputPending', () => {
  it('marks printable terminal input as pending', () => {
    expect(nextTerminalInputPending(false, 'hello')).toBe(true);
  });

  it('marks pasted terminal text as pending', () => {
    expect(nextTerminalInputPending(false, 'line one\nline two')).toBe(true);
  });

  it('clears pending input on Enter', () => {
    expect(nextTerminalInputPending(true, '\r')).toBe(false);
    expect(nextTerminalInputPending(false, 'hello\r')).toBe(false);
  });

  it('clears pending input on Ctrl-C and Ctrl-U', () => {
    expect(nextTerminalInputPending(true, '\x03')).toBe(false);
    expect(nextTerminalInputPending(true, '\x15')).toBe(false);
    expect(nextTerminalInputPending(false, 'hello\x15')).toBe(false);
  });

  it('does not mark cursor escape sequences as pending input', () => {
    expect(nextTerminalInputPending(false, '\x1b[A')).toBe(false);
    expect(nextTerminalInputPending(false, '\x1b[B')).toBe(false);
    expect(nextTerminalInputPending(true, '\x1b[D')).toBe(true);
  });

  it('does not treat terminal focus events as user activity', () => {
    expect(hasTerminalUserActivity('\x1b[I')).toBe(false);
    expect(hasTerminalUserActivity('\x1b[O')).toBe(false);
    expect(nextTerminalInputPending(false, '\x1b[I')).toBe(false);
    expect(nextTerminalInputPending(false, '\x1b[O')).toBe(false);
  });

  it('treats non-focus terminal input as user activity', () => {
    expect(hasTerminalUserActivity('hello')).toBe(true);
    expect(hasTerminalUserActivity('\r')).toBe(true);
    expect(hasTerminalUserActivity('\x1b[A')).toBe(true);
    expect(hasTerminalUserActivity('\x7f')).toBe(true);
  });

  it('ignores bracketed paste markers but keeps pasted text pending', () => {
    expect(nextTerminalInputPending(false, '\x1b[200~hello\x1b[201~')).toBe(true);
  });

  it('does not make a backspace on a clean line pending', () => {
    expect(nextTerminalInputPending(false, '\x7f')).toBe(false);
    expect(nextTerminalInputPending(true, '\x7f')).toBe(true);
  });
});
