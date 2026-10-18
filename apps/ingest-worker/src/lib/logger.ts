type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

/** LOG_LEVEL=debug turns on per-tick/per-candle detail (off by default: Perf #5). */
const debugEnabled = (process.env.LOG_LEVEL ?? "").trim().toLowerCase() === "debug";

function write(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta ? { meta } : {}),
  };

  const line = JSON.stringify(payload);

  if (level === "ERROR") {
    console.error(line);
    return;
  }

  console.log(line);
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>) {
    if (debugEnabled) write("DEBUG", message, meta);
  },
  info(message: string, meta?: Record<string, unknown>) {
    write("INFO", message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>) {
    write("WARN", message, meta);
  },
  error(message: string, meta?: Record<string, unknown>) {
    write("ERROR", message, meta);
  },
};
