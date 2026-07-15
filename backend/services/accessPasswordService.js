import crypto from "crypto";
import bcrypt from "bcrypt";
import { getSetting, setSetting } from "../config/db.js";

const defaultTimeZone = process.env.ACCESS_PASSWORD_TIMEZONE || "Europe/Paris";

function getDateParts(date = new Date(), timeZone = defaultTimeZone) {
  const formatter = new Intl.DateTimeFormat("fr-FR", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  const parts = formatter.formatToParts(date).reduce((accumulator, part) => {
    if (part.type !== "literal") {
      accumulator[part.type] = part.value;
    }
    return accumulator;
  }, {});

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

function buildHourKey(date = new Date(), timeZone = defaultTimeZone) {
  const { year, month, day, hour } = getDateParts(date, timeZone);
  return `${year}${month}${day}${hour}`;
}

function buildDisplayHour(date = new Date(), timeZone = defaultTimeZone) {
  const { day, month, year, hour } = getDateParts(date, timeZone);
  return `${day}/${month}/${year} ${hour}:00`;
}

function baseSecret() {
  return process.env.APP_PASSWORD_SEED || process.env.JWT_SECRET || "fablab-ai-default-seed";
}

export function generateAccessPassword(date = new Date(), timeZone = defaultTimeZone) {
  const hourKey = buildHourKey(date, timeZone);
  const digest = crypto
    .createHmac("sha256", baseSecret())
    .update(`fablab-ai-access:${hourKey}`)
    .digest("base64url")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  const compact = digest.slice(0, 40);
  return [
    compact.slice(0, 4),
    compact.slice(4, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20, 24),
    compact.slice(24, 28),
    compact.slice(28, 32),
    compact.slice(32, 36),
    compact.slice(36, 40)
  ].join("-");
}

/**
 * Les mots de passe permanents (owner/teacher) sont stockés en base (bcrypt),
 * pas en variable d'environnement : cela permet de changer le mot de passe
 * administrateur depuis l'admin sans redéployer.
 */
export function getOwnerPasswordHash() {
  return String(getSetting("ownerPasswordHash", "") || "").trim();
}

export function setOwnerPasswordHash(hash) {
  setSetting("ownerPasswordHash", hash);
}

export function getTeacherPasswordHash() {
  return String(getSetting("teacherPasswordHash", "") || "").trim();
}

export function setTeacherPasswordHash(hash) {
  setSetting("teacherPasswordHash", hash);
}

export function isTeacherPasswordChangeRequired() {
  return getSetting("teacherPasswordMustChange", "0") === "1";
}

export function setTeacherPasswordChangeRequired(required) {
  setSetting("teacherPasswordMustChange", required ? "1" : "0");
}

function generateRandomPassword(length = 16) {
  // Alphabet sans caracteres ambigus (0/O, 1/l/I) pour une lecture/saisie plus sure.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

/**
 * Genere un nouveau mot de passe administrateur aleatoire, le stocke (bcrypt) et
 * impose son changement a la prochaine connexion. Utilise en fin d'installation
 * et par le script reset-teacher-password.js. Le mot de passe en clair n'est
 * jamais stocke : il doit etre communique immediatement a l'appelant.
 */
export async function generateAndSetTeacherPassword() {
  const plainPassword = generateRandomPassword();
  const hash = await bcrypt.hash(plainPassword, 12);
  setTeacherPasswordHash(hash);
  setTeacherPasswordChangeRequired(true);
  return plainPassword;
}

/**
 * Valide un mot de passe d'accès admin et renvoie le rôle associé :
 * - "owner" : mot de passe permanent du propriétaire (accès export/déploiement inclus)
 * - "teacher" : mot de passe permanent administrateur (accès admin sauf export/déploiement)
 * - "app" : mot de passe rotatif horaire (accès admin générique sauf export/déploiement)
 * - null si aucune correspondance
 */
export function validateAccessPassword(password, date = new Date(), timeZone = defaultTimeZone) {
  if (!password) {
    return null;
  }

  const rawPassword = password.trim();
  const normalizedPassword = rawPassword.toUpperCase();
  const oneHourMs = 60 * 60 * 1000;

  const matchesRotatingPassword = [date, new Date(date.getTime() - oneHourMs), new Date(date.getTime() + oneHourMs)].some(
    (candidateDate) => normalizedPassword === generateAccessPassword(candidateDate, timeZone)
  );

  if (matchesRotatingPassword) {
    return "app";
  }

  const ownerHash = getOwnerPasswordHash();
  if (ownerHash) {
    try {
      if (bcrypt.compareSync(rawPassword, ownerHash)) {
        return "owner";
      }
    } catch {
      // Hash invalide en base : on continue les autres verifications.
    }
  }

  const teacherHash = getTeacherPasswordHash();
  if (teacherHash) {
    try {
      if (bcrypt.compareSync(rawPassword, teacherHash)) {
        return "teacher";
      }
    } catch {
      // Hash invalide en base : aucune correspondance.
    }
  }

  return null;
}

export function getAccessPasswordSnapshot(date = new Date(), timeZone = defaultTimeZone) {
  const nextHourDate = new Date(date.getTime() + getMsUntilNextRotation(date, timeZone));

  return {
    password: generateAccessPassword(date, timeZone),
    validFromLabel: buildDisplayHour(date, timeZone),
    validUntilDate: nextHourDate,
    timeZone
  };
}

export function getMsUntilNextRotation(date = new Date(), timeZone = defaultTimeZone) {
  const { minute, second } = getDateParts(date, timeZone);
  const currentSeconds = Number(minute) * 60 + Number(second);
  const remainingSeconds = Math.max(1, 3600 - currentSeconds);
  return remainingSeconds * 1000;
}
