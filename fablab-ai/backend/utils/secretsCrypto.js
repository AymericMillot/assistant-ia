import crypto from "crypto";

const algorithm = "aes-256-gcm";
const encryptedPrefix = "enc:v1:";

function getEncryptionKey() {
  const rawKey = process.env.CONFIG_ENCRYPTION_KEY;
  if (!rawKey) {
    return null;
  }

  return crypto.createHash("sha256").update(rawKey, "utf8").digest();
}

export function isSecretsEncryptionAvailable() {
  return Boolean(getEncryptionKey());
}

export function encryptSecret(plainText) {
  const key = getEncryptionKey();
  if (!key) {
    throw new Error("CONFIG_ENCRYPTION_KEY est requis pour chiffrer un secret.");
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const payload = {
    iv: iv.toString("base64"),
    tag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };

  return `${encryptedPrefix}${Buffer.from(JSON.stringify(payload)).toString("base64")}`;
}

export function isEncryptedSecret(value) {
  return typeof value === "string" && value.startsWith(encryptedPrefix);
}

export function decryptSecret(value) {
  if (!isEncryptedSecret(value)) {
    return value;
  }

  const key = getEncryptionKey();
  if (!key) {
    throw new Error("CONFIG_ENCRYPTION_KEY est requis pour dechiffrer ce secret.");
  }

  const payload = JSON.parse(
    Buffer.from(value.slice(encryptedPrefix.length), "base64").toString("utf8")
  );
  const decipher = crypto.createDecipheriv(algorithm, key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));

  const plainText = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final()
  ]);

  return plainText.toString("utf8");
}
