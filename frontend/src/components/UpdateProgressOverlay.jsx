export default function UpdateProgressOverlay({ visible, status, onClose }) {
  if (!visible) {
    return null;
  }

  const state = status?.state || {};
  const isError = state.status === "error";
  const isCompleted = !state.busy && state.status === "completed";
  // "idle" : l'updater a conclu qu'il n'y avait rien a appliquer (ex. version
  // choisie deja installee ou plus ancienne que l'actuelle). Ce n'est ni un
  // succes ni une erreur, mais l'operation est bel et bien terminee : le
  // popup ne doit pas rester bloque pour autant.
  const isNoop = !state.busy && state.status === "idle";
  const isFinished = isError || isCompleted || isNoop;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(248,250,252,0.82)] px-4 backdrop-blur-xl">
      <div className="panel relative w-full max-w-2xl px-6 py-6 sm:px-8">
        <button
          type="button"
          onClick={onClose}
          aria-label="Fermer"
          title="Fermer (la mise à jour continue en arrière-plan si elle n'est pas terminée)"
          className="absolute right-5 top-5 flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        <div
          className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full border shadow-soft ${
            isError
              ? "border-rose-200 bg-rose-50"
              : isCompleted
                ? "border-emerald-200 bg-emerald-50"
                : "border-slate-200 bg-white"
          }`}
        >
          {isError ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 text-rose-600">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          ) : isCompleted ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 text-emerald-600">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : isNoop ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 text-slate-500">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v4l3 2" />
            </svg>
          ) : (
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-slate-900" />
          )}
        </div>

        <h2 className="mt-5 text-center text-2xl font-semibold tracking-[-0.05em] text-slate-950">
          {isError
            ? "Échec de la mise à jour"
            : isCompleted
              ? "Mise à jour terminée"
              : isNoop
                ? "Rien à appliquer"
                : "Mise à jour en cours"}
        </h2>
        <p className="mt-3 text-center text-sm leading-6 text-slate-500">
          {isError
            ? "Une sauvegarde de rollback a été créée avant l'opération : vous pouvez y revenir depuis la liste des sauvegardes."
            : isCompleted
              ? "La page va se recharger automatiquement pour afficher la nouvelle version."
              : isNoop
                ? state.message || "Cette version ne nécessite aucune action."
                : "L'application télécharge la nouvelle version, applique les fichiers puis redémarre les services."}
        </p>

        <div className="mt-6 rounded-[24px] border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between gap-4 text-sm text-slate-600">
            <span>{state.message || "Préparation..."}</span>
            <span>{state.progress || 0}%</span>
          </div>
          <div className="mt-3 h-2.5 rounded-full bg-slate-200">
            <div
              className={`h-2.5 rounded-full transition-all duration-500 ${isError ? "bg-rose-500" : isCompleted ? "bg-emerald-500" : "bg-slate-900"}`}
              style={{ width: `${state.progress || 0}%` }}
            />
          </div>
        </div>

        <div className="mt-5 rounded-[24px] border border-slate-200 bg-[#f7f8fa] p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
            Journal
          </p>
          <div className="mt-3 max-h-48 space-y-2 overflow-y-auto text-sm leading-6 text-slate-600">
            {(state.logs || []).slice().reverse().map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </div>

        {isFinished ? (
          <button type="button" className="soft-button mt-6 w-full justify-center" onClick={onClose}>
            Fermer
          </button>
        ) : null}
      </div>
    </div>
  );
}
