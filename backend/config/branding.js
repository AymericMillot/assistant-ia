import fs from "fs";
import path from "path";
import { logger } from "./logger.js";

const defaultBrandingPath = path.resolve(process.cwd(), "config/branding.default.json");
const brandingDataPath = path.resolve(
  process.cwd(),
  process.env.BRANDING_PATH || "data/branding.json"
);

// Contact d'urgence fixe (developpeur du projet) : non configurable par
// instance, ni depuis l'administration. Le support technique courant
// (supportEmail) reste lui entierement personnalisable par instance.
const fixedEmergencySupportEmail = "hello@aymericmillot.com";

let cachedBranding = null;
let cachedBrandingMtimeMs = null;

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function loadDefaultBranding() {
  try {
    return readJsonFile(defaultBrandingPath);
  } catch (error) {
    logger.error("Impossible de lire la configuration de branding par defaut.", {
      message: error.message
    });
    return {
      projectName: "Assistant local",
      shortName: "L'assistant",
      welcomeMessage: "",
      supportEmail: "",
      supportEmailUrgent: fixedEmergencySupportEmail,
      tabTitle: "",
      faviconDataUrl: ""
    };
  }
}

export function readBranding() {
  const defaults = loadDefaultBranding();

  let overrides = {};
  try {
    const stat = fs.statSync(brandingDataPath);
    if (cachedBranding && cachedBrandingMtimeMs === stat.mtimeMs) {
      return cachedBranding;
    }
    overrides = readJsonFile(brandingDataPath);
    cachedBrandingMtimeMs = stat.mtimeMs;
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("Configuration de branding illisible, utilisation des valeurs par defaut.", {
        message: error.message
      });
    }
  }

  const merged = { ...defaults, ...overrides, supportEmailUrgent: fixedEmergencySupportEmail };

  cachedBranding = merged;
  return merged;
}

export function getBranding() {
  return readBranding();
}

export function writeBranding(partialUpdate) {
  const current = readBranding();
  const next = { ...current, ...partialUpdate, supportEmailUrgent: fixedEmergencySupportEmail };

  fs.mkdirSync(path.dirname(brandingDataPath), { recursive: true });
  fs.writeFileSync(brandingDataPath, JSON.stringify(next, null, 2), "utf8");
  cachedBranding = null;
  cachedBrandingMtimeMs = null;

  return readBranding();
}
