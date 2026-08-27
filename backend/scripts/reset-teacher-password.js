import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const { initializeDatabase } = await import("../config/db.js");
const { generateAndSetTeacherPassword } = await import("../services/accessPasswordService.js");

initializeDatabase();
const password = await generateAndSetTeacherPassword();

console.log("Nouveau mot de passe référent (à communiquer une seule fois) :");
console.log(password);
console.log("Le changement de ce mot de passe sera imposé à la prochaine connexion.");
