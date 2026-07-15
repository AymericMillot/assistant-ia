import { useEffect, useState } from "react";
import { fetchJson } from "../../lib/api";
import { reportError } from "../../lib/errors";
import Alert from "../../components/ui/Alert";

const emptyForm = {
  projectName: "",
  shortName: "",
  welcomeMessage: "",
  supportEmail: "",
  supportEmailUrgent: "",
  repositoryUrl: ""
};

export default function BrandingManager() {
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function loadBranding() {
    try {
      const payload = await fetchJson("/api/admin/branding");
      setForm({ ...emptyForm, ...payload });
    } catch (requestError) {
      setError(reportError("branding:load", requestError));
    }
  }

  useEffect(() => {
    loadBranding();
  }, []);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function saveBranding(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/branding", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
      setForm({ ...emptyForm, ...payload });
      setMessage("Identité mise à jour.");
    } catch (requestError) {
      setError(reportError("branding:save", requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}
      {message && <Alert tone="success">{message}</Alert>}

      <form className="subpanel space-y-4 p-5" onSubmit={saveBranding}>
        <div>
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Identité du projet</p>
          <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
            Ces textes sont affichés aux utilisateurs dans le chat et l'en-tête.
          </p>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">Nom complet du projet</span>
          <input
            type="text"
            className="input"
            value={form.projectName}
            onChange={(event) => updateField("projectName", event.target.value)}
            maxLength={120}
            required
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">Nom court</span>
          <input
            type="text"
            className="input"
            value={form.shortName}
            onChange={(event) => updateField("shortName", event.target.value)}
            maxLength={40}
            required
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">Message d'accueil</span>
          <textarea
            className="input min-h-[80px]"
            value={form.welcomeMessage}
            onChange={(event) => updateField("welcomeMessage", event.target.value)}
            maxLength={600}
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">
            Email de support — service informatique (optionnel)
          </span>
          <input
            type="email"
            className="input"
            value={form.supportEmail}
            onChange={(event) => updateField("supportEmail", event.target.value)}
            maxLength={200}
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">
            Email de support — soucis majeur (optionnel)
          </span>
          <input
            type="email"
            className="input"
            value={form.supportEmailUrgent}
            onChange={(event) => updateField("supportEmailUrgent", event.target.value)}
            maxLength={200}
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">
            Lien du dépôt (optionnel)
          </span>
          <input
            type="url"
            className="input"
            value={form.repositoryUrl}
            onChange={(event) => updateField("repositoryUrl", event.target.value)}
          />
        </label>

        <button type="submit" className="soft-button" disabled={busy}>
          {busy ? "Enregistrement..." : "Enregistrer"}
        </button>
      </form>
    </div>
  );
}
