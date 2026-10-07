// Tests des skills, de l'export CSV et de la verification des chemins (sans
// Ollama ni ChromaDB).
//
//   docker exec assistant-ia-backend npm test
//   (ou, en local : cd backend && npm test)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import AdmZip from "adm-zip";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
process.env.SQLITE_PATH = path.join(tempRoot, "test.sqlite");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.LOGS_DIR = path.join(tempRoot, "logs");
process.env.CHROMA_URL = "http://127.0.0.1:9";
process.env.OLLAMA_URL = "http://127.0.0.1:9";

let skills;
let rag;

before(async () => {
  const db = await import("../config/db.js");
  db.initializeDatabase();
  skills = await import("../services/skillService.js");
  rag = await import("../services/ragService.js");
});

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("un fichier SKILL.md est lu avec son en-tete", () => {
  const parsed = skills.parseSkillMarkdown(`---
title: Diagnostic
description: Aide au depannage
activation: manuel
user_selectable: non
triggers:
  - ne démarre pas
  - message d'erreur
---

# Diagnostic
Commence toujours par la securite de l'utilisateur.`);

  const skill = skills.normalizeSkillInput(parsed);
  assert.equal(skill.title, "Diagnostic");
  assert.equal(skill.activation, "manual");
  assert.equal(skill.userSelectable, false);
  assert.deepEqual(skill.triggers, ["ne démarre pas", "message d'erreur"]);
  assert.match(skill.instructions, /securite/);
});

test("des instructions vides ou trop courtes sont refusees", () => {
  assert.throws(() => skills.normalizeSkillInput({ title: "X", instructions: "court" }), /20 caractères/);
  assert.throws(() => skills.normalizeSkillInput({ title: "", instructions: "x".repeat(30) }), /titre/i);
});

test("un declencheur exige tous ses mots, a la terminaison pres", () => {
  assert.equal(skills.triggerMatchesQuestion("ne démarre pas", "L'imprimante ne démarre pas du tout"), true);
  assert.equal(skills.triggerMatchesQuestion("comment démarrer", "L'imprimante ne démarre pas"), false);
  assert.equal(skills.triggerMatchesQuestion("message d'erreur", "J'ai un message d'erreur sur la CNC"), true);
  assert.equal(skills.triggerMatchesQuestion("laser", "Horaires du fablab ?"), false);
});

test("selection : declencheur automatique, choix explicite et skill desactive", () => {
  const diagnostic = skills.createSkillFromInput({
    title: "Diagnostic panne",
    instructions: "Liste les causes probables de la plus probable a la moins probable.",
    triggers: ["ne marche pas"],
    activation: "auto"
  });
  const express = skills.createSkillFromInput({
    title: "Reponse express",
    instructions: "Reponds en trois puces maximum, sans introduction.",
    activation: "manual",
    userSelectable: true
  });
  const disabled = skills.createSkillFromInput({
    title: "Desactive",
    instructions: "Ne doit jamais etre selectionne par le moteur de choix.",
    triggers: ["ne marche pas"],
    isEnabled: false
  });

  const automatic = skills.selectSkillsForQuestion("La découpeuse ne marche pas", {
    overlapScorer: rag.computeTextOverlapScore
  });
  assert.deepEqual(automatic.map((skill) => skill.id), [diagnostic.id]);

  const none = skills.selectSkillsForQuestion("Quels sont les horaires ?", {
    overlapScorer: rag.computeTextOverlapScore
  });
  assert.equal(none.length, 0);

  const explicit = skills.selectSkillsForQuestion("Bonjour", {
    explicitSkillId: express.id,
    overlapScorer: rag.computeTextOverlapScore
  });
  assert.deepEqual(explicit.map((skill) => skill.reason), ["selection"]);
  assert.ok(!automatic.some((skill) => skill.id === disabled.id));
});

test("une archive ZIP regroupe SKILL.md et ses references", () => {
  const zip = new AdmZip();
  zip.addFile(
    "laser/SKILL.md",
    Buffer.from("---\ntitle: Laser\ntriggers: [laser]\n---\nSuis la procedure de l'atelier pour le laser.")
  );
  zip.addFile("laser/references/materiaux.md", Buffer.from("PVC interdit."));
  zip.addFile("__MACOSX/laser/._SKILL.md", Buffer.from("ignore"));

  const parsed = skills.parseSkillUpload({ buffer: zip.toBuffer(), originalName: "skills.zip" });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, "Laser");
  assert.match(parsed[0].instructions, /Référence : references\/materiaux\.md/);
  assert.match(parsed[0].instructions, /PVC interdit/);
});

test("un fichier non textuel est refuse", () => {
  assert.throws(
    () => skills.parseSkillUpload({ buffer: Buffer.from([0, 1, 2, 3]), originalName: "skill.md" }),
    /texte/
  );
  assert.throws(() => skills.parseSkillUpload({ buffer: Buffer.from("x"), originalName: "skill.exe" }), /Format/);
});

test("export CSV : separateur, guillemets et formules neutralisees", async () => {
  const { toCsv } = await import("../utils/csv.js");
  const csv = toCsv(
    [
      { label: "Question", key: "question" },
      { label: "Note", key: "note" }
    ],
    [{ question: '=HYPERLINK("http://x")', note: 'dit "bonjour";\nfin' }]
  );

  assert.ok(csv.startsWith("﻿Question;Note\r\n"));
  assert.match(csv, /\r\n"'=HYPERLINK/);
  assert.match(csv, /"dit ""bonjour"";\nfin"/);
});

test("ensurePathInside refuse toute sortie du dossier de base", async () => {
  const { ensurePathInside } = await import("../utils/security.js");
  const base = path.join(tempRoot, "uploads");
  assert.equal(ensurePathInside(base, path.join(base, "a", "b.pdf")), path.join(base, "a", "b.pdf"));
  assert.throws(() => ensurePathInside(base, path.join(base, "..", "secret")));
  assert.throws(() => ensurePathInside(base, `${base}-voisin/fichier`));
  assert.throws(() => ensurePathInside(base, base));
});
