import express from "express";
import { getQueueStatus } from "../services/queueService.js";
import { ensureUuidLike } from "../utils/security.js";

const router = express.Router();

router.get("/status", async (req, res, next) => {
  try {
    const clientId = req.query.clientId ? ensureUuidLike(req.query.clientId, "Identifiant client") : null;
    const status = await getQueueStatus(clientId);
    res.json(status);
  } catch (error) {
    next(error);
  }
});

export default router;
