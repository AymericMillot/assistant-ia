import crypto from "crypto";

const algorithm = "aes-256-gcm";
const encryptedPrefix = "enc:v1:";
// GCM : IV de 96 bits et tag d'authentification de 128 bits (valeurs standard).
// On les impose explicitement au dechiffrement pour qu'une valeur chiffree
// falsifiee (tag tronque, IV de longueur inattendue) soit rejetee au lieu
// d'affaiblir silencieusement la verification d'integrite.
const ivLength = 12;
const authTagLength = 16;

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

  const iv = crypto.randomBytes(ivLength);
  const cipher = crypto.createCipheriv(algorithm, key, iv, { authTagLength });
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

  const iv = Buffer.from(String(payload.iv || ""), "base64");
  const authTag = Buffer.from(String(payload.tag || ""), "base64");
  if (iv.length !== ivLength) {
    throw new Error("Secret chiffre invalide : vecteur d'initialisation inattendu.");
  }
  if (authTag.length !== authTagLength) {
    throw new Error("Secret chiffre invalide : tag d'authentification inattendu.");
  }

  const decipher = crypto.createDecipheriv(algorithm, key, iv, { authTagLength });
  decipher.setAuthTag(authTag);

  const plainText = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final()
  ]);

  return plainText.toString("utf8");
}
