import jwt from "jsonwebtoken";
import { getAdminUserById, getSetting } from "../config/db.js";

function toEpochSeconds(value) {
  if (!value) {
    return 0;
  }

  // Les dates SQLite (CURRENT_TIMESTAMP) sont en UTC sans suffixe.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

/**
 * Verifie un jeton de session et qu'il est toujours valable cote serveur :
 * - compte nomme : le compte existe encore, son role n'a pas change, et son
 *   mot de passe ou son role n'ont pas ete modifies depuis l'emission ;
 * - mot de passe partage : il n'a pas ete change depuis l'emission.
 * Renvoie la charge utile, ou null si la session doit etre refusee.
 */
export function verifySessionToken(token) {
  if (!token) {
    return null;
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    return null;
  }

  if (!payload?.role) {
    return null;
  }

  const issuedAt = Number(payload.iat || 0);

  if (Number.isInteger(payload.adminUserId)) {
    const account = getAdminUserById(payload.adminUserId);
    if (!account || account.role !== payload.role) {
      return null;
    }

    if (toEpochSeconds(account.updatedAt) > issuedAt) {
      return null;
    }

    return payload;
  }

  const changedAtKey =
    payload.role === "owner" ? "ownerPasswordChangedAt" : payload.role === "referent" ? "teacherPasswordChangedAt" : null;
  if (!changedAtKey) {
    return null;
  }

  if (toEpochSeconds(getSetting(changedAtKey, "")) > issuedAt) {
    return null;
  }

  return payload;
}

export function authMiddleware(req, res, next) {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ message: "Authentification requise." });
  }

  const payload = verifySessionToken(token);
  if (!payload) {
    return res.status(401).json({ message: "Session invalide ou expiree." });
  }

  req.user = payload;
  return next();
}

/** A utiliser apres authMiddleware pour restreindre une route a un role precis. */
export function requireRole(role) {
  return (req, res, next) => {
    const allowedRoles = Array.isArray(role) ? role : [role];
    if (!allowedRoles.includes(req.user?.role)) {
      return res.status(403).json({ message: "Cette action n'est pas autorisee." });
    }

    return next();
  };
}
