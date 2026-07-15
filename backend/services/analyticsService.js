import {
  getAverageChatDurationMs,
  getRecentChatMetrics,
  insertChatMetric
} from "../config/db.js";

const defaultPromptTokens = 900;
const defaultOutputTokens = 180;
const defaultFixedOverheadMs = 2200;
const defaultPromptMsPerToken = 11;
const defaultEvalMsPerToken = 28;
const defaultUsageTimezone = process.env.ACCESS_PASSWORD_TIMEZONE || "Europe/Paris";

function toUtcDate(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).includes("T")
    ? String(value)
    : `${String(value).replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getHourInTimeZone(date, timeZone = defaultUsageTimezone) {
  const formatter = new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    hourCycle: "h23",
    timeZone
  });
  return Number(formatter.format(date));
}

export function computeQuestionFeatures(question) {
  const normalized = `${question || ""}`.trim();
  const charCount = normalized.length;
  const wordCount = normalized ? normalized.split(/\s+/).filter(Boolean).length : 0;
  const lineCount = normalized ? normalized.split(/\n/).length : 0;
  const heuristicUserTokens = normalized
    ? Math.max(1, Math.round(Math.max(charCount / 4, wordCount * 1.2)))
    : 0;

  return {
    charCount,
    wordCount,
    lineCount,
    heuristicUserTokens
  };
}

function nanosecondsToMilliseconds(value) {
  if (!value || Number.isNaN(Number(value))) {
    return 0;
  }

  return Number(value) / 1_000_000;
}

export function recordChatMetric({
  question,
  folderName,
  modelName,
  prompt,
  responseText,
  queueDelayMs,
  processingDurationMs,
  sourceCount,
  ollamaPayload
}) {
  const features = computeQuestionFeatures(question);

  insertChatMetric({
    modelName,
    folderName,
    questionCharCount: features.charCount,
    questionWordCount: features.wordCount,
    questionLineCount: features.lineCount,
    promptCharCount: prompt.length,
    outputCharCount: responseText.length,
    promptEvalCount: Number(ollamaPayload?.prompt_eval_count || 0),
    evalCount: Number(ollamaPayload?.eval_count || 0),
    loadDurationMs: nanosecondsToMilliseconds(ollamaPayload?.load_duration),
    promptEvalDurationMs: nanosecondsToMilliseconds(ollamaPayload?.prompt_eval_duration),
    evalDurationMs: nanosecondsToMilliseconds(ollamaPayload?.eval_duration),
    totalDurationMs:
      nanosecondsToMilliseconds(ollamaPayload?.total_duration) || processingDurationMs || 0,
    queueDelayMs: queueDelayMs || 0,
    processingDurationMs: processingDurationMs || 0,
    sourceCount: sourceCount || 0
  });
}

export function getHistoricalAverageTotalDurationMs(modelName = null) {
  return getAverageChatDurationMs({ modelName, limit: 100 });
}

function pickDataset(modelName, folderName) {
  const exact = getRecentChatMetrics({ modelName, folderName, limit: 180 });
  if (exact.length >= 12) {
    return { rows: exact.reverse(), scope: "exact" };
  }

  const byModel = getRecentChatMetrics({ modelName, limit: 240 });
  if (byModel.length >= 12) {
    return { rows: byModel.reverse(), scope: "modele" };
  }

  const globalRows = getRecentChatMetrics({ limit: 300 });
  return { rows: globalRows.reverse(), scope: "global" };
}

function trimmedMean(values, trimRatio = 0.1) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const trimCount = Math.floor(sorted.length * trimRatio);
  const sliced = sorted.slice(trimCount, sorted.length - trimCount || sorted.length);
  const total = sliced.reduce((sum, value) => sum + value, 0);
  return total / sliced.length;
}

function solveLinearSystem(matrix, vector) {
  const n = matrix.length;
  const a = matrix.map((row, rowIndex) => [...row, vector[rowIndex]]);

  for (let column = 0; column < n; column += 1) {
    let pivot = column;

    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) {
        pivot = row;
      }
    }

    if (Math.abs(a[pivot][column]) < 1e-9) {
      return null;
    }

    [a[column], a[pivot]] = [a[pivot], a[column]];
    const divisor = a[column][column];

    for (let innerColumn = column; innerColumn <= n; innerColumn += 1) {
      a[column][innerColumn] /= divisor;
    }

    for (let row = 0; row < n; row += 1) {
      if (row === column) {
        continue;
      }

      const factor = a[row][column];
      for (let innerColumn = column; innerColumn <= n; innerColumn += 1) {
        a[row][innerColumn] -= factor * a[column][innerColumn];
      }
    }
  }

  return a.map((row) => row[n]);
}

function fitRegression(rows, featureSelector, targetSelector) {
  if (rows.length < 6) {
    return null;
  }

  const dimensions = featureSelector(rows[0]).length;
  const xtx = Array.from({ length: dimensions }, () => Array(dimensions).fill(0));
  const xty = Array(dimensions).fill(0);

  rows.forEach((row, index) => {
    const x = featureSelector(row);
    const y = targetSelector(row);
    const weight = 0.985 ** (rows.length - index - 1);

    for (let i = 0; i < dimensions; i += 1) {
      xty[i] += weight * x[i] * y;
      for (let j = 0; j < dimensions; j += 1) {
        xtx[i][j] += weight * x[i] * x[j];
      }
    }
  });

  return solveLinearSystem(xtx, xty);
}

function predictWithRegression(coefficients, features) {
  if (!coefficients) {
    return null;
  }

  return coefficients.reduce((sum, coefficient, index) => sum + coefficient * features[index], 0);
}

function buildTimingModel(rows) {
  const promptMsPerToken = trimmedMean(
    rows
      .filter((row) => Number(row.prompt_eval_count) > 0 && Number(row.prompt_eval_duration_ms) > 0)
      .map((row) => Number(row.prompt_eval_duration_ms) / Number(row.prompt_eval_count))
  );

  const evalMsPerToken = trimmedMean(
    rows
      .filter((row) => Number(row.eval_count) > 0 && Number(row.eval_duration_ms) > 0)
      .map((row) => Number(row.eval_duration_ms) / Number(row.eval_count))
  );

  const fixedOverheadMs = trimmedMean(
    rows
      .map((row) => {
        const fixed =
          Number(row.total_duration_ms || 0) -
          Number(row.prompt_eval_duration_ms || 0) -
          Number(row.eval_duration_ms || 0);
        return fixed > 0 ? fixed : Number(row.load_duration_ms || 0);
      })
      .filter((value) => value >= 0)
  );

  return {
    promptMsPerToken: promptMsPerToken || defaultPromptMsPerToken,
    evalMsPerToken: evalMsPerToken || defaultEvalMsPerToken,
    fixedOverheadMs: fixedOverheadMs || defaultFixedOverheadMs
  };
}

export function getLiveChatEstimate({ question, folderName = "all", modelName, queueDepth = 0 }) {
  const features = computeQuestionFeatures(question);
  const { rows, scope } = pickDataset(modelName, folderName);
  const sampleCount = rows.length;

  const promptRegression = fitRegression(
    rows.filter((row) => Number(row.prompt_eval_count) > 0),
    (row) => [1, Number(row.question_char_count), Number(row.question_word_count)],
    (row) => Number(row.prompt_eval_count)
  );

  const promptPrediction =
    predictWithRegression(promptRegression, [1, features.charCount, features.wordCount]) ||
    defaultPromptTokens + features.heuristicUserTokens;
  const estimatedPromptTokens = Math.max(
    Math.max(160, features.heuristicUserTokens + 64),
    Math.round(promptPrediction)
  );

  const outputRegression = fitRegression(
    rows.filter((row) => Number(row.eval_count) > 0),
    (row) => [1, Number(row.prompt_eval_count), Number(row.question_word_count)],
    (row) => Number(row.eval_count)
  );

  const estimatedOutputTokens = Math.max(
    48,
    Math.round(
      predictWithRegression(outputRegression, [1, estimatedPromptTokens, features.wordCount]) ||
        defaultOutputTokens
    )
  );

  const timingModel = buildTimingModel(rows);
  const estimatedProcessingMs = Math.max(
    1500,
    Math.round(
      timingModel.fixedOverheadMs +
        estimatedPromptTokens * timingModel.promptMsPerToken +
        estimatedOutputTokens * timingModel.evalMsPerToken
    )
  );

  const historicalAverageMs = getHistoricalAverageTotalDurationMs(modelName) || estimatedProcessingMs;
  const estimatedQueueWaitMs = Math.max(0, Math.round(queueDepth * historicalAverageMs));
  const estimatedTotalMs = estimatedQueueWaitMs + estimatedProcessingMs;

  const confidenceScore = Math.max(
    0.25,
    Math.min(
      0.96,
      0.32 + Math.min(sampleCount, 80) / 100 - (scope === "global" ? 0.08 : scope === "modele" ? 0.03 : 0)
    )
  );

  return {
    userTokenEstimate: features.heuristicUserTokens,
    estimatedPromptTokens,
    estimatedOutputTokens,
    estimatedQueueWaitSeconds: Math.round(estimatedQueueWaitMs / 1000),
    estimatedProcessingSeconds: Math.round(estimatedProcessingMs / 1000),
    estimatedResponseSeconds: Math.round(estimatedTotalMs / 1000),
    sampleCount,
    scope,
    confidenceScore: Number(confidenceScore.toFixed(2))
  };
}

export function getUsageHeatmap({ timeZone = defaultUsageTimezone, days = 30, limit = 5000 } = {}) {
  const rows = getRecentChatMetrics({ limit });
  const now = Date.now();
  const lookbackMs = Math.max(1, days) * 24 * 60 * 60 * 1000;
  const buckets = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    requestCount: 0,
    totalDurationMs: 0,
    averageDurationMs: 0,
    usageScore: 0
  }));

  rows.forEach((row) => {
    const createdAt = toUtcDate(row.created_at);
    if (!createdAt) {
      return;
    }

    if (now - createdAt.getTime() > lookbackMs) {
      return;
    }

    const hour = getHourInTimeZone(createdAt, timeZone);
    const bucket = buckets[hour];
    bucket.requestCount += 1;
    bucket.totalDurationMs += Number(row.total_duration_ms || 0);
  });

  const maxRequests = Math.max(1, ...buckets.map((bucket) => bucket.requestCount));
  const maxDuration = Math.max(1, ...buckets.map((bucket) => bucket.totalDurationMs));

  buckets.forEach((bucket) => {
    bucket.averageDurationMs = bucket.requestCount
      ? Math.round(bucket.totalDurationMs / bucket.requestCount)
      : 0;
    bucket.usageScore = Number(
      (
        (bucket.requestCount / maxRequests) * 0.7 + (bucket.totalDurationMs / maxDuration) * 0.3
      ).toFixed(3)
    );
  });

  return buckets;
}

export function getCurrentUsageWindowAnalysis({
  timeZone = defaultUsageTimezone,
  days = 30,
  limit = 5000
} = {}) {
  const heatmap = getUsageHeatmap({ timeZone, days, limit });
  const currentHour = getHourInTimeZone(new Date(), timeZone);
  const currentBucket = heatmap[currentHour];
  const sortedScores = heatmap.map((bucket) => bucket.usageScore).sort((a, b) => a - b);
  const quietThreshold = sortedScores[Math.min(sortedScores.length - 1, 7)] || 0;
  const peakThreshold = sortedScores[Math.max(0, sortedScores.length - 5)] || 1;

  return {
    timeZone,
    currentHour,
    currentBucket,
    quietThreshold: Number(quietThreshold.toFixed(3)),
    peakThreshold: Number(peakThreshold.toFixed(3)),
    isQuietWindow: currentBucket.usageScore <= quietThreshold,
    isPeakWindow: currentBucket.usageScore >= peakThreshold,
    quietHours: heatmap
      .filter((bucket) => bucket.usageScore <= quietThreshold)
      .map((bucket) => bucket.hour),
    peakHours: heatmap
      .filter((bucket) => bucket.usageScore >= peakThreshold)
      .map((bucket) => bucket.hour),
    heatmap
  };
}
