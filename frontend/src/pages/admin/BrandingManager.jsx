import { useEffect, useRef, useState } from "react";
import { fetchJson } from "../../lib/api";
import { reportError } from "../../lib/errors";
import Alert from "../../components/ui/Alert";

const emptyForm = {
  projectName: "",
  shortName: "",
  welcomeMessage: "",
  supportEmail: "",
  tabTitle: ""
};

export default function BrandingManager() {
  const [form, setForm] = useState(emptyForm);
  const [faviconDataUrl, setFaviconDataUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [faviconBusy, setFaviconBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const fileInputRef = useRef(null);

  async function loadBranding() {
    try {
      const payload = await fetchJson("/api/admin/branding");
      setForm({ ...emptyForm, ...payload });
      setFaviconDataUrl(payload.faviconDataUrl || "");
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

  async function handleFaviconChange(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setFaviconBusy(true);
    setError("");
    setMessage("");

    try {
      const body = new FormData();
      body.append("favicon", file);
      // fetch brut (pas fetchJson) : FormData a besoin que le navigateur
      // pose lui-meme l'en-tete Content-Type (avec la boundary multipart),
      // ce que fetchJson ecraserait avec "application/json".
      const response = await fetch("/api/admin/branding/favicon", {
        method: "POST",
        credentials: "include",
        body
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || "Envoi du favicon impossible.");
      }
      setFaviconDataUrl(payload.faviconDataUrl || "");
      setMessage("Favicon mis à jour.");
    } catch (requestError) {
      setError(reportError("branding:favicon", requestError));
    } finally {
      setFaviconBusy(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function removeFavicon() {
    setFaviconBusy(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/branding/favicon", { method: "DELETE" });
      setFaviconDataUrl(payload.faviconDataUrl || "");
      setMessage("Favicon retiré.");
    } catch (requestError) {
      setError(reportError("branding:favicon-remove", requestError));
    } finally {
      setFaviconBusy(false);
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
          <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">
            Titre de l'onglet du navigateur (optionnel)
          </span>
          <input
            type="text"
            className="input"
            value={form.tabTitle}
            onChange={(event) => updateField("tabTitle", event.target.value)}
            placeholder={form.projectName || "Par défaut : nom du projet"}
            maxLength={70}
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

        <button type="submit" className="soft-button" disabled={busy}>
          {busy ? "Enregistrement..." : "Enregistrer"}
        </button>
      </form>

      <div className="subpanel space-y-4 p-5">
        <div>
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Favicon (icône de l'onglet)</p>
          <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
            PNG, ICO, SVG ou JPEG, 512 Ko maximum.
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
            {faviconDataUrl ? (
              <img src={faviconDataUrl} alt="Favicon actuel" className="h-8 w-8 object-contain" />
            ) : (
              <span className="text-[10px] text-slate-400">Aucun</span>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/x-icon,image/vnd.microsoft.icon,image/svg+xml,image/jpeg"
            onChange={handleFaviconChange}
            disabled={faviconBusy}
            className="text-sm text-slate-600 dark:text-slate-300"
          />

          {faviconDataUrl ? (
            <button
              type="button"
              className="ghost-button px-3 py-1.5 text-xs"
              onClick={removeFavicon}
              disabled={faviconBusy}
            >
              Retirer
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
