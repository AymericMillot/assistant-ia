import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import {
  createSkill,
  getSkillById,
  getSkillBySlug,
  listSkills,
  recordSkillUsage,
  updateSkill
} from "../config/db.js";
import { logger } from "../config/logger.js";

/**
 * Skills : methodes de reponse predefinies (procedure pas a pas, diagnostic,
 * format court...). Un skill est un texte d'instructions redige par l'equipe,
 * au format SKILL.md (en-tete "cle: valeur" entre deux lignes "---", puis le
 * corps en Markdown), injecte dans le prompt quand il s'applique :
 * - activation "auto"   : quand un declencheur (ou le titre) correspond a la question ;
 * - activation "always" : a chaque reponse ;
 * - activation "manual" : uniquement si l'utilisateur le choisit dans le chat.
 */

export const skillActivations = ["auto", "always", "manual"];

const maxSkillInstructionsCharacters = Number(process.env.SKILL_MAX_INSTRUCTIONS_CHARS || 20000);
const maxSkillPromptCharacters = Number(process.env.SKILL_PROMPT_MAX_CHARS || 6000);
const maxSkillsTotalPromptCharacters = Number(process.env.SKILL_PROMPT_TOTAL_MAX_CHARS || 12000);
const maxAutoSkillsPerAnswer = Number(process.env.SKILL_AUTO_MAX_PER_ANSWER || 2);
const autoSkillMinimumScore = Number(process.env.SKILL_AUTO_MIN_SCORE || 0.6);
const maxTriggers = 40;
const maxZipEntries = 200;
const maxZipUncompressedBytes = 5 * 1024 * 1024;
const templatesDirectory = path.resolve(process.cwd(), "config/skills");

