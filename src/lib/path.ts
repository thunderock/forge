export function abbreviateHomePath(path: string): string {
  const prefixes = ['/home/', '/Users/'];
  for (const prefix of prefixes) {
    if (path.startsWith(prefix)) {
      const rest = path.slice(prefix.length);
      const slashIdx = rest.indexOf('/');
      if (slashIdx !== -1) return '~' + rest.slice(slashIdx);
      return '~';
    }
  }
  return path;
}
