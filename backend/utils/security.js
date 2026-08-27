const rateLimitStores = new Map();
const rateLimitCleanupTimers = new Map();

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function forbiddenError(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

function isPrivateIpv4Host(hostname) {
  if (!hostname || typeof hostname !== "string") {
    return false;
  }

  return /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/.test(
    hostname
  );
}

function isPrivateIpv6Host(hostname) {
  if (!hostname || typeof hostname !== "string") {
    return false;
  }

  const normalized = hostname.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd");
}

function getAllowedLocalPorts() {
  const ports = new Set([
    String(process.env.PORT || "3000"),
    String(process.env.FRONTEND_DEV_PORT || "3001")
  ]);

  [process.env.FRONTEND_ORIGIN, process.env.APP_ORIGIN].filter(Boolean).forEach((value) => {
    try {
      const parsed = new URL(String(value).trim());
      ports.add(parsed.port || (parsed.protocol === "https:" ? "443" : "80"));
    } catch {
      // La validation globale signalera separement une origine configuree invalide.
    }
  });

  return ports;
}

function isTrustedLocalNetworkOrigin(origin) {
  const normalizedOrigin = extractOriginCandidate(origin);
  if (!normalizedOrigin) {
    return false;
  }

  try {
    const parsed = new URL(normalizedOrigin);
    const hostname = parsed.hostname;
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");

    const isLocalHostname =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.endsWith(".local") ||
      isPrivateIpv4Host(hostname) ||
      isPrivateIpv6Host(hostname);

    return isLocalHostname && getAllowedLocalPorts().has(port);
  } catch {
    return false;
  }
}

function getTrustedOrigins() {
  const configuredOrigins = [
    process.env.FRONTEND_ORIGIN,
    process.env.APP_ORIGIN,
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ]
    .filter(Boolean)
    .map((value) => value.trim())
    .filter(Boolean);

  return [...new Set(configuredOrigins)];
}

function extractOriginCandidate(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function extractHostnameFromUrlLike(value) {
  const origin = extractOriginCandidate(value);
  if (!origin) {
    return "";
  }

  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function getRequestHostname(req) {
  const trustProxy = req.app?.get("trust proxy");
  const forwardedHost = trustProxy
    ? String(req.headers["x-forwarded-host"] || "").split(",")[0].trim()
    : "";
  const hostHeader = forwardedHost || String(req.headers.host || "").trim();

  if (!hostHeader) {
    return "";
  }

  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return hostHeader.replace(/:\d+$/, "").toLowerCase();
  }
}

function isSameHostRequest(req, originOrReferer) {
  const requestHostname = getRequestHostname(req);
  const originHostname = extractHostnameFromUrlLike(originOrReferer);

  if (!requestHostname || !originHostname) {
    return false;
  }

  return requestHostname === originHostname;
}

export function isTrustedOrigin(origin) {
  if (!origin) {
    return true;
  }

  const normalizedOrigin = extractOriginCandidate(origin);
  if (!normalizedOrigin) {
    return false;
  }

  return getTrustedOrigins().includes(normalizedOrigin) || isTrustedLocalNetworkOrigin(normalizedOrigin);
}

export function securityHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Origin-Agent-Cluster", "?1");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), browsing-topics=()"
  );
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  next();
}

export function enforceTrustedOrigin(req, _res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  const origin = req.get("origin");
  const referer = req.get("referer");
  if (!origin && !referer) {
    return next();
  }

  if (isTrustedOrigin(origin || referer) || isSameHostRequest(req, origin || referer)) {
    return next();
  }

  return next(forbiddenError("Origine de requete non autorisee."));
}

export function createRateLimiter({
  windowMs,
  max,
  keyPrefix,
  keyGenerator,
  message
}) {
  if (!rateLimitStores.has(keyPrefix)) {
    rateLimitStores.set(keyPrefix, new Map());
  }

  const store = rateLimitStores.get(keyPrefix);
  if (!rateLimitCleanupTimers.has(keyPrefix)) {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [entryKey, bucket] of store.entries()) {
        if (!bucket || bucket.resetAt <= now) {
          store.delete(entryKey);
        }
      }
    }, Math.max(windowMs, 30_000));

    if (typeof timer.unref === "function") {
      timer.unref();
    }

    rateLimitCleanupTimers.set(keyPrefix, timer);
  }

  return (req, res, next) => {
    const key = keyGenerator ? keyGenerator(req) : req.ip || "anonymous";
    const now = Date.now();
    const bucket = store.get(key);

    if (!bucket || bucket.resetAt <= now) {
      store.set(key, {
        count: 1,
        resetAt: now + windowMs
      });
      return next();
    }

    if (bucket.count >= max) {
      res.setHeader("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({
        message
      });
    }

    bucket.count += 1;
    return next();
  };
}

export function parsePositiveInt(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw validationError(`${fieldName} invalide.`);
  }

  return parsed;
}

export function ensureUuidLike(value, fieldName) {
  if (typeof value !== "string") {
    throw validationError(`${fieldName} invalide.`);
  }

  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(trimmed)) {
    throw validationError(`${fieldName} invalide.`);
  }

  return trimmed;
}

export function ensureSafeText(value, fieldName, { min = 0, max = 2000 } = {}) {
  if (typeof value !== "string") {
    throw validationError(`${fieldName} invalide.`);
  }

  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw validationError(`${fieldName} invalide.`);
  }

  return trimmed;
}

export function ensureSafeIdentifier(value, fieldName, { max = 120 } = {}) {
  const trimmed = ensureSafeText(value, fieldName, { min: 1, max });
  if (!/^[a-zA-Z0-9._:-]+$/.test(trimmed)) {
    throw validationError(`${fieldName} invalide.`);
  }

  return trimmed;
}

export function ensureSafeFolderName(value, fieldName = "Nom de dossier") {
  const trimmed = ensureSafeText(value, fieldName, { min: 1, max: 120 });
  if (!/^[\p{L}\p{N} ._-]+$/u.test(trimmed)) {
    throw validationError(`${fieldName} invalide.`);
  }

  return trimmed;
}

export function ensureSafeHttpUrl(value, fieldName = "URL", { max = 2000 } = {}) {
  const trimmed = ensureSafeText(value, fieldName, { min: 5, max });

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw validationError(`${fieldName} invalide.`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw validationError(`${fieldName} invalide.`);
  }

  return parsed.toString();
}

export function ensurePathInside(basePath, targetPath, fieldName = "Chemin") {
  const resolvedBase = new URL(`file://${basePath.endsWith("/") ? basePath : `${basePath}/`}`);
  const resolvedTarget = new URL(`file://${targetPath}`);

  if (!resolvedTarget.href.startsWith(resolvedBase.href)) {
    throw forbiddenError(`${fieldName} invalide.`);
  }

  return targetPath;
}
