import { useState } from "react";
import { fetchJson } from "../lib/api";

const FEEDBACK_TYPES = {
  bug: {
    label: "Signaler un bug",
    placeholder: "Décrivez le problème rencontré : ce que vous avez fait, ce qui s'est passé...",
    successMessage: "Merci, le bug a été signalé."
  },
  suggestion: {
    label: "Faire une suggestion",
    placeholder: "Décrivez votre idée ou suggestion d'amélioration...",
    successMessage: "Merci, votre suggestion a été transmise."
  }
};

export default function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState(null);
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [status, setStatus] = useState("idle");
  const [errorMessage, setErrorMessage] = useState("");

  function resetAndClose() {
    setOpen(false);
    setType(null);
    setMessage("");
    setContact("");
    setStatus("idle");
    setErrorMessage("");
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (message.trim().length < 5) {
      setErrorMessage("Merci de décrire votre message en quelques mots (5 caractères minimum).");
      return;
    }

    setStatus("sending");
    setErrorMessage("");

    try {
      await fetchJson(`/api/feedback/${type}`, {
        method: "POST",
        body: JSON.stringify({ message: message.trim(), contact: contact.trim() })
      });
      setStatus("sent");
    } catch (error) {
      setStatus("idle");
      setErrorMessage(error.message || "Une erreur est survenue. Réessayez plus tard.");
    }
  }

  return (
    <div className="fixed bottom-5 right-5 z-40">
      {open ? (
        <div className="mb-3 w-[calc(100vw-2.5rem)] max-w-sm rounded-3xl border border-slate-200 bg-white/98 p-5 shadow-[0_24px_60px_rgba(15,23,42,0.18)] backdrop-blur-xl dark:border-slate-700/80 dark:bg-slate-900/98">
          {status === "sent" ? (
            <div className="space-y-3 text-sm">
              <p className="font-medium text-slate-900 dark:text-slate-100">
                {FEEDBACK_TYPES[type].successMessage}
              </p>
              <button type="button" className="ghost-button" onClick={resetAndClose}>
                Fermer
              </button>
            </div>
          ) : type ? (
            <form className="space-y-3" onSubmit={handleSubmit}>
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {FEEDBACK_TYPES[type].label}
                </p>
                <button
                  type="button"
                  className="text-xs text-slate-400 transition hover:text-slate-700 dark:hover:text-slate-200"
                  onClick={() => setType(null)}
                >
                  Retour
                </button>
              </div>

              <textarea
                className="w-full resize-none rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                rows={4}
                maxLength={1000}
                placeholder={FEEDBACK_TYPES[type].placeholder}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                autoFocus
              />

              <input
                type="text"
                className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                maxLength={200}
                placeholder="Contact (optionnel, pour vous répondre)"
                value={contact}
                onChange={(event) => setContact(event.target.value)}
              />

              {errorMessage ? (
                <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{errorMessage}</p>
              ) : null}

              <button
                type="submit"
                className="w-full rounded-2xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
                disabled={status === "sending"}
              >
                {status === "sending" ? "Envoi…" : "Envoyer"}
              </button>
            </form>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Une remarque à nous transmettre ?
              </p>
              <button
                type="button"
                className="ghost-button w-full justify-start gap-2"
                onClick={() => setType("bug")}
              >
                🐞 Signaler un bug
              </button>
              <button
                type="button"
                className="ghost-button w-full justify-start gap-2"
                onClick={() => setType("suggestion")}
              >
                💡 Faire une suggestion
              </button>
            </div>
          )}
        </div>
      ) : null}

      <button
        type="button"
        className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-900 text-white shadow-[0_18px_40px_rgba(15,23,42,0.28)] transition hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
        onClick={() => (open ? resetAndClose() : setOpen(true))}
        aria-label={open ? "Fermer le formulaire de retour" : "Signaler un bug ou faire une suggestion"}
      >
        {open ? (
          <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
            <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
            <path
              d="M10 2.5a6.5 6.5 0 00-5.4 10.1L4 17.5l4.9-1.3A6.5 6.5 0 1010 2.5z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <path d="M10 8v3.2M10 13.4h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        )}
      </button>
    </div>
  );
}
