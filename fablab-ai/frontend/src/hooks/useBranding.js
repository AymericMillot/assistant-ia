import { useEffect, useState } from "react";
import { fetchJson } from "../lib/api";

// N'est utilise qu'avant la premiere reponse de /api/branding (ou si elle echoue) :
// valeurs generiques alignees sur backend/config/branding.default.json, le branding
// reel de l'instance vient toujours du serveur.
const fallbackBranding = {
  projectName: "Assistant local",
  shortName: "L'assistant",
  welcomeMessage:
    "Assistant local pour retrouver rapidement les bonnes consignes et procédures. Vos échanges restent sur cette machine et ne sont pas conservés après fermeture de la page."
};

let cachedBranding = null;
let pendingRequest = null;

function loadBranding() {
  if (cachedBranding) {
    return Promise.resolve(cachedBranding);
  }
  if (!pendingRequest) {
    pendingRequest = fetchJson("/api/branding", { retryCount: 0 })
      .then((data) => {
        cachedBranding = { ...fallbackBranding, ...data };
        return cachedBranding;
      })
      .catch(() => fallbackBranding)
      .finally(() => {
        pendingRequest = null;
      });
  }
  return pendingRequest;
}

export function useBranding() {
  const [branding, setBranding] = useState(cachedBranding || fallbackBranding);

  useEffect(() => {
    let isMounted = true;
    loadBranding().then((data) => {
      if (isMounted) {
        setBranding(data);
      }
    });
    return () => {
      isMounted = false;
    };
  }, []);

  return branding;
}
