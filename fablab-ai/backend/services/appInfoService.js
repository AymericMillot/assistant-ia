import fs from "fs";
import path from "path";

const versionFilePath = process.env.VERSION_FILE_PATH || path.resolve(process.cwd(), "version.json");

export function getCurrentVersion() {
  try {
    const content = fs.readFileSync(versionFilePath, "utf8");
    const payload = JSON.parse(content);
    return payload.version || "1.000";
  } catch {
    return "1.000";
  }
}
