import fs from "fs";
import path from "path";
import winston from "winston";

const logsDir = path.resolve(process.cwd(), process.env.LOGS_DIR || "./logs");
fs.mkdirSync(logsDir, { recursive: true });

const maxBufferedLogs = 50;
// Rotation integree a winston : sans elle, app.log grossissait indefiniment sur
// un serveur qui tourne des mois. tailable = le fichier courant garde son nom.
const logFileRotation = {
  maxsize: Math.max(1, Number(process.env.LOG_MAX_SIZE_MB || 20)) * 1024 * 1024,
  maxFiles: Math.max(1, Number(process.env.LOG_MAX_FILES || 5)),
  tailable: true
};
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
  defaultMeta: { service: "assistant-ia-backend" },
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
    new winston.transports.File({ filename: path.join(logsDir, "app.log"), ...logFileRotation }),
    new winston.transports.File({ filename: path.join(logsDir, "error.log"), level: "error", ...logFileRotation })
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
  transports: [new winston.transports.File({ filename: path.join(logsDir, "indexation.log"), ...logFileRotation })]
});

const hydrateBufferFromDisk = () => {
  const logFilePath = path.join(logsDir, "indexation.log");
  if (!fs.existsSync(logFilePath)) {
    return;
  }

  // Seule la fin du fichier est utile (50 dernieres lignes) : pas de lecture
  // complete d'un journal potentiellement volumineux au demarrage.
  const tailBytes = 128 * 1024;
  let content = "";
  let fileHandle = null;
  try {
    fileHandle = fs.openSync(logFilePath, "r");
    const { size } = fs.fstatSync(fileHandle);
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fileHandle, buffer, 0, buffer.length, start);
    content = buffer.toString("utf8");
    if (start > 0) {
      content = content.slice(content.indexOf("\n") + 1);
    }
  } catch {
    return;
  } finally {
    if (fileHandle !== null) {
      fs.closeSync(fileHandle);
    }
  }

  const lines = content.split("\n").filter(Boolean).slice(-maxBufferedLogs);

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
