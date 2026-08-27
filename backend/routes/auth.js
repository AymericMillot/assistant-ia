import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { authMiddleware, requireRole } from "../middleware/authMiddleware.js";
import {
  getMsUntilNextRotation,
  isTeacherPasswordChangeRequired,
  setTeacherPasswordChangeRequired,
  setTeacherPasswordHash,
  validateAccessPassword
} from "../services/accessPasswordService.js";
import { createRateLimiter, ensureSafeText } from "../utils/security.js";
import { findAdminUserByIdentifier, insertAuditLogEntry } from "../config/db.js";

const router = express.Router();
const loginRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyPrefix: "auth-login",
  message: "Trop de tentatives de connexion. Reessayez dans quelques minutes."
});
const passwordChangeRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyPrefix: "auth-teacher-password-change",
  message: "Trop de tentatives. Reessayez dans quelques minutes."
});

// Hash bcrypt factice (mot de passe aleatoire, jamais utilise ailleurs) : compare
// toujours contre un hash quand l'identifiant est inconnu, pour que le temps de
// reponse ne revele pas si l'identifiant existe (sinon bcrypt.compare est saute).
const dummyPasswordHash = "$2b$12$C6UzMDM.H6dfI/f/IKcEeO7hCkG7f0mBUeOOyMwyJx4CjQfMoZHyO";

function cookieOptions(role) {
  // Les roles permanents (owner/teacher) ouvrent une session longue (7 jours) ;
  // le role rotatif "app" reste borne a la fenetre du mot de passe horaire.
  const maxAge = role === "owner" || role === "teacher" ? 7 * 24 * 60 * 60 * 1000 : getMsUntilNextRotation();
  const secureCookies =
    process.env.COOKIE_SECURE !== undefined
      ? process.env.COOKIE_SECURE === "true"
      : process.env.NODE_ENV === "production";

  return {
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure: secureCookies,
    maxAge
  };
}

router.post("/login", loginRateLimiter, async (req, res) => {
  const rawPassword = req.body?.password;
  const rawIdentifiant = req.body?.identifiant;
  let password;

  try {
    password = ensureSafeText(rawPassword, "Mot de passe", { min: 3, max: 256 });
  } catch {
    return res.status(400).json({ message: "Mot de passe requis." });
  }

  // Compte admin nomme (identifiant + mot de passe propres) : prioritaire
  // sur les mots de passe partages historiques quand un identifiant est fourni.
  if (typeof rawIdentifiant === "string" && rawIdentifiant.trim()) {
    const identifiant = rawIdentifiant.trim();
    const adminUser = findAdminUserByIdentifier(identifiant);
    const passwordMatches = await bcrypt.compare(password, adminUser?.passwordHash || dummyPasswordHash);

    if (!adminUser || !passwordMatches) {
      return res.status(401).json({ message: "Identifiant ou mot de passe invalide." });
    }

    const role = adminUser.role;
    const expiresInSeconds = 7 * 24 * 60 * 60;
    const token = jwt.sign(
      { role, adminUserId: adminUser.id, identifiant: adminUser.identifier },
      process.env.JWT_SECRET,
      { expiresIn: expiresInSeconds }
    );

    res.cookie("token", token, cookieOptions(role));
    return res.json({
      user: { role, adminUserId: adminUser.id, identifiant: adminUser.identifier },
      mustChangePassword: false
    });
  }

  const role = validateAccessPassword(password);
  if (!role) {
    return res.status(401).json({ message: "Mot de passe invalide." });
  }

  const expiresInSeconds = Math.max(
    1,
    Math.floor((role === "owner" || role === "teacher" ? 7 * 24 * 60 * 60 * 1000 : getMsUntilNextRotation()) / 1000)
  );

  const token = jwt.sign(
    {
      role,
      adminUserId: "temporary-admin"
    },
    process.env.JWT_SECRET,
    {
      expiresIn: expiresInSeconds
    }
  );

  const mustChangePassword = role === "teacher" && isTeacherPasswordChangeRequired();

  res.cookie("token", token, cookieOptions(role));
  return res.json({
    user: {
      role,
      adminUserId: "temporary-admin"
    },
    mustChangePassword
  });
});

router.get("/me", authMiddleware, async (req, res) => {
  res.json({
    user: {
      role: req.user.role,
      adminUserId: req.user.adminUserId || "temporary-admin",
      identifiant: req.user.identifiant || null
    },
    mustChangePassword: req.user.role === "teacher" && isTeacherPasswordChangeRequired()
  });
});

router.post("/logout", async (_req, res) => {
  res.clearCookie("token", cookieOptions());
  res.json({ message: "Session fermee." });
});

router.put(
  "/teacher-password",
  passwordChangeRateLimiter,
  authMiddleware,
  requireRole("owner"),
  async (req, res) => {
    let newPassword;

    try {
      newPassword = ensureSafeText(req.body?.newPassword, "Nouveau mot de passe", { min: 12, max: 256 });
    } catch {
      return res.status(400).json({ message: "Le mot de passe enseignant doit contenir au moins 12 caracteres." });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    setTeacherPasswordHash(hash);
    setTeacherPasswordChangeRequired(false);

    try {
      insertAuditLogEntry({ actorRole: req.user.role, action: "auth.teacher-password-change" });
    } catch {
      // Le journal d'audit ne doit jamais faire echouer l'action elle-meme.
    }

    return res.json({ message: "Mot de passe enseignant mis a jour avec succes." });
  }
);

// Auto-service : l'enseignant change lui-meme son mot de passe (notamment lors
// du changement impose apres la generation automatique d'un mot de passe).
router.put(
  "/teacher-password/self",
  passwordChangeRateLimiter,
  authMiddleware,
  requireRole("teacher"),
  async (req, res) => {
    let newPassword;

    try {
      newPassword = ensureSafeText(req.body?.newPassword, "Nouveau mot de passe", { min: 12, max: 256 });
    } catch {
      return res.status(400).json({ message: "Le mot de passe enseignant doit contenir au moins 12 caracteres." });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    setTeacherPasswordHash(hash);
    setTeacherPasswordChangeRequired(false);

    try {
      insertAuditLogEntry({ actorRole: req.user.role, action: "auth.teacher-password-self-change" });
    } catch {
      // Le journal d'audit ne doit jamais faire echouer l'action elle-meme.
    }

    return res.json({ message: "Mot de passe enseignant mis a jour avec succes." });
  }
);

export default router;
