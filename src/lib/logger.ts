/**
 * Simple structured logger. Prefixes every line with timestamp + source.
 * Color-coded for terminal readability.
 */

const COLORS = {
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

function timestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function log(source: string, message: string, ...args: unknown[]) {
  console.log(
    `${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.cyan}${source}${COLORS.reset} ${message}`,
    ...args,
  );
}

export function hit(source: string, message: string) {
  console.log(
    `${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.green}${COLORS.bold}>>> HIT${COLORS.reset} ${COLORS.green}${message}${COLORS.reset}`,
  );
}

export function verify(source: string, message: string) {
  console.log(
    `${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.yellow}${COLORS.bold}!! VERIFY${COLORS.reset} ${COLORS.yellow}${message}${COLORS.reset}`,
  );
}

export function skip(source: string, message: string) {
  console.log(
    `${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.dim}SKIP ${message}${COLORS.reset}`,
  );
}

export function error(source: string, message: string, err?: unknown) {
  console.error(
    `${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.red}ERROR ${source}${COLORS.reset} ${message}`,
    err instanceof Error ? err.message : err ?? "",
  );
}

export function section(title: string) {
  console.log(`\n${COLORS.bold}${COLORS.magenta}═══ ${title} ═══${COLORS.reset}`);
}

export function progress(current: number, total: number, label: string) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const bar = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));
  process.stdout.write(
    `\r${COLORS.dim}${bar} ${pct}% ${current}/${total} ${label}${COLORS.reset}`,
  );
  if (current >= total) process.stdout.write("\n");
}
