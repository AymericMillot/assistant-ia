import { logger } from "../config/logger.js";
import { getBranding } from "../config/branding.js";
import { getCurrentVersion } from "./appInfoService.js";

const WEBHOOK_URLS = {
  bug: process.env.DISCORD_WEBHOOK_BUG_URL || "",
  suggestion: process.env.DISCORD_WEBHOOK_SUGGESTION_URL || ""
};

const EMBED_COLOR = {
  bug: 0xe11d48,
  suggestion: 0x2563eb
};

const EMBED_TITLE = {
  bug: "🐞 Nouveau signalement de bug",
  suggestion: "💡 Nouvelle suggestion"
};

export function isFeedbackChannelConfigured(type) {
  return Boolean(WEBHOOK_URLS[type]);
}

export async function sendFeedbackToDiscord({ type, message, contact, req }) {
  const webhookUrl = WEBHOOK_URLS[type];
  if (!webhookUrl) {
    const error = new Error("Ce canal de signalement n'est pas configuré.");
    error.statusCode = 503;
    throw error;
  }

  const branding = getBranding();
  const fields = [
    {
      name: "Message",
      value: message.slice(0, 1024)
    }
  ];

  if (contact) {
    fields.push({
      name: "Contact (optionnel)",
      value: contact.slice(0, 256)
    });
  }

  fields.push(
    {
      name: "Application",
      value: branding.projectName || "Assistant IA",
      inline: true
    },
    {
      name: "Version",
      value: getCurrentVersion() || "inconnue",
      inline: true
    },
    {
      name: "Page",
      value: (req?.get("referer") || "inconnue").slice(0, 256),
      inline: true
    }
  );

  const payload = {
    embeds: [
      {
        title: EMBED_TITLE[type],
        color: EMBED_COLOR[type],
        fields,
        timestamp: new Date().toISOString()
      }
    ]
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    logger.error("Echec d'envoi du signalement vers Discord", {
      type,
      status: response.status,
      body: bodyText.slice(0, 500)
    });

    const error = new Error("Echec de l'envoi du signalement. Reessayez plus tard.");
    error.statusCode = 502;
    throw error;
  }
}
