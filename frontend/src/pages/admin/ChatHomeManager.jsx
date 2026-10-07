import { useEffect, useState } from "react";
import { fetchJson } from "../../lib/api";
import { reportError } from "../../lib/errors";
import Alert from "../../components/ui/Alert";

const toneLabels = {
  info: "Information",
  warning: "Avertissement",
  critical: "Important (rouge)"
};

function toLocalInputValue(isoValue) {
  if (!isoValue) {
    return "";
  }

  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const offsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export default function ChatHomeManager() {
  const [announcement, setAnnouncement] = useState({ enabled: false, message: "", tone: "info", expiresAt: "" });
  const [suggestions, setSuggestions] = useState({ mode: "auto", manual: "" });
  const [preview, setPreview] = useState({ announcement: null, suggestions: [] });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function applyPayload(payload) {
    setAnnouncement({
      enabled: Boolean(payload.announcement?.enabled),
      message: payload.announcement?.message || "",
      tone: payload.announcement?.tone || "info",
      expiresAt: toLocalInputValue(payload.announcement?.expiresAt)
    });
    setSuggestions({
      mode: payload.suggestions?.mode || "auto",
      manual: (payload.suggestions?.manual || []).join("\n")
    });
    setPreview(payload.preview || { announcement: null, suggestions: [] });
  }

  useEffect(() => {
    fetchJson("/api/admin/chat-home")
      .then(applyPayload)
      .catch((requestError) => setError(reportError("chat-home:load", requestError)));
  }, []);

  async function save(url, body, context) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const payload = await fetchJson(url, { method: "PUT", body: JSON.stringify(body) });
      applyPayload(payload);
      setMessage(payload.message);
    } catch (requestError) {
      setError(reportError(context, requestError));
    } finally {
      setBusy(false);
    }
  }

  function saveAnnouncement(event) {
    event.preventDefault();
    save(
      "/api/admin/chat-home/announcement",
      {
        ...announcement,
        expiresAt: announcement.expiresAt ? new Date(announcement.expiresAt).toISOString() : null
      },
      "chat-home:announcement"
    );
  }

  function saveSuggestions(event) {
    event.preventDefault();
    save(
      "/api/admin/chat-home/suggestions",
      {
        mode: suggestions.mode,
        manual: suggestions.manual
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean)
      },
      "chat-home:suggestions"
    );
  }

  return (
    <div className="space-y-6">
      <section className="panel px-6 py-6 sm:px-8">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500 dark:text-slate-400">
          Accueil du chat
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-slate-50">
          Annonce et questions suggérées
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500 dark:text-slate-400">
          Prévenez les utilisateurs d&apos;une fermeture ou d&apos;une machine en maintenance, et proposez-leur des
          questions pour démarrer.
        </p>
      </section>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}

      <section className="grid gap-6 lg:grid-cols-2">
        <form className="subpanel space-y-4 p-6" onSubmit={saveAnnouncement}>
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Bandeau d&apos;annonce</h3>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={announcement.enabled}
              onChange={(event) => setAnnouncement({ ...announcement, enabled: event.target.checked })}
            />
            Afficher l&apos;annonce en haut du chat
          </label>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
            Message
            <textarea
              className="input mt-2 min-h-[90px]"
              maxLength={400}
              value={announcement.message}
              placeholder="Ex. : la découpeuse laser est en maintenance jusqu'à jeudi."
              onChange={(event) => setAnnouncement({ ...announcement, message: event.target.value })}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
              Niveau
              <select
                className="input mt-2"
                value={announcement.tone}
                onChange={(event) => setAnnouncement({ ...announcement, tone: event.target.value })}
              >
                {Object.entries(toneLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
              Masquer automatiquement le
              <input
                type="datetime-local"
                className="input mt-2"
                value={announcement.expiresAt}
                onChange={(event) => setAnnouncement({ ...announcement, expiresAt: event.target.value })}
              />
            </label>
          </div>
          <button className="soft-button" type="submit" disabled={busy}>
            Enregistrer l&apos;annonce
          </button>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            État actuel :{" "}
            {preview.announcement ? "visible dans le chat." : "aucune annonce visible (désactivée, vide ou expirée)."}
          </p>
        </form>

        <form className="subpanel space-y-4 p-6" onSubmit={saveSuggestions}>
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Questions suggérées</h3>
          <fieldset className="space-y-2 text-sm text-slate-700 dark:text-slate-200">
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="suggestion-mode"
                checked={suggestions.mode === "auto"}
                onChange={() => setSuggestions({ ...suggestions, mode: "auto" })}
              />
              <span>
                Automatique : les questions fréquentes (posées dans au moins 3 conversations et bien couvertes par la
                documentation), complétées par la liste ci-dessous.
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="suggestion-mode"
                checked={suggestions.mode === "manual"}
                onChange={() => setSuggestions({ ...suggestions, mode: "manual" })}
              />
              <span>Uniquement la liste ci-dessous.</span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="suggestion-mode"
                checked={suggestions.mode === "off"}
                onChange={() => setSuggestions({ ...suggestions, mode: "off" })}
              />
              <span>Aucune suggestion.</span>
            </label>
          </fieldset>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
            Suggestions choisies (une par ligne, 8 maximum)
            <textarea
              className="input mt-2 min-h-[110px]"
              value={suggestions.manual}
              placeholder={"Comment réserver une machine ?\nQuels matériaux peut-on découper au laser ?"}
              onChange={(event) => setSuggestions({ ...suggestions, manual: event.target.value })}
            />
          </label>
          <button className="soft-button" type="submit" disabled={busy}>
            Enregistrer les suggestions
          </button>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Affichées actuellement :{" "}
            {preview.suggestions.length === 0 ? "aucune." : preview.suggestions.map((entry) => `« ${entry} »`).join(", ")}
          </div>
        </form>
      </section>
    </div>
  );
}
