import jwt from "jsonwebtoken";

export function authMiddleware(req, res, next) {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ message: "Authentification requise." });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload?.role) {
      return res.status(401).json({ message: "Session invalide ou expiree." });
    }
    req.user = payload;
    return next();
  } catch (error) {
    return res.status(401).json({ message: "Session invalide ou expiree." });
  }
}

/** A utiliser apres authMiddleware pour restreindre une route a un role precis. */
export function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) {
      return res.status(403).json({ message: "Cette action n'est pas autorisee." });
    }

    return next();
  };
}
