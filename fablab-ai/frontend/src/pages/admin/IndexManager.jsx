import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { fetchJson, formatDateTime } from "../../lib/api";
import { reportError } from "../../lib/errors";
import ConfirmDialog from "../../components/ui/ConfirmDialog";

export default function IndexManager({ onRefreshSummary }) {
  const [status, setStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [showReindexConfirm, setShowReindexConfirm] = useState(false);
  const activeDocumentIndexes = status?.activeDocumentIndexes || [];
  const remainingDocumentsToIndex =
    (status?.documentStats?.pendingDocuments ?? 0) + (status?.documentStats?.erroredDocuments ?? 0);
  const hasAnyIndexingActivity =
    Boolean(status?.isRunning || status?.isPending || status?.isPaused) ||
    activeDocumentIndexes.length > 0;

  async function loadStatus() {
    try {
      const [statusPayload, logsPayload] = await Promise.all([
        fetchJson("/api/admin/index/status"),
        fetchJson("/api/admin/index/logs")
      ]);
      setStatus(statusPayload);
      setLogs(logsPayload.logs || []);
    } catch (requestError) {
      setError(reportError("indexmanager", requestError));
    }
  }

  useEffect(() => {
    loadStatus();

    const socket = io("/", {
      transports: ["websocket"],
      withCredentials: true
    });

    socket.on("indexing:progress", (payload) => {
      setStatus(payload);
      onRefreshSummary();
    });

    socket.on("indexing:log", (entry) => {
      setLogs((current) => [...current.slice(-49), entry]);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  async function triggerReindex() {
    setShowReindexConfirm(false);
    setBusy(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/index/reindex", {
        method: "POST"
      });
      setMessage(payload.message);
      await loadStatus();
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError("indexmanager", requestError));
    } finally {
      setBusy(false);
    }
  }

  async function stopReindex() {
    setBusy(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/index/stop", {
        method: "POST"
      });
      setMessage(payload.message);
      await loadStatus();
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError("indexmanager", requestError));
    } finally {
      setBusy(false);
    }
  }

  async function stopAllIndexing() {
    setBusy(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/index/stop-all", {
        method: "POST"
      });
      setMessage(payload.message);
      await loadStatus();
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError("indexmanager", requestError));
    } finally {
      setBusy(false);
    }
  }

  async function pauseIndexing() {
    setBusy(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/index/pause", {
        method: "POST"
      });
      setMessage(payload.message);
      await loadStatus();
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError("indexmanager", requestError));
    } finally {
      setBusy(false);
    }
  }

  async function resumeIndexing() {
    setBusy(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/index/resume", {
        method: "POST"
      });
      setMessage(payload.message);
      await loadStatus();
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError("indexmanager", requestError));
    } finally {
      setBusy(false);
    }
  }

  async function toggleAutoIndex() {
    if (!status) {
      return;
    }

    setBusy(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/index/auto", {
        method: "PATCH",
        body: JSON.stringify({ enabled: !status.autoIndexEnabled })
      });
      setMessage(payload.message);
      await loadStatus();
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError("indexmanager", requestError));
    } finally {
      setBusy(false);
    }
  }

  async function continueMissingIndexing() {
    setBusy(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/index/continue-missing", {
        method: "POST"
      });
      setMessage(payload.message);
      await loadStatus();
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError("indexmanager", requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="grid gap-4 lg:grid-cols-4">
        <article className="subpanel p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-brand/75">
            Dernière indexation
          </p>
          <h3 className="mt-3 text-lg font-bold text-slate-900">
            {formatDateTime(status?.lastFullIndexAt)}
          </h3>
        </article>

        <article className="subpanel p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-brand/75">
            Documents indexés
          </p>
          <h3 className="mt-3 text-lg font-bold text-slate-900">
            {status?.lastIndexedDocumentsCount ?? 0}
          </h3>
        </article>

        <article className="subpanel p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-brand/75">
            Auto-indexation
          </p>
          <h3 className="mt-3 text-lg font-bold text-slate-900">
            {status?.autoIndexEnabled ? "Activée" : "Désactivée"}
          </h3>
        </article>

        <article className="subpanel p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-brand/75">
            Erreurs
          </p>
          <h3 className="mt-3 text-lg font-bold text-slate-900">
            {status?.documentStats?.erroredDocuments ?? 0}
          </h3>
        </article>
      </section>

      <section className="subpanel p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="text-lg font-bold text-slate-900">Pilotage de l&apos;indexation</h3>
            <p className="mt-1 text-sm text-slate-500">
              Réindexation complète, suivi temps réel et activation automatique.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <button className="ghost-button" disabled={busy} onClick={toggleAutoIndex}>
              {status?.autoIndexEnabled ? "Désactiver l'auto-indexation" : "Activer l'auto-indexation"}
            </button>
            <button className="soft-button" disabled={busy} onClick={() => setShowReindexConfirm(true)}>
              Forcer une réindexation complète
            </button>
            <ConfirmDialog
              open={showReindexConfirm}
              variant="normal"
              title="Forcer une réindexation complète ?"
              message="Tous les documents seront réindexés depuis zéro. Cette opération peut être longue et sollicite fortement la machine ; l'assistant reste utilisable pendant ce temps."
              confirmLabel="Lancer la réindexation"
              onConfirm={triggerReindex}
              onCancel={() => setShowReindexConfirm(false)}
            />
            <button
              className="ghost-button"
              disabled={busy || remainingDocumentsToIndex === 0}
              onClick={continueMissingIndexing}
            >
              Continuer les fichiers restants
            </button>
            {status?.isPaused ? (
              <button className="ghost-button" disabled={busy} onClick={resumeIndexing}>
                Reprendre l&apos;indexation
              </button>
            ) : (
              <button className="ghost-button" disabled={busy} onClick={pauseIndexing}>
                Mettre en pause l&apos;indexation
              </button>
            )}
            {(status?.isRunning || status?.isPending) && (
              <button className="ghost-button" disabled={busy} onClick={stopReindex}>
                Arrêter la réindexation
              </button>
            )}
            {(status?.isRunning || status?.isPending || status?.activeDocumentIndexCount > 0) && (
              <button
                className="ghost-button border-rose-200 text-rose-700 hover:border-rose-300 hover:bg-rose-50"
                disabled={busy}
                onClick={stopAllIndexing}
              >
                Arrêter toutes les indexations
              </button>
            )}
          </div>
        </div>

        <div className="mt-6 rounded-[24px] bg-slate-50 p-5">
          <div className="mb-3 flex items-center justify-between text-sm text-slate-600">
            <span>
              {status?.isRunning
                ? `Traitement de ${status.currentFile || "la collection"}`
                : status?.isPaused
                  ? "Indexation en pause"
                : status?.isPending
                  ? "Réindexation complète en attente"
                  : activeDocumentIndexes.length > 0
                    ? "Indexations individuelles en cours"
                    : "Aucune réindexation active"}
            </span>
            <span>{status?.progressPercent ?? 0}%</span>
          </div>
          <div className="h-3 rounded-full bg-slate-200">
            <div
              className="h-3 rounded-full bg-brand transition-all duration-300"
              style={{ width: `${status?.progressPercent ?? 0}%` }}
            />
          </div>
          <div className="mt-3 text-sm text-slate-500">
            {status?.processed ?? 0}/{status?.total ?? 0} documents traités · succès{" "}
            {status?.successful ?? 0} · erreurs {status?.failed ?? 0}
            {typeof status?.createdChunks === "number"
              ? ` · chunks créés ${status.createdChunks}`
              : ""}
            {status?.activeDocumentIndexCount > 0
              ? ` · fichiers individuels en cours ${status.activeDocumentIndexCount}`
              : ""}
            {remainingDocumentsToIndex > 0
              ? ` · fichiers restants ${remainingDocumentsToIndex}`
              : ""}
          </div>
          {status?.cancellationRequested ? (
            <div className="mt-2 text-sm text-amber-600">
              Arrêt demandé. La réindexation se termine proprement après le document en cours.
            </div>
          ) : null}
          {status?.isPaused ? (
            <div className="mt-2 text-sm text-sky-600">
              L&apos;indexation est en pause. Tu peux la reprendre à tout moment sans perdre la progression.
            </div>
          ) : null}
          {activeDocumentIndexes.length > 0 ? (
            <div className="mt-4 space-y-3">
              <p className="text-sm font-medium text-slate-700">
                Fichiers individuels actuellement pris en charge
              </p>
              <div className="space-y-2">
	                {activeDocumentIndexes.map((entry) => (
                  <div
                    key={`${entry.documentId}-${entry.jobId || entry.queuedAt || entry.fileName}`}
                    className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
                  >
	                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-slate-900">
                          {entry.fileName}
                        </div>
                        <div className="truncate text-xs text-slate-500">
                          {entry.relativePath || "Chemin indisponible"}
                        </div>
                      </div>
                      <span
                        className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-semibold ${
                          entry.status === "running"
                            ? "bg-emerald-50 text-emerald-700"
                            : entry.status === "stopping"
                              ? "bg-amber-50 text-amber-700"
                              : "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {entry.status === "running"
                          ? "En cours"
                          : entry.status === "stopping"
                            ? "Arrêt demandé"
                            : "En attente"}
                      </span>
	                    </div>
                      <div className="mt-2 text-xs text-slate-500">
                        Chunks créés {entry.chunkCount ?? 0}
                        {entry.totalChunks > 0 ? ` / ${entry.totalChunks}` : ""}
                      </div>
	                  </div>
	                ))}
              </div>
            </div>
          ) : null}
        </div>

        {(message || error) && (
          <div
            className={`mt-4 rounded-2xl px-4 py-3 text-sm ${
              error
                ? "border border-rose-200 bg-rose-50 text-rose-700"
                : "border border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            {error || message}
          </div>
        )}
      </section>

      <section className="subpanel p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-slate-900">Logs d&apos;indexation</h3>
            <p className="mt-1 text-sm text-slate-500">
              Dernières 50 lignes du journal temps réel.
            </p>
          </div>
          <button className="ghost-button" disabled={busy || hasAnyIndexingActivity} onClick={loadStatus}>
            Actualiser
          </button>
        </div>

        <div className="mt-5 rounded-[24px] bg-slate-950 p-4 font-mono text-xs text-slate-200">
          <div className="max-h-[360px] space-y-2 overflow-y-auto">
            {logs.map((entry, index) => (
              <div key={`${entry.timestamp}-${index}`} className="leading-6">
                <span className="text-cyan-300">{entry.timestamp}</span>{" "}
                <span className="text-slate-400">[{entry.level}]</span>{" "}
                <span>{entry.message}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
