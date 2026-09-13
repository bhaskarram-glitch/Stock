type LogLevel = "INFO" | "WARN" | "ERROR";

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
