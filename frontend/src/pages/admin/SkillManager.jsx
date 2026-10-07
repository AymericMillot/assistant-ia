import { useEffect, useRef, useState } from "react";
import { fetchJson, formatDateTime } from "../../lib/api";
import { reportError } from "../../lib/errors";
import Alert from "../../components/ui/Alert";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import EmptyState from "../../components/ui/EmptyState";
import StatusBadge from "../../components/ui/StatusBadge";

const emptyForm = {
  title: "",
  description: "",
  instructions: "",
  triggers: "",
  activation: "auto",
  userSelectable: true
};

const activationLabels = {
  auto: "Automatique",
  always: "Toujours",
  manual: "Sur choix de l'utilisateur"
};

const activationHelp = {
  auto: "Appliqué quand un déclencheur (ou le titre) correspond à la question.",
  always: "Appliqué à toutes les réponses : à réserver aux consignes très courtes.",
  manual: "Appliqué uniquement quand l'utilisateur le choisit dans le chat."
};

function skillToForm(skill) {
  return {
    title: skill.title,
    description: skill.description,
    instructions: skill.instructions,
    triggers: (skill.triggers || []).join("\n"),
    activation: skill.activation,
    userSelectable: skill.userSelectable
  };
}

export default function SkillManager() {
  const [skills, setSkills] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [skillToDelete, setSkillToDelete] = useState(null);
  const [testQuestion, setTestQuestion] = useState("");
  const [testResult, setTestResult] = useState(null);
  const fileInputRef = useRef(null);

  async function load() {
    try {
      const payload = await fetchJson("/api/admin/skills");
      setSkills(payload.skills || []);
      setTemplates(payload.templates || []);
    } catch (requestError) {
      setError(reportError("skills:load", requestError));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function run(action, context) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const payload = await action();
      if (payload?.message) {
        setMessage(payload.message);
      }
      await load();
      return payload;
    } catch (requestError) {
      setError(reportError(context, requestError));
      return null;
    } finally {
      setBusy(false);
    }
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setFormOpen(true);
  }

  function openEdit(skill) {
    setEditingId(skill.id);
    setForm(skillToForm(skill));
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submitForm(event) {
    event.preventDefault();
    const body = JSON.stringify({
      ...form,
      triggers: form.triggers
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean)
    });
    const payload = await run(
      () =>
        editingId
          ? fetchJson(`/api/admin/skills/${editingId}`, { method: "PATCH", body })
          : fetchJson("/api/admin/skills", { method: "POST", body }),
      "skills:save"
    );
    if (payload) {
      setFormOpen(false);
      setEditingId(null);
      setForm(emptyForm);
    }
  }

  function toggleSkill(skill) {
    run(
      () =>
        fetchJson(`/api/admin/skills/${skill.id}`, {
          method: "PATCH",
          body: JSON.stringify({ isEnabled: !skill.isEnabled })
        }),
      "skills:toggle"
    );
  }

  function installTemplate(template) {
    run(() => fetchJson(`/api/admin/skills/templates/${template.slug}`, { method: "POST" }), "skills:template");
  }

  async function importFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    await run(async () => {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/admin/skills/import", {
        method: "POST",
        credentials: "include",
        body: formData
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || "L'import a échoué.");
      }
      return payload;
    }, "skills:import");
  }

  async function runTest(event) {
    event.preventDefault();
    if (!testQuestion.trim()) {
      return;
    }

    try {
      const payload = await fetchJson("/api/admin/skills/test", {
        method: "POST",
        body: JSON.stringify({ question: testQuestion })
      });
      setTestResult(payload.skills || []);
    } catch (requestError) {
      setError(reportError("skills:test", requestError));
    }
  }

  return (
    <div className="space-y-6">
      <section className="panel px-6 py-6 sm:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500 dark:text-slate-400">Skills</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-slate-50">
              Méthodes de réponse prédéfinies
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              Un skill décrit <em>comment</em> répondre à un type de demande (procédure pas à pas, diagnostic de
              panne, réponse courte…). Les faits viennent toujours des documents et des personnalisations. Déposez un
              fichier <code>SKILL.md</code> (ou un <code>.zip</code> de skills), partez d&apos;un modèle, ou rédigez-le ici.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,.txt,.zip"
              className="hidden"
              onChange={importFile}
            />
            <button className="ghost-button" type="button" disabled={busy} onClick={() => fileInputRef.current?.click()}>
              Déposer un fichier
            </button>
            <button className="soft-button" type="button" disabled={busy} onClick={openCreate}>
              Nouveau skill
            </button>
          </div>
        </div>
      </section>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}

      {formOpen ? (
        <section className="subpanel p-6">
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
            {editingId ? "Modifier le skill" : "Nouveau skill"}
          </h3>
          <form className="mt-4 grid gap-4 lg:grid-cols-2" onSubmit={submitForm}>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
              Titre
              <input
                className="input mt-2"
                value={form.title}
                maxLength={120}
                required
                onChange={(event) => setForm({ ...form, title: event.target.value })}
              />
            </label>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
              Activation
              <select
                className="input mt-2"
                value={form.activation}
                onChange={(event) => setForm({ ...form, activation: event.target.value })}
              >
                {Object.entries(activationLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs font-normal text-slate-500 dark:text-slate-400">
                {activationHelp[form.activation]}
              </span>
            </label>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 lg:col-span-2">
              Description (visible par les utilisateurs)
              <input
                className="input mt-2"
                value={form.description}
                maxLength={500}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </label>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 lg:col-span-2">
              Instructions pour l&apos;assistant (Markdown)
              <textarea
                className="input mt-2 min-h-[220px] font-mono text-[13px]"
                value={form.instructions}
                maxLength={20000}
                required
                onChange={(event) => setForm({ ...form, instructions: event.target.value })}
              />
            </label>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
              Déclencheurs (un par ligne)
              <textarea
                className="input mt-2 min-h-[120px]"
                value={form.triggers}
                placeholder={"ne démarre pas\nmessage d'erreur"}
                onChange={(event) => setForm({ ...form, triggers: event.target.value })}
              />
              <span className="mt-1 block text-xs font-normal text-slate-500 dark:text-slate-400">
                Le skill s&apos;applique quand tous les mots d&apos;un déclencheur sont dans la question.
              </span>
            </label>
            <div className="space-y-3 text-sm text-slate-700 dark:text-slate-200">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.userSelectable}
                  onChange={(event) => setForm({ ...form, userSelectable: event.target.checked })}
                />
                Proposé aux utilisateurs dans le chat (« Choisir une méthode »)
              </label>
              <div className="flex gap-2 pt-2">
                <button className="soft-button" type="submit" disabled={busy}>
                  {editingId ? "Enregistrer" : "Créer"}
                </button>
                <button className="ghost-button" type="button" onClick={() => setFormOpen(false)}>
                  Annuler
                </button>
              </div>
            </div>
          </form>
        </section>
      ) : null}

      <section className="subpanel p-6">
        <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Skills installés</h3>
        <div className="mt-4 space-y-3">
          {skills.length === 0 ? (
            <EmptyState
              title="Aucun skill pour l'instant."
              description="Installez un modèle ci-dessous ou déposez un fichier SKILL.md."
            />
          ) : (
            skills.map((skill) => (
              <article
                key={skill.id}
                className="rounded-[20px] border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-slate-900 dark:text-slate-100">{skill.title}</p>
                      <StatusBadge tone={skill.isEnabled ? "success" : "neutral"}>
                        {skill.isEnabled ? "Actif" : "Désactivé"}
                      </StatusBadge>
                      <StatusBadge tone="info" withDot={false}>
                        {activationLabels[skill.activation]}
                      </StatusBadge>
                      {skill.userSelectable ? (
                        <StatusBadge tone="neutral" withDot={false}>
                          Proposé dans le chat
                        </StatusBadge>
                      ) : null}
                    </div>
                    {skill.description ? (
                      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{skill.description}</p>
                    ) : null}
                    {skill.triggers.length > 0 ? (
                      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                        Déclencheurs : {skill.triggers.join(" · ")}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                      Utilisé {skill.usageCount} fois
                      {skill.lastUsedAt ? ` · dernière fois ${formatDateTime(`${skill.lastUsedAt.replace(" ", "T")}Z`)}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button className="ghost-button px-3 py-1.5 text-[13px]" type="button" disabled={busy} onClick={() => toggleSkill(skill)}>
                      {skill.isEnabled ? "Désactiver" : "Activer"}
                    </button>
                    <button className="ghost-button px-3 py-1.5 text-[13px]" type="button" onClick={() => openEdit(skill)}>
                      Modifier
                    </button>
                    <a className="ghost-button px-3 py-1.5 text-[13px]" href={`/api/admin/skills/${skill.id}/export`}>
                      Exporter
                    </a>
                    <button
                      className="ghost-button px-3 py-1.5 text-[13px] text-rose-600 dark:text-rose-300"
                      type="button"
                      disabled={busy}
                      onClick={() => setSkillToDelete(skill)}
                    >
                      Supprimer
                    </button>
                  </div>
                </div>
              </article>
            ))
          )}
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="subpanel p-6">
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Modèles prêts à l&apos;emploi</h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Installez-les puis adaptez-les à votre atelier.
          </p>
          <ul className="mt-4 space-y-2">
            {templates.map((template) => (
              <li
                key={template.slug}
                className="flex items-start justify-between gap-3 rounded-[16px] border border-slate-200 p-3 dark:border-slate-700"
              >
                <div>
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{template.title}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{template.description}</p>
                </div>
                <button
                  className={template.installed ? "ghost-button px-3 py-1.5 text-[13px]" : "soft-button px-3 py-1.5 text-[13px]"}
                  type="button"
                  disabled={busy || template.installed}
                  onClick={() => installTemplate(template)}
                >
                  {template.installed ? "Installé" : "Installer"}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="subpanel p-6">
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Tester une question</h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Vérifiez quels skills s&apos;appliqueraient automatiquement, sans interroger le modèle.
          </p>
          <form className="mt-4 flex gap-2" onSubmit={runTest}>
            <input
              className="input"
              value={testQuestion}
              placeholder="Ex. : la découpeuse laser affiche une erreur"
              onChange={(event) => setTestQuestion(event.target.value)}
            />
            <button className="soft-button" type="submit">
              Tester
            </button>
          </form>
          {testResult ? (
            testResult.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">Aucun skill ne s&apos;appliquerait.</p>
            ) : (
              <ul className="mt-3 space-y-1 text-sm text-slate-700 dark:text-slate-200">
                {testResult.map((skill) => (
                  <li key={skill.id}>
                    ✦ {skill.title}{" "}
                    <span className="text-xs text-slate-400">
                      ({skill.reason === "always" ? "toujours" : `score ${skill.matchScore}`})
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : null}
          <details className="mt-5 text-sm text-slate-600 dark:text-slate-300">
            <summary className="cursor-pointer font-medium">Format d&apos;un fichier SKILL.md</summary>
            <pre className="mt-2 overflow-x-auto rounded-xl bg-slate-50 p-3 text-[12px] leading-5 dark:bg-slate-800">{`---
title: Diagnostic de panne
description: Guide pas à pas pour une machine en panne
activation: auto        # auto | always | manual
user_selectable: true
triggers:
  - ne démarre pas
  - message d'erreur
---

# Instructions
Commence par la sécurité, puis liste les causes probables…`}</pre>
          </details>
        </div>
      </section>

      <ConfirmDialog
        open={Boolean(skillToDelete)}
        variant="danger"
        title="Supprimer ce skill ?"
        message={skillToDelete ? `« ${skillToDelete.title} » ne sera plus appliqué aux réponses.` : ""}
        confirmLabel="Supprimer"
        onCancel={() => setSkillToDelete(null)}
        onConfirm={async () => {
          const target = skillToDelete;
          setSkillToDelete(null);
          await run(() => fetchJson(`/api/admin/skills/${target.id}`, { method: "DELETE" }), "skills:delete");
        }}
      />
    </div>
  );
}
