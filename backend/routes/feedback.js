import express from "express";
import { sendFeedbackToDiscord } from "../services/discordFeedbackService.js";
import { createRateLimiter, ensureSafeText } from "../utils/security.js";

const router = express.Router();

const feedbackRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.FEEDBACK_RATE_LIMIT || 10),
  keyPrefix: "public-feedback",
  message: "Trop de signalements en peu de temps. Reessayez plus tard."
});

function registerFeedbackRoute(type) {
  router.post(`/${type}`, feedbackRateLimiter, async (req, res, next) => {
    try {
      const message = ensureSafeText(req.body?.message, "Message", { min: 5, max: 1000 });
      const rawContact = typeof req.body?.contact === "string" ? req.body.contact.trim() : "";
      const contact = rawContact ? ensureSafeText(rawContact, "Contact", { min: 1, max: 200 }) : "";

      await sendFeedbackToDiscord({ type, message, contact, req });
      res.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
}

registerFeedbackRoute("bug");
registerFeedbackRoute("suggestion");

export default router;