function validationError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeComparable(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugifySkillName(value) {
  return normalizeComparable(value).replace(/\s+/g, "-").slice(0, 80) || "skill";
}

function cleanText(value, { max, field, required = false }) {
  const text = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    // Caracteres de controle (hors tabulation et saut de ligne) : jamais utiles
    // dans des instructions et parfois utilises pour masquer du texte.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();

  if (required && !text) {
    throw validationError(`${field} est obligatoire.`);
  }

  if (text.length > max) {
    throw validationError(`${field} est trop long (${max} caractères maximum).`);
  }

  return text;
}

function parseTriggerList(value) {
  const rawEntries = Array.isArray(value)
    ? value
    : String(value || "")
        .replace(/^\[|\]$/g, "")
        .split(/[\n,;]/);

  const seen = new Set();
  return rawEntries
    .map((entry) => String(entry || "").replace(/^["'\s-]+|["'\s]+$/g, "").trim())
    .filter((entry) => entry.length >= 2 && entry.length <= 80)
    .filter((entry) => {
      const key = normalizeComparable(entry);
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, maxTriggers);
}

function parseBooleanLike(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = normalizeComparable(value);
  if (["true", "oui", "yes", "1", "vrai"].includes(normalized)) {
    return true;
  }
  if (["false", "non", "no", "0", "faux"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function normalizeActivation(value) {
  const normalized = normalizeComparable(value);
  const aliases = {
    auto: "auto",
    automatique: "auto",
    always: "always",
    toujours: "always",
    manual: "manual",
    manuel: "manual",
    manuelle: "manual"
  };

  return aliases[normalized] || "auto";
}

/**
 * Valide et normalise un skill (formulaire d'administration ou fichier importe).
 */
export function normalizeSkillInput(input = {}, { source = "manual" } = {}) {
  const title = cleanText(input.title ?? input.name, { max: 120, field: "Le titre", required: true });
  const description = cleanText(input.description, { max: 500, field: "La description" });
  const instructions = cleanText(input.instructions, {
    max: maxSkillInstructionsCharacters,
    field: "Les instructions",
    required: true
  });

  if (instructions.length < 20) {
    throw validationError("Les instructions doivent contenir au moins 20 caractères.");
  }

  return {
    slug: slugifySkillName(input.slug || input.name || title),
    title,
    description,
    instructions,
    triggers: parseTriggerList(input.triggers),
    activation: normalizeActivation(input.activation),
    userSelectable: parseBooleanLike(input.userSelectable, true),
    isEnabled: parseBooleanLike(input.isEnabled, true),
    source
  };
}

/**
 * Lit un fichier SKILL.md : en-tete facultatif entre deux lignes "---" (paires
 * "cle: valeur", listes "- element" ou "[a, b]"), suivi des instructions.
 */
export function parseSkillMarkdown(rawText, { fallbackTitle = "" } = {}) {
  const text = String(rawText || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const frontmatterMatch = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  let body = text;

  if (frontmatterMatch) {
    body = frontmatterMatch[2];
    let currentListKey = null;

    frontmatterMatch[1].split("\n").forEach((line) => {
      const listItem = line.match(/^\s+-\s+(.*)$|^-\s+(.*)$/);
      if (listItem && currentListKey) {
        meta[currentListKey] = [...(meta[currentListKey] || []), (listItem[1] ?? listItem[2]).trim()];
        return;
      }

      const pair = line.match(/^([A-Za-z_À-ſ-]+)\s*:\s*(.*)$/);
      if (!pair) {
        return;
      }

      const key = normalizeComparable(pair[1]).replace(/\s+/g, "_");
      const value = pair[2].trim().replace(/^["']|["']$/g, "");
      if (value) {
        meta[key] = value;
        currentListKey = null;
      } else {
        meta[key] = [];
        currentListKey = key;
      }
    });
  }

  const headingTitle = body.match(/^#\s+(.+)$/m)?.[1]?.trim();

  return {
    name: meta.name || meta.nom || "",
    title: meta.title || meta.titre || headingTitle || meta.name || meta.nom || fallbackTitle,
    description: meta.description || "",
    triggers: meta.triggers || meta.declencheurs || meta.keywords || meta.mots_cles || [],
    activation: meta.activation || meta.mode || "auto",
    userSelectable: meta.user_selectable ?? meta.selectable ?? meta.selectionnable,
    instructions: body.trim()
  };
}

export function serializeSkillMarkdown(skill) {
  const escape = (value) => String(value || "").replace(/\n/g, " ").trim();
  const lines = [
    "---",
    `name: ${skill.slug}`,
    `title: ${escape(skill.title)}`,
    `description: ${escape(skill.description)}`,
    `activation: ${skill.activation}`,
    `user_selectable: ${skill.userSelectable ? "true" : "false"}`,
    "triggers:",
    ...(skill.triggers || []).map((trigger) => `  - ${escape(trigger)}`),
    "---",
    "",
    skill.instructions.trim(),
    ""
  ];

  return lines.join("\n");
}

function decodeTextBuffer(buffer, fileName) {
  if (buffer.includes(0)) {
    throw validationError(`Le fichier ${fileName} n'est pas un fichier texte.`);
  }

  return buffer.toString("utf8");
}

function parseZipSkills(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw validationError("Archive ZIP illisible.");
  }

  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  if (entries.length > maxZipEntries) {
    throw validationError(`L'archive contient trop de fichiers (${maxZipEntries} maximum).`);
  }

  const totalSize = entries.reduce((total, entry) => total + Number(entry.header?.size || 0), 0);
  if (totalSize > maxZipUncompressedBytes) {
    throw validationError("L'archive décompressée dépasse 5 Mo.");
  }

  // Lecture en memoire uniquement (rien n'est extrait sur disque) : les chemins
  // de l'archive ne servent qu'a regrouper les fichiers par dossier de skill.
  const textEntries = entries
    .map((entry) => ({ name: entry.entryName.replace(/\\/g, "/"), entry }))
    .filter(({ name }) => !name.split("/").some((part) => part.startsWith(".") || part === "__MACOSX"))
    .filter(({ name }) => /\.(md|markdown|txt)$/i.test(name));

  const skillFiles = textEntries.filter(({ name }) => /(^|\/)skill\.md$/i.test(name));
  const roots = skillFiles.length > 0 ? skillFiles : textEntries.filter(({ name }) => /\.(md|markdown)$/i.test(name));

  if (roots.length === 0) {
    throw validationError("Aucun fichier SKILL.md ou .md trouvé dans l'archive.");
  }

  return roots.slice(0, 50).map(({ name, entry }) => {
    const directory = name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : "";
    const isSkillFolder = /(^|\/)skill\.md$/i.test(name);
    const parsed = parseSkillMarkdown(decodeTextBuffer(entry.getData(), name), {
      fallbackTitle: isSkillFolder
        ? directory.replace(/\/$/, "").split("/").pop()
        : path.basename(name).replace(/\.(md|markdown)$/i, "")
    });

    // Fichiers de reference du meme dossier (format "skill" avec references/) :
    // ajoutes a la suite des instructions, dans la limite de taille autorisee.
    if (isSkillFolder) {
      const references = textEntries.filter(
        (candidate) => candidate.name !== name && candidate.name.startsWith(directory)
      );
      references.forEach((reference) => {
        const content = decodeTextBuffer(reference.entry.getData(), reference.name).trim();
        if (content) {
          parsed.instructions += `\n\n## Référence : ${reference.name.slice(directory.length)}\n\n${content}`;
        }
      });
    }

    if (parsed.instructions.length > maxSkillInstructionsCharacters) {
      parsed.instructions = parsed.instructions.slice(0, maxSkillInstructionsCharacters);
    }

    return parsed;
  });
}

/**
 * Lit un fichier depose (.md, .txt ou .zip de skills) et renvoie les skills
 * normalises, sans les enregistrer.
 */
export function parseSkillUpload({ buffer, originalName }) {
  const extension = path.extname(String(originalName || "")).toLowerCase();

  if (extension === ".zip") {
    return parseZipSkills(buffer).map((parsed) => normalizeSkillInput(parsed, { source: "import" }));
  }

  if ([".md", ".markdown", ".txt"].includes(extension)) {
    const parsed = parseSkillMarkdown(decodeTextBuffer(buffer, originalName), {
      fallbackTitle: path.basename(originalName, extension)
    });
    return [normalizeSkillInput(parsed, { source: "import" })];
  }

  throw validationError("Format non pris en charge : déposez un fichier .md, .txt ou .zip.");
}

function ensureUniqueSlug(slug, excludedId = null) {
  let candidate = slug;
  let suffix = 2;

  while (true) {
    const existing = getSkillBySlug(candidate);
    if (!existing || existing.id === excludedId) {
      return candidate;
    }
    candidate = `${slug}-${suffix}`;
    suffix += 1;
  }
}

/**
 * Enregistre des skills importes : un skill de meme identifiant est mis a jour
 * (re-depot d'une version corrigee), sinon il est cree.
 */
export function saveImportedSkills(skills, { overwrite = true } = {}) {
  return skills.map((skill) => {
    const existing = getSkillBySlug(skill.slug);
    if (existing && overwrite) {
      return { skill: updateSkill(existing.id, { ...skill, isEnabled: existing.isEnabled }), status: "updated" };
    }

    return { skill: createSkill({ ...skill, slug: ensureUniqueSlug(skill.slug) }), status: "created" };
  });
}

export function createSkillFromInput(input) {
  const skill = normalizeSkillInput(input, { source: "manual" });
  return createSkill({ ...skill, slug: ensureUniqueSlug(skill.slug) });
}

export function updateSkillFromInput(id, input) {
  const existing = getSkillById(id);
  if (!existing) {
    throw validationError("Skill introuvable.", 404);
  }

  const skill = normalizeSkillInput({ ...existing, ...input, slug: input.slug || existing.slug }, {
    source: existing.source
  });
  return updateSkill(id, { ...skill, slug: ensureUniqueSlug(skill.slug, id) });
}

export function listSkillTemplates() {
  let files = [];
  try {
    files = fs.readdirSync(templatesDirectory).filter((file) => file.endsWith(".md")).sort();
  } catch (error) {
    logger.warn("Modeles de skills introuvables.", { message: error.message });
    return [];
  }

  return files
    .map((file) => {
      try {
        const parsed = parseSkillMarkdown(fs.readFileSync(path.join(templatesDirectory, file), "utf8"), {
          fallbackTitle: file.replace(/\.md$/, "")
        });
        const skill = normalizeSkillInput(parsed, { source: "template" });
        return { ...skill, installed: Boolean(getSkillBySlug(skill.slug)) };
      } catch (error) {
        logger.warn("Modele de skill ignore.", { file, message: error.message });
        return null;
      }
    })
    .filter(Boolean);
}

export function installSkillTemplate(slug) {
  const template = listSkillTemplates().find((entry) => entry.slug === slug);
  if (!template) {
    throw validationError("Modèle de skill introuvable.", 404);
  }

  const existing = getSkillBySlug(template.slug);
  if (existing) {
    return { skill: existing, status: "existing" };
  }

  const { installed: _installed, ...skill } = template;
  return { skill: createSkill(skill), status: "created" };
}

export function listPublicSkills() {
  return listSkills({ enabledOnly: true })
    .filter((skill) => skill.userSelectable)
    .map((skill) => ({
      id: skill.id,
      title: skill.title,
      description: skill.description
    }));
}

function truncateInstructions(text, maxCharacters) {
  if (text.length <= maxCharacters) {
    return text;
  }

  return `${text.slice(0, maxCharacters).trim()}\n[…]`;
}

function wordsMatch(triggerWord, questionWord) {
  if (triggerWord === questionWord) {
    return true;
  }

  // Tolerance sur les terminaisons (demarrer / demarre, decoupe / decoupes) :
  // racine commune d'au moins 4 lettres, a deux lettres pres.
  const stemLength = Math.max(4, Math.min(triggerWord.length, questionWord.length) - 2);
  return (
    triggerWord.length >= 4 &&
    questionWord.length >= 4 &&
    triggerWord.slice(0, stemLength) === questionWord.slice(0, stemLength) &&
    Math.abs(triggerWord.length - questionWord.length) <= 3
  );
}

/**
 * Un declencheur correspond quand tous ses mots (y compris "ne", "pas",
 * "comment"...) figurent dans la question, a la terminaison pres.
 */
export function triggerMatchesQuestion(trigger, question) {
  const triggerWords = normalizeComparable(trigger).split(" ").filter(Boolean);
  const questionWords = normalizeComparable(question).split(" ").filter(Boolean);
  if (triggerWords.length === 0 || questionWords.length === 0) {
    return false;
  }

  return triggerWords.every((triggerWord) =>
    questionWords.some((questionWord) => wordsMatch(triggerWord, questionWord))
  );
}

/**
 * Choisit les skills a appliquer a une question.
 * `overlapScorer(a, b)` renvoie la part des mots de `a` retrouves dans `b`
 * (meme fonction de rapprochement que pour les personnalisations) : il sert
 * de repli quand aucun declencheur ne correspond.
 */
export function selectSkillsForQuestion(question, { explicitSkillId = null, overlapScorer } = {}) {
  const enabledSkills = listSkills({ enabledOnly: true });
  if (enabledSkills.length === 0) {
    return [];
  }

  const selected = [];
  const addSkill = (skill, reason, score = 1) => {
    if (!selected.some((entry) => entry.id === skill.id)) {
      selected.push({ ...skill, reason, matchScore: Number(score.toFixed(3)) });
    }
  };

  if (explicitSkillId) {
    const explicitSkill = enabledSkills.find((skill) => skill.id === explicitSkillId);
    if (explicitSkill?.userSelectable) {
      addSkill(explicitSkill, "selection");
    }
  }

  enabledSkills
    .filter((skill) => skill.activation === "always")
    .forEach((skill) => addSkill(skill, "always"));

  const scorer = typeof overlapScorer === "function" ? overlapScorer : () => 0;
  const autoCandidates = enabledSkills
    .filter((skill) => skill.activation === "auto")
    .map((skill) => {
      const matchedTriggers = skill.triggers.filter((trigger) => triggerMatchesQuestion(trigger, question));
      // Le declencheur le plus long (le plus specifique) l'emporte a egalite.
      const longestTrigger = Math.max(0, ...matchedTriggers.map((trigger) => normalizeComparable(trigger).split(" ").length));
      const titleScore = scorer(question, `${skill.title} ${skill.description}`);
      const score = matchedTriggers.length > 0 ? 1 + longestTrigger * 0.1 + titleScore * 0.5 : titleScore;
      return { skill, score };
    })
    .filter(({ score }) => score >= Math.max(autoSkillMinimumScore, 0.01))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(0, maxAutoSkillsPerAnswer));

  autoCandidates.forEach(({ skill, score }) => addSkill(skill, "auto", score));

  let remainingCharacters = maxSkillsTotalPromptCharacters;
  return selected
    .map((skill) => {
      const instructions = truncateInstructions(
        skill.instructions,
        Math.min(maxSkillPromptCharacters, Math.max(0, remainingCharacters))
      );
      remainingCharacters -= instructions.length;
      return { ...skill, instructions };
    })
    .filter((skill) => skill.instructions.length > 0);
}

export function markSkillsUsed(skills = []) {
  const ids = skills.map((skill) => skill.id).filter(Boolean);
  if (ids.length === 0) {
    return;
  }

  try {
    recordSkillUsage(ids);
  } catch (error) {
    logger.warn("Statistiques d'utilisation des skills ignorees.", { message: error.message });
  }
}
