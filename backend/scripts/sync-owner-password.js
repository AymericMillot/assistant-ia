import "dotenv/config";
import { initializeDatabase } from "../config/db.js";
import { synchronizeOwnerBootstrapPassword } from "../services/accessPasswordService.js";

initializeDatabase();

const result = await synchronizeOwnerBootstrapPassword();
if (!result.synchronized) {
  console.error("Valeur locale absente : aucune modification effectuee.");
  process.exit(1);
}

console.log(
  result.namedAccountUpdated
    ? "Configuration locale synchronisee."
    : "Configuration locale synchronisee."
);
