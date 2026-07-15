import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { getAccessPasswordSnapshot, getMsUntilNextRotation } from "../services/accessPasswordService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const snapshot = getAccessPasswordSnapshot();
const remainingMs = Math.max(0, getMsUntilNextRotation());

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify({
      password: snapshot.password,
      validFromLabel: snapshot.validFromLabel,
      timeZone: snapshot.timeZone,
      validUntilLabel: snapshot.validUntilDate.toLocaleString("fr-FR", { timeZone: snapshot.timeZone }),
      validUntilEpochMs: snapshot.validUntilDate.getTime(),
      remainingMs,
    })
  );
  process.exit(0);
}

const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));

console.log(`Mot de passe actuel : ${snapshot.password}`);
console.log(`Valable a partir de : ${snapshot.validFromLabel} (${snapshot.timeZone})`);
console.log(
  `Rotation suivante : ${snapshot.validUntilDate.toLocaleString("fr-FR", { timeZone: snapshot.timeZone })}`
);
console.log(`Temps restant : environ ${remainingMinutes} minute${remainingMinutes > 1 ? "s" : ""}`);
