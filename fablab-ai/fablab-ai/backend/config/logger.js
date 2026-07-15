import fs from "fs";
import path from "path";
import winston from "winston";

const logsDir = path.resolve(process.cwd(), process.env.LOGS_DIR || "./logs");
fs.mkdirSync(logsDir, { recursive: true });

const maxBufferedLogs = 50;
const indexationBuffer = [];
let realtimeEmitter = null;
const logTimeZone = process.env.LOG_TIMEZONE || "Europe/Paris";

function formatLogTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: logTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  })
    .format(date)
    .replace(",", "");
}

const jsonFormat = winston.format.combine(
  winston.format.timestamp({ format: () => formatLogTimestamp() }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: jsonFormat,
  defaultMeta: { service: "fablab-backend" },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: () => formatLogTimestamp() }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const serializedMeta = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
          return `${timestamp} ${level}: ${message}${serializedMeta}`;
        })
      )
    }),
    new winston.transports.File({ filename: path.join(logsDir, "app.log") }),
    new winston.transports.File({ filename: path.join(logsDir, "error.log"), level: "error" })
  ]
});

const indexationLogger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: () => formatLogTimestamp() }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const serializedMeta = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
      return `${timestamp} [${level.toUpperCase()}] ${message}${serializedMeta}`;
    })
  ),
  transports: [new winston.transports.File({ filename: path.join(logsDir, "indexation.log") })]
});

const hydrateBufferFromDisk = () => {
  const logFilePath = path.join(logsDir, "indexation.log");
  if (!fs.existsSync(logFilePath)) {
    return;
  }

  const lines = fs
    .readFileSync(logFilePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-maxBufferedLogs);

  lines.forEach((line) => {
    const match = line.match(/^(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2})/);
    indexationBuffer.push({
      timestamp: match ? match[1] : line.slice(0, 19),
      level: "info",
      message: line
    });
  });
};

hydrateBufferFromDisk();

export function registerRealtimeEmitter(emitter) {
  realtimeEmitter = emitter;
}

export function logIndexation(message, meta = {}, level = "info") {
  const entry = {
    timestamp: formatLogTimestamp(),
    level,
    message,
    ...meta
  };

  indexationLogger.log({ level, message, ...meta });
  indexationBuffer.push(entry);

  while (indexationBuffer.length > maxBufferedLogs) {
    indexationBuffer.shift();
  }

  if (realtimeEmitter) {
    realtimeEmitter("indexing:log", entry);
  }
}

export function getRecentIndexationLogs() {
  return [...indexationBuffer];
}

export function clearIndexationLogs() {
  indexationBuffer.length = 0;

  const logFilePath = path.join(logsDir, "indexation.log");
  try {
    fs.rmSync(logFilePath, { force: true });
  } catch {
    // Ignore: le but est de purger le fichier s'il existe.
  }
  fs.writeFileSync(logFilePath, "");
}
