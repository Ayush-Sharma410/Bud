const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

function formatWithTimestamp(args: any[]) {
  // Use local time for easier reading in the terminal
  const now = new Date();
  const ts = `[${now.toISOString()}]`;
  if (args.length > 0 && typeof args[0] === 'string') {
    return [`${ts} ${args[0]}`, ...args.slice(1)];
  }
  return [ts, ...args];
}

console.log = (...args) => originalLog(...formatWithTimestamp(args));
console.error = (...args) => originalError(...formatWithTimestamp(args));
console.warn = (...args) => originalWarn(...formatWithTimestamp(args));
console.info = (...args) => originalInfo(...formatWithTimestamp(args));
