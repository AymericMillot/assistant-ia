import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const serviceStartedAt = new Date();
const deploymentInfoPath = path.resolve(
  process.cwd(),
  process.env.DEPLOYMENT_INFO_PATH || "./data/deployment.json"
);

let lastCpuSample = readCpuSample();
let lastCpuSampleAt = Date.now();

function readCpuSample() {
  try {
    const stat = fs.readFileSync("/proc/stat", "utf8");
    const firstLine = stat.split("\n").find((line) => line.startsWith("cpu "));
    if (!firstLine) {
      return null;
    }

    const parts = firstLine
      .trim()
      .split(/\s+/)
      .slice(1)
      .map((value) => Number(value));

    const idle = (parts[3] || 0) + (parts[4] || 0);
    const total = parts.reduce((sum, value) => sum + value, 0);

    return { idle, total };
  } catch {
    return null;
  }
}

async function runCommand(command, args = [], timeout = 1500) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout,
      maxBuffer: 1024 * 1024
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  Object.values(interfaces).forEach((entries) => {
    (entries || []).forEach((entry) => {
      if (!entry || entry.internal || entry.family !== "IPv4") {
        return;
      }
      addresses.push(entry.address);
    });
  });

  return [...new Set(addresses)];
}

function getExecutionEnvironment() {
  return {
    isDocker: fs.existsSync("/.dockerenv"),
    scopeLabel: fs.existsSync("/.dockerenv")
      ? "Conteneur Docker"
      : "Machine hôte",
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    nodeVersion: process.version,
    localIpAddresses: getLocalIpAddresses()
  };
}

function getDeploymentInfo() {
  const now = Date.now();
  let deployedAt = null;
  let deployedBy = "install.sh";
  let localIp = null;
  let localAccessUrl = null;
  let localhostAccessUrl = null;

  try {
    const payload = JSON.parse(fs.readFileSync(deploymentInfoPath, "utf8"));
    if (payload?.deployedAt) {
      deployedAt = new Date(payload.deployedAt);
    }
    if (payload?.deployedBy) {
      deployedBy = payload.deployedBy;
    }
    if (payload?.localIp) {
      localIp = payload.localIp;
    }
    if (payload?.localAccessUrl) {
      localAccessUrl = payload.localAccessUrl;
    }
    if (payload?.localhostAccessUrl) {
      localhostAccessUrl = payload.localhostAccessUrl;
    }
  } catch {
    deployedAt = null;
  }

  const fallbackDate = serviceStartedAt;
  const effectiveDeploymentDate =
    deployedAt instanceof Date && !Number.isNaN(deployedAt.getTime()) ? deployedAt : fallbackDate;

  return {
    deployedAt: effectiveDeploymentDate.toISOString(),
    deployedBy,
    localIp,
    localAccessUrl,
    localhostAccessUrl,
    deploymentAgeSeconds: Math.max(0, Math.round((now - effectiveDeploymentDate.getTime()) / 1000)),
    backendStartedAt: serviceStartedAt.toISOString(),
    backendUptimeSeconds: Math.round(process.uptime()),
    systemUptimeSeconds: Math.round(os.uptime())
  };
}

function getCpuMetrics() {
  const cpus = os.cpus() || [];
  const loadAverage = os.loadavg();
  const currentSample = readCpuSample();
  const now = Date.now();
  let usagePercent = null;

  if (currentSample && lastCpuSample) {
    const deltaTotal = currentSample.total - lastCpuSample.total;
    const deltaIdle = currentSample.idle - lastCpuSample.idle;
    if (deltaTotal > 0) {
      usagePercent = clamp(((deltaTotal - deltaIdle) / deltaTotal) * 100, 0, 100);
    }
  }

  lastCpuSample = currentSample;
  lastCpuSampleAt = now;

  return {
    model: cpus[0]?.model || "Inconnu",
    logicalCores: cpus.length,
    usagePercent: usagePercent !== null ? Number(usagePercent.toFixed(1)) : null,
    loadAverage1m: Number((loadAverage[0] || 0).toFixed(2)),
    loadAverage5m: Number((loadAverage[1] || 0).toFixed(2)),
    loadAverage15m: Number((loadAverage[2] || 0).toFixed(2)),
    sampledAt: new Date(lastCpuSampleAt).toISOString()
  };
}

function getMemoryMetrics() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  const processMemory = process.memoryUsage();

  return {
    totalBytes,
    freeBytes,
    usedBytes,
    usagePercent: totalBytes > 0 ? Number(((usedBytes / totalBytes) * 100).toFixed(1)) : null,
    processRssBytes: processMemory.rss,
    heapUsedBytes: processMemory.heapUsed,
    heapTotalBytes: processMemory.heapTotal
  };
}

