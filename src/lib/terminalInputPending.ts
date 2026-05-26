function isCsiTerminator(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function skipEscapeSequence(data: string, index: number): number {
  if (data[index + 1] === '[') {
    let i = index + 2;
    while (i < data.length) {
      if (isCsiTerminator(data[i])) return i;
      i++;
    }
    return data.length - 1;
  }
  return index;
}

function isFocusEventSequence(data: string, start: number, end: number): boolean {
  const seq = data.slice(start, end + 1);
  return seq === '\x1b[I' || seq === '\x1b[O';
}

export function hasTerminalUserActivity(data: string): boolean {
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\x1b') {
      const end = skipEscapeSequence(data, i);
      if (!isFocusEventSequence(data, i, end)) return true;
      i = end;
    } else if (ch === '\r' || ch === '\n' || ch === '\x03' || ch === '\x15') {
      return true;
    } else if (ch === '\x7f') {
      return true;
    } else if (ch >= ' ') {
      return true;
    }
  }
  return false;
}

export function nextTerminalInputPending(currentPending: boolean, data: string): boolean {
  let pending = currentPending;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\r' || ch === '\n' || ch === '\x03' || ch === '\x15') {
      pending = false;
    } else if (ch === '\x1b') {
      i = skipEscapeSequence(data, i);
    } else if (ch === '\x7f') {
      pending = pending || currentPending;
    } else if (ch >= ' ') {
      pending = true;
    }
  }
  return pending;
}
