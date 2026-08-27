import bcrypt from "bcrypt";
import crypto from "crypto";
import { getSetting, setSetting } from "../config/db.js";

/**
 * Les mots de passe de comptes sont stockés en base avec bcrypt. La
 * configuration locale peut être resynchronisée depuis la valeur de
 * l'instance ; le mot de passe référent reste modifiable sans redéployer.
 */
export function getOwnerPasswordHash() {
  return String(getSetting("ownerPasswordHash", "") || "").trim();
}

export function setOwnerPasswordHash(hash) {
  setSetting("ownerPasswordHash", hash);
}

/**
 * Synchronise la valeur locale de l'instance avec la configuration
 * initiale. Le secret vient uniquement de .env : il n'est ni versionné,
 * ni retourné par une API, ni écrit dans les journaux.
 */
export async function synchronizeOwnerBootstrapPassword(password = process.env.OWNER_BOOTSTRAP_PASSWORD) {
  const rawPassword = String(password || "").trim();
  if (!rawPassword) {
    return { synchronized: false };
  }

  if (rawPassword.length < 16 || rawPassword.length > 256) {
    throw new Error("La valeur locale doit contenir entre 16 et 256 caractères.");
  }

  const hash = await bcrypt.hash(rawPassword, 12);
  setOwnerPasswordHash(hash);

  return { synchronized: true };
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
 * Genere un nouveau mot de passe référent aleatoire, le stocke (bcrypt) et
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
 * - rôle système : accès aux opérations d'administration avancées
 * - "referent" : accès aux fonctions d'administration courantes
 * - null si aucune correspondance
 */
export function validateAccessPassword(password) {
  if (!password) {
    return null;
  }

  const rawPassword = password.trim();

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
        return "referent";
      }
    } catch {
      // Hash invalide en base : aucune correspondance.
    }
  }

  return null;
}
