const defaultRequestTimeoutMs = 20000;
const defaultRetryDelayMs = 900;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldRetryResponse(response) {
  return [408, 425, 429, 500, 502, 503, 504].includes(response.status);
}

function isNetworkLikeError(error) {
  return (
    error?.name === "AbortError" ||
    error?.message === "Load failed" ||
    error?.message === "Failed to fetch" ||
    /networkerror/i.test(String(error?.message || "")) ||
    /fetch/i.test(String(error?.message || ""))
  );
}

function buildOverloadError() {
  return new Error(
    "Le serveur est temporairement tres sollicite. Reessayez dans quelques secondes."
  );
}

export async function fetchJson(url, options = {}) {
  const {
    timeoutMs = defaultRequestTimeoutMs,
    retryCount = ((options.method || "GET").toUpperCase() === "GET" ? 2 : 0),
    retryDelayMs = defaultRetryDelayMs,
    headers,
    signal,
    ...fetchOptions
  } = options;

  let lastError = null;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    let cleanupAbortForward = null;
    const timeoutId =
      timeoutMs > 0
        ? setTimeout(() => {
            controller.abort(new Error("timeout"));
          }, timeoutMs)
        : null;

    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        cleanupAbortForward = () => controller.abort(signal.reason);
        signal.addEventListener("abort", cleanupAbortForward, { once: true });
      }
    }

    try {
      const response = await fetch(url, {
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(headers || {})
        },
        ...fetchOptions,
        signal: controller.signal
      });

      const contentType = response.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await response.json()
        : { message: await response.text() };

      if (!response.ok) {
        const message = payload.message || "Une erreur est survenue.";

        if (response.status === 401 && typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("admin-auth-required", {
              detail: {
                message
              }
            })
          );
        }

        if (attempt < retryCount && shouldRetryResponse(response)) {
          await sleep(retryDelayMs * (attempt + 1));
          continue;
        }

        const error = new Error(message);
        error.statusCode = response.status;
        throw error;
      }

      return payload;
    } catch (error) {
      lastError = error;

      if (attempt < retryCount && isNetworkLikeError(error)) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }

      if (isNetworkLikeError(error)) {
        throw buildOverloadError();
      }

      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (signal && cleanupAbortForward) {
        signal.removeEventListener("abort", cleanupAbortForward);
      }
    }
  }

  if (isNetworkLikeError(lastError)) {
    throw buildOverloadError();
  }

  throw lastError || new Error("Une erreur est survenue.");
}

export function formatDateTime(value) {
  if (!value) {
    return "Jamais";
  }

  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function formatDuration(seconds) {
  const numericSeconds = Number(seconds);

  if (!Number.isFinite(numericSeconds) || numericSeconds <= 0) {
    return "0 s";
  }

  if (numericSeconds < 10) {
    return `${numericSeconds.toFixed(1).replace(".0", "")} s`;
  }

  if (numericSeconds < 60) {
    return `${Math.round(numericSeconds)} s`;
  }

  const minutes = Math.floor(numericSeconds / 60);
  const remainingSeconds = Math.round(numericSeconds % 60);
  if (remainingSeconds === 0) {
    return `${minutes} minute${minutes > 1 ? "s" : ""}`;
  }

  return `${minutes} min ${remainingSeconds}s`;
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return "0 o";
  }

  const units = ["o", "Ko", "Mo", "Go", "To"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const precision = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision).replace(".0", "")} ${units[unitIndex]}`;
}

export function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "Indisponible";
  }

  return `${numeric.toFixed(numeric >= 10 ? 0 : 1).replace(".0", "")} %`;
}
