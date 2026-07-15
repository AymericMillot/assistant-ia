// Applique la personnalisation saisie pendant install.sh au fichier de
// branding de l'instance. Lit ses parametres depuis des variables d'env pour
// rester simple a invoquer depuis un script shell (docker compose run).
import { writeBranding } from "../config/branding.js";

const projectName = String(process.env.INSTALL_PROJECT_NAME || "").trim();
const shortName = String(process.env.INSTALL_SHORT_NAME || "").trim();

if (!projectName && !shortName) {
  console.log("Aucune personnalisation fournie, valeurs par defaut conservees.");
  process.exit(0);
}

const updates = {};
if (projectName) {
  updates.projectName = projectName;
}
if (shortName) {
  updates.shortName = shortName;
}
if (projectName) {
  updates.welcomeMessage = `Assistant local de ${projectName} pour retrouver rapidement les bonnes consignes et procédures. Vos échanges restent sur cette machine et ne sont pas conservés après fermeture de la page.`;
}

const branding = writeBranding(updates);
console.log(`Branding mis a jour : ${branding.projectName}`);
