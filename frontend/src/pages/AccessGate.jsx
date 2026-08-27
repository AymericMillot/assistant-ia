import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchJson } from "../lib/api";
import { reportError } from "../lib/errors";

export default function AccessGate({
  onAuthenticated,
  embedded = false,
  onCancel = null,
  heading = "Accès à l’administration",
  description = "Entrez vos identifiants d’administration pour ouvrir cet espace.",
  submitLabel = "Continuer",
  showBackButton = true
}) {
  const navigate = useNavigate();
  const [identifiant, setIdentifiant] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();

    if (!password.trim() || loading) {
      return;
    }

    setLoading(true);
    setError("");

    try {
      await fetchJson("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(identifiant.trim() ? { identifiant: identifiant.trim(), password } : { password })
      });
      onAuthenticated();
    } catch (requestError) {
      setError(reportError("accessgate", requestError));
    } finally {
      setLoading(false);
    }
  }

  const content = (
    <div className={`${embedded ? "w-full" : "panel w-full px-6 py-7 sm:px-8 sm:py-9"}`}>
      <div className="rounded-[32px] border border-white/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(247,249,252,0.92))] p-6 shadow-soft">
        <h1 className="text-3xl font-semibold tracking-[-0.05em] text-slate-950">{heading}</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">{description}</p>
      </div>

      <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
        <label className="block text-sm font-medium text-slate-700">
          Identifiant <span className="font-normal text-slate-400">(optionnel, pour un compte admin nommé)</span>
          <input
            type="text"
            className="input mt-2"
            value={identifiant}
            onChange={(event) => setIdentifiant(event.target.value)}
            placeholder="Laisser vide pour un mot de passe partagé"
            autoComplete="username"
          />
        </label>

        <label className="block text-sm font-medium text-slate-700">
          Mot de passe
          <input
            type="password"
            className="input mt-2"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Votre mot de passe"
            autoComplete="current-password"
            autoFocus
          />
        </label>

        {error && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}

        <button className="soft-button w-full justify-center" disabled={loading}>
          {loading ? "Vérification..." : submitLabel}
        </button>

        {onCancel ? (
          <button
            type="button"
            className="ghost-button w-full justify-center"
            onClick={onCancel}
          >
            Annuler
          </button>
        ) : null}

        {!onCancel && showBackButton ? (
          <button
            type="button"
            className="ghost-button w-full justify-center"
            onClick={() => navigate("/", { replace: true })}
          >
            Retour à l&apos;accueil
          </button>
        ) : null}
      </form>
    </div>
  );

  if (embedded) {
    return content;
  }

  return <section className="mx-auto flex min-h-[78vh] w-full max-w-md items-center">{content}</section>;
}