async function getDiskMetric(targetPath, label) {
  const output = await runCommand("df", ["-kP", targetPath]);
  if (!output) {
    return null;
  }

  const lines = output.split("\n").filter(Boolean);
  const lastLine = lines[lines.length - 1];
  const parts = lastLine.trim().split(/\s+/);
  if (parts.length < 6) {
    return null;
  }

  const totalBytes = Number(parts[1] || 0) * 1024;
  const usedBytes = Number(parts[2] || 0) * 1024;
  const availableBytes = Number(parts[3] || 0) * 1024;
  const usePercent = Number(String(parts[4] || "0").replace("%", ""));

  return {
    label,
    path: targetPath,
    totalBytes,
    usedBytes,
    availableBytes,
    usagePercent: Number.isFinite(usePercent) ? usePercent : null
  };
}

async function getDiskMetrics() {
  const candidates = [
    { path: "/app", label: "Application" },
    { path: "/app/data", label: "Données" },
    { path: "/app/uploads", label: "Documents" },
    { path: "/app/logs", label: "Logs" }
  ];

  const items = [];
  for (const candidate of candidates) {
    const metric = await getDiskMetric(candidate.path, candidate.label);
    if (metric) {
      items.push(metric);
    }
  }

  return items;
}

async function getThermalMetrics() {
  const sensors = [];

  try {
    const entries = await fsp.readdir("/sys/class/thermal");
    for (const entry of entries) {
      if (!entry.startsWith("thermal_zone")) {
        continue;
      }

      try {
        const basePath = path.join("/sys/class/thermal", entry);
        const [rawTemp, rawType] = await Promise.all([
          fsp.readFile(path.join(basePath, "temp"), "utf8"),
          fsp.readFile(path.join(basePath, "type"), "utf8").catch(() => "Capteur")
        ]);
        const tempValue = Number(String(rawTemp).trim()) / 1000;
        if (!Number.isFinite(tempValue) || tempValue <= 0 || tempValue > 140) {
          continue;
        }

        sensors.push({
          label: String(rawType).trim() || entry,
          celsius: Number(tempValue.toFixed(1))
        });
      } catch {
        // Ignore invalid sensors.
      }
    }
  } catch {
    // Ignore unavailable thermal directory.
  }

  const maxCelsius =
    sensors.length > 0 ? Math.max(...sensors.map((sensor) => sensor.celsius)) : null;
  const averageCelsius =
    sensors.length > 0
      ? Number(
          (
            sensors.reduce((sum, sensor) => sum + Number(sensor.celsius || 0), 0) / sensors.length
          ).toFixed(1)
        )
      : null;

  return {
    available: sensors.length > 0,
    sensors,
    maxCelsius,
    averageCelsius
  };
}

async function getGpuMetrics() {
  const output = await runCommand("nvidia-smi", [
    "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
    "--format=csv,noheader,nounits"
  ]);

  if (!output) {
    return {
      available: false,
      devices: []
    };
  }

  const devices = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, utilization, memoryUsed, memoryTotal, temperature, powerDraw] = line
        .split(",")
        .map((value) => value.trim());

      return {
        name,
        utilizationPercent: Number(utilization),
        memoryUsedMiB: Number(memoryUsed),
        memoryTotalMiB: Number(memoryTotal),
        temperatureCelsius: Number(temperature),
        powerDrawWatts: Number(powerDraw)
      };
    });

  return {
    available: devices.length > 0,
    devices
  };
}

function buildWarnings(environment, thermal, gpu) {
  const warnings = [];

  if (environment.isDocker) {
    warnings.push(
      "Certaines mesures peuvent provenir de l'environnement Docker et non directement de toute la machine hôte."
    );
  }

  if (!thermal.available) {
    warnings.push("La température n'est pas accessible dans l'environnement actuel.");
  }

  if (!gpu.available) {
    warnings.push("Aucun GPU exploitable n'a été détecté ou exposé au conteneur.");
  }

  return warnings;
}

export async function getPerformanceSnapshot() {
  const environment = getExecutionEnvironment();
  const deployment = getDeploymentInfo();
  const cpu = getCpuMetrics();
  const memory = getMemoryMetrics();
  const [storage, thermal, gpu] = await Promise.all([
    getDiskMetrics(),
    getThermalMetrics(),
    getGpuMetrics()
  ]);

  return {
    collectedAt: new Date().toISOString(),
    environment,
    deployment,
    cpu,
    memory,
    storage,
    thermal,
    gpu,
    warnings: buildWarnings(environment, thermal, gpu)
  };
}
