import { useEffect, useState } from "react";
import { fetchJson, formatBytes, formatDateTime } from "../../lib/api";
import { reportError } from "../../lib/errors";
import Alert from "../../components/ui/Alert";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import EmptyState from "../../components/ui/EmptyState";
import StatusBadge from "../../components/ui/StatusBadge";

function attachmentStatusTone(attachment) {
  if (attachment.status === "kept") {
    return "success";
  }

  if (attachment.indexingStatus === "error") {
    return "danger";
  }

  return "warning";
}

function attachmentStatusLabel(attachment) {
  if (attachment.status === "kept") {
    return "Conservée";
  }

  if (attachment.indexingStatus === "error") {
    return "Erreur d'indexation";
  }

  return "À trier";
}

export default function AttachmentManager() {
  const [attachments, setAttachments] = useState([]);
  const [retentionDays, setRetentionDays] = useState(30);
  const [attachmentsEnabled, setAttachmentsEnabled] = useState(true);
  const [attachmentsLocked, setAttachmentsLocked] = useState(false);
  const [attachmentsDisabledReason, setAttachmentsDisabledReason] = useState("");
  const [toggleBusy, setToggleBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmState, setConfirmState] = useState(null);
  const [previewState, setPreviewState] = useState(null);
  const [previewLoadingId, setPreviewLoadingId] = useState(null);

  async function loadAttachments({ silent = false } = {}) {
    if (!silent) {
      setLoading(true);
    }

    try {
      const payload = await fetchJson("/api/admin/attachments");
      setAttachments(payload.attachments || []);
      setRetentionDays(payload.retentionDays || 30);
      setAttachmentsEnabled(payload.attachmentsEnabled !== false);
      setAttachmentsLocked(payload.attachmentsLocked === true);
      setAttachmentsDisabledReason(payload.attachmentsDisabledReason || "");
    } catch (requestError) {
      setError(reportError("attachments:load", requestError));
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    loadAttachments();
  }, []);

  async function toggleAttachmentsEnabled() {
    setToggleBusy(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/attachments/toggle", {
        method: "PATCH",
        body: JSON.stringify({ enabled: !attachmentsEnabled })
      });
      setAttachmentsEnabled(payload.enabled);
      setMessage(payload.message);
    } catch (requestError) {
      setError(reportError("attachments:toggle", requestError));
    } finally {
      setToggleBusy(false);
    }
  }

  async function keepAttachment(attachment) {
    setLoading(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson(`/api/admin/attachments/${attachment.id}/keep`, {
        method: "POST"
      });
      setMessage(payload.message);
      await loadAttachments({ silent: true });
    } catch (requestError) {
      setError(reportError("attachments:keep", requestError));
    } finally {
      setLoading(false);
    }
  }

  function requestDeleteAttachment(attachment) {
    setConfirmState({
      variant: "danger",
      title: "Supprimer cette pièce jointe ?",
      message: `« ${attachment.originalName} » sera supprimée définitivement, y compris de l'index de l'assistant.`,
      confirmLabel: "Supprimer",
      onConfirm: async () => {
        setConfirmState(null);
        setLoading(true);
        setError("");
        setMessage("");

        try {
          const payload = await fetchJson(`/api/admin/attachments/${attachment.id}`, {
            method: "DELETE"
          });
          setMessage(payload.message);
          setPreviewState((current) =>
            current?.attachmentId === attachment.id ? null : current
          );
          await loadAttachments({ silent: true });
        } catch (requestError) {
          setError(reportError("attachments:delete", requestError));
        } finally {
          setLoading(false);
        }
      }
    });
  }

  async function togglePreview(attachment) {
    if (previewState?.attachmentId === attachment.id) {
      setPreviewState(null);
      return;
    }

    setPreviewLoadingId(attachment.id);
    setError("");

    try {
      const payload = await fetchJson(`/api/admin/attachments/${attachment.id}`);
      setPreviewState({
        attachmentId: attachment.id,
        content: payload.content || "Contenu illisible ou vide."
      });
    } catch (requestError) {
      setError(reportError("attachments:preview", requestError));
    } finally {
      setPreviewLoadingId(null);
    }
  }

  const pendingCount = attachments.filter((entry) => entry.status === "pending").length;

  return (
    <div className="space-y-6">
      <section className="subpanel p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">
              Pièces jointes des utilisateurs
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              Les fichiers texte déposés dans le chat sont indexés pour aider l'assistant à
              répondre. Marquez chaque pièce jointe comme pertinente pour la conserver, ou
              supprimez-la. Sans action de votre part, une pièce jointe non triée est supprimée
              automatiquement après {retentionDays} jours.
            </p>
          </div>
          <button
            className="ghost-button shrink-0"
            type="button"
            disabled={loading}
            onClick={() => loadAttachments()}
          >
            Actualiser
          </button>
        </div>

        {attachmentsLocked && (
          <div className="mt-4">
            <Alert tone="warning">
              {attachmentsDisabledReason ||
                "L'ajout de pièces jointes est temporairement suspendu par cette version de l'application."}{" "}
              Ce verrou est défini au niveau de la version : il ne peut pas être levé depuis
              l'administration et sera retiré par une prochaine mise à jour.
            </Alert>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl bg-slate-50 p-4 dark:bg-slate-800/50">
          <StatusBadge tone={attachmentsLocked ? "danger" : attachmentsEnabled ? "success" : "neutral"}>
            {attachmentsLocked
              ? "Pièces jointes suspendues (verrou de version)"
              : attachmentsEnabled
                ? "Pièces jointes activées"
                : "Pièces jointes désactivées"}
          </StatusBadge>
          <p className="flex-1 text-sm text-slate-500 dark:text-slate-400">
            {attachmentsLocked
              ? "Le bouton est masqué dans le chat et tout envoi est refusé côté serveur (HTTP 503) tant que le verrou est actif."
              : attachmentsEnabled
                ? "Les utilisateurs peuvent joindre un fichier à leurs questions dans le chat."
                : "Le bouton pour joindre un fichier est masqué dans le chat, et tout envoi est refusé côté serveur."}
          </p>
          <button
            className="ghost-button shrink-0"
            type="button"
            disabled={toggleBusy || attachmentsLocked}
            title={
              attachmentsLocked
                ? "Indisponible : fonctionnalité suspendue par la version en cours."
                : undefined
            }
            onClick={toggleAttachmentsEnabled}
          >
            {attachmentsEnabled ? "Désactiver" : "Activer"}
          </button>
        </div>

        {pendingCount > 0 && (
          <p className="mt-4 text-sm font-medium text-amber-700 dark:text-amber-400" role="status">
            {pendingCount} pièce{pendingCount > 1 ? "s" : ""} jointe{pendingCount > 1 ? "s" : ""} en
            attente de tri.
          </p>
        )}

        {message && (
          <div className="mt-4">
            <Alert tone="success">{message}</Alert>
          </div>
        )}
        {error && (
          <div className="mt-4">
            <Alert tone="error">{error}</Alert>
          </div>
        )}
      </section>

      <section className="subpanel p-6">
        {attachments.length === 0 ? (
          <EmptyState
            title="Aucune pièce jointe déposée."
            description="Les fichiers texte envoyés par les utilisateurs depuis le chat apparaîtront ici."
          />
        ) : (
          <div className="space-y-4">
            {attachments.map((attachment) => (
              <article
                key={attachment.id}
                className="rounded-[22px] border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-700 dark:bg-slate-800/50"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="break-all text-base font-semibold text-slate-900 dark:text-slate-100">
                        {attachment.originalName}
                      </h3>
                      <StatusBadge tone={attachmentStatusTone(attachment)}>
                        {attachmentStatusLabel(attachment)}
                      </StatusBadge>
                      {attachment.status === "pending" && attachment.daysRemaining !== null && (
                        <StatusBadge tone={attachment.daysRemaining <= 5 ? "danger" : "neutral"}>
                          {attachment.daysRemaining <= 0
                            ? "Suppression imminente"
                            : `Suppression dans ${attachment.daysRemaining} j`}
                        </StatusBadge>
                      )}
                    </div>

                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                      {formatBytes(attachment.size)} · déposée le {formatDateTime(attachment.createdAt)}
                      {attachment.chunkCount > 0
                        ? ` · ${attachment.chunkCount} extrait(s) indexé(s)`
                        : ""}
                    </p>

                    {attachment.questionContext && (
                      <p className="mt-2 text-sm italic leading-6 text-slate-600 dark:text-slate-300">
                        Question posée : « {attachment.questionContext} »
                      </p>
                    )}

                    {attachment.lastError && (
                      <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">
                        {attachment.lastError}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2 lg:shrink-0">
                    <button
                      className="ghost-button"
                      type="button"
                      disabled={previewLoadingId === attachment.id}
                      onClick={() => togglePreview(attachment)}
                      aria-expanded={previewState?.attachmentId === attachment.id}
                    >
                      {previewLoadingId === attachment.id
                        ? "Chargement..."
                        : previewState?.attachmentId === attachment.id
                          ? "Masquer le contenu"
                          : "Voir le contenu"}
                    </button>
                    {attachment.status !== "kept" && (
                      <button
                        className="soft-button"
                        type="button"
                        disabled={loading}
                        onClick={() => keepAttachment(attachment)}
                      >
                        Pertinente, conserver
                      </button>
                    )}
                    <button
                      className="ghost-button border-rose-200 text-rose-700 hover:border-rose-300 hover:bg-rose-50 dark:border-rose-900/60 dark:text-rose-400 dark:hover:bg-rose-950/40"
                      type="button"
                      disabled={loading}
                      onClick={() => requestDeleteAttachment(attachment)}
                    >
                      Non pertinente, supprimer
                    </button>
                  </div>
                </div>

                {previewState?.attachmentId === attachment.id && (
                  <pre className="mt-4 max-h-72 overflow-auto whitespace-pre-wrap rounded-[16px] border border-slate-200 bg-white p-4 text-[13px] leading-6 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                    {previewState.content}
                  </pre>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {confirmState && (
        <ConfirmDialog
          open
          variant={confirmState.variant}
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          onCancel={() => setConfirmState(null)}
          onConfirm={confirmState.onConfirm}
        />
      )}
    </div>
  );
}
