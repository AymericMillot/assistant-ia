import { useState } from "react";
import { fetchJson } from "../../lib/api";
import { reportError } from "../../lib/errors";

export default function DataManager() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showIndexConfirm, setShowIndexConfirm] = useState(false);
  const [indexConfirmation, setIndexConfirmation] = useState("");
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
  const [purgeStep, setPurgeStep] = useState(1);
  const [purgeConfirmation, setPurgeConfirmation] = useState("");
  const [showConversationPurgeConfirm, setShowConversationPurgeConfirm] = useState(false);
  const [conversationPurgeStep, setConversationPurgeStep] = useState(1);
  const [conversationPurgeConfirmation, setConversationPurgeConfirmation] = useState("");

  async function deleteAllIndexations() {
    setBusy(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/index", {
        method: "DELETE",
        body: JSON.stringify({ confirmation: indexConfirmation })
      });
      setMessage(payload.message);
      setShowIndexConfirm(false);
      setIndexConfirmation("");
    } catch (requestError) {
      setError(reportError("datamanager", requestError));
    } finally {
      setBusy(false);
    }
  }

  async function purgeAllProjectData() {
    setBusy(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/system/data", {
        method: "DELETE",
        body: JSON.stringify({ confirmation: purgeConfirmation })
      });
      setMessage(payload.message);
      setShowPurgeConfirm(false);
      setPurgeStep(1);
      setPurgeConfirmation("");
    } catch (requestError) {
      setError(reportError("datamanager", requestError));
    } finally {
      setBusy(false);
    }
  }

  async function purgeConversationFeedbackData() {
    setBusy(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/system/conversations-feedback", {
        method: "DELETE",
        body: JSON.stringify({ confirmation: conversationPurgeConfirmation })
      });
      setMessage(payload.message);
      setShowConversationPurgeConfirm(false);
      setConversationPurgeStep(1);
      setConversationPurgeConfirmation("");
    } catch (requestError) {
      setError(reportError("datamanager", requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {(message || error) && (
        <section
          className={`subpanel px-5 py-4 sm:px-6 ${
            error
              ? "border-slate-300 bg-slate-50 text-slate-700"
              : "border-slate-300 bg-slate-50 text-slate-700"
          }`}
        >
          <p className="text-sm leading-6">{error || message}</p>
        </section>
      )}

      <section className="subpanel p-5">
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500">
              Données indexées
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950">
              Supprimer toutes les indexations
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Supprime tous les chunks et toutes les indexations stockées. Les documents restent
              présents, mais devront être réindexés ensuite.
            </p>
          </div>

          <button
            className="ghost-button border-slate-300 text-slate-700 hover:border-slate-400 hover:bg-slate-100 lg:min-w-[22rem] lg:justify-center"
            disabled={busy}
            onClick={() => {
              setShowIndexConfirm((current) => !current);
              setIndexConfirmation("");
              setError("");
              setMessage("");
            }}
          >
            Ouvrir la suppression des indexations
          </button>
        </div>

        {showIndexConfirm && (
          <div className="mt-5 rounded-[24px] border border-slate-200 bg-slate-50 p-5">
            <h3 className="text-lg font-semibold text-slate-950">Confirmation</h3>
            <p className="mt-2 text-sm leading-6 text-slate-700">
              Cette action est irréversible pour les indexations actuelles. Pour confirmer,
              écrivez <span className="font-semibold">supprimer</span>.
            </p>
            <div className="mt-4 flex flex-col gap-3 lg:flex-row">
                <input
                  className="input lg:flex-1"
                  placeholder="Écrivez supprimer"
                  value={indexConfirmation}
                  onChange={(event) => setIndexConfirmation(event.target.value)}
                />
              <div className="flex gap-3">
                <button
                  className="ghost-button"
                  disabled={busy}
                  onClick={() => {
                    setShowIndexConfirm(false);
                    setIndexConfirmation("");
                  }}
                >
                  Retour en arrière
                </button>
                <button
                  className="soft-button bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-300"
                  disabled={busy || indexConfirmation.trim().toLowerCase() !== "supprimer"}
                  onClick={deleteAllIndexations}
                >
                  Supprimer définitivement
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="subpanel border border-slate-200 bg-white p-5">
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500">
              Conversations et feedbacks
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950">
              Supprimer les conversations de feedback
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Supprime toutes les conversations enregistrées, tous les échanges, tous les feedbacks
              et toutes les règles d&apos;amélioration générées à partir de ces retours.
            </p>
          </div>

          <button
            className="ghost-button border-slate-300 text-slate-700 hover:border-slate-400 hover:bg-slate-100 lg:min-w-[22rem] lg:justify-center"
            disabled={busy}
            onClick={() => {
              setShowConversationPurgeConfirm(true);
              setConversationPurgeStep(1);
              setConversationPurgeConfirmation("");
              setError("");
              setMessage("");
            }}
          >
            Ouvrir la suppression des conversations
          </button>
        </div>

        {showConversationPurgeConfirm && (
          <div className="mt-5 rounded-[24px] border border-slate-200 bg-slate-50 p-5">
            {conversationPurgeStep === 1 && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-slate-950">Conséquences</h3>
                <div className="space-y-2 text-sm leading-6 text-slate-600">
                  <p>Toutes les conversations du chat seront supprimées.</p>
                  <p>Tous les feedbacks enregistrés seront supprimés.</p>
                  <p>Toutes les règles d&apos;amélioration dérivées de ces feedbacks seront supprimées.</p>
                  <p>Cette action est irréversible.</p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <button
                    className="ghost-button"
                    onClick={() => setShowConversationPurgeConfirm(false)}
                  >
                    Retour en arrière
                  </button>
                  <button className="soft-button" onClick={() => setConversationPurgeStep(2)}>
                    Je comprends, continuer
                  </button>
                </div>
              </div>
            )}

            {conversationPurgeStep === 2 && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-slate-950">Confirmation finale</h3>
                <p className="text-sm leading-6 text-slate-600">
                  Pour confirmer définitivement, écrivez exactement{" "}
                  <span className="font-semibold text-slate-950">supprimer</span>.
                </p>
                <input
                  className="input"
                  placeholder="Écrivez supprimer"
                  value={conversationPurgeConfirmation}
                  onChange={(event) => setConversationPurgeConfirmation(event.target.value)}
                />
                <div className="flex flex-wrap gap-3">
                  <button className="ghost-button" onClick={() => setConversationPurgeStep(1)}>
                    Retour en arrière
                  </button>
                  <button
                    className="soft-button bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-300"
                    disabled={
                      busy || conversationPurgeConfirmation.trim().toLowerCase() !== "supprimer"
                    }
                    onClick={purgeConversationFeedbackData}
                  >
                    Tout supprimer définitivement
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="subpanel border border-slate-200 bg-white p-5">
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500">
              Actions sensibles
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950">
              Supprimer toutes les données
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Cette action supprime les documents, les personnalisations, les chunks et les logs
              d&apos;indexation. Elle remet le projet à zéro.
            </p>
          </div>

          <button
            className="ghost-button border-slate-300 text-slate-700 hover:border-slate-400 hover:bg-slate-100 lg:min-w-[22rem] lg:justify-center"
            disabled={busy}
            onClick={() => {
              setShowPurgeConfirm(true);
              setPurgeStep(1);
              setPurgeConfirmation("");
              setError("");
              setMessage("");
            }}
          >
            Ouvrir la suppression totale
          </button>
        </div>

        {showPurgeConfirm && (
          <div className="mt-5 rounded-[24px] border border-slate-200 bg-slate-50 p-5">
            {purgeStep === 1 && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-slate-950">Conséquences</h3>
                <div className="space-y-2 text-sm leading-6 text-slate-600">
                  <p>Les documents importés seront supprimés du projet.</p>
                  <p>Les personnalisations écrites à la main seront supprimées.</p>
                  <p>Les chunks et indexations Chroma seront supprimés.</p>
                  <p>Les logs d&apos;indexation seront vidés.</p>
                  <p>Cette action est irréversible.</p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <button className="ghost-button" onClick={() => setShowPurgeConfirm(false)}>
                    Retour en arrière
                  </button>
                  <button className="soft-button" onClick={() => setPurgeStep(2)}>
                    Je comprends, continuer
                  </button>
                </div>
              </div>
            )}

            {purgeStep === 2 && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-slate-950">Confirmation finale</h3>
                <p className="text-sm leading-6 text-slate-600">
                  Pour confirmer définitivement, écrivez exactement{" "}
                  <span className="font-semibold text-slate-950">supprimer</span>.
                </p>
                <input
                  className="input"
                  placeholder="Écrivez supprimer"
                  value={purgeConfirmation}
                  onChange={(event) => setPurgeConfirmation(event.target.value)}
                />
                <div className="flex flex-wrap gap-3">
                  <button className="ghost-button" onClick={() => setPurgeStep(1)}>
                    Retour en arrière
                  </button>
                  <button
                    className="soft-button bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-300"
                    disabled={busy || purgeConfirmation.trim().toLowerCase() !== "supprimer"}
                    onClick={purgeAllProjectData}
                  >
                    Tout supprimer définitivement
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

      </section>
    </div>
  );
}
