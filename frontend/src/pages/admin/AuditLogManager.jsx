import { useEffect, useState } from "react";
import { fetchJson, formatDateTime } from "../../lib/api";
import { reportError } from "../../lib/errors";
import Alert from "../../components/ui/Alert";
import EmptyState from "../../components/ui/EmptyState";
import StatusBadge from "../../components/ui/StatusBadge";

const actionLabels = {
  "document.delete": "Suppression de document",
  "document.move": "Déplacement de document",
  "document.visibility": "Changement de visibilité",
  "document.bulk-delete": "Suppression groupée de documents",
  "document.bulk-move": "Déplacement groupé de documents",
  "document.bulk-reindex": "Réindexation groupée",
  "document.bulk-visibility": "Changement de visibilité groupé",
  "folder.delete": "Suppression de dossier",
  "model.activate": "Activation de modèle",
  "model.delete": "Suppression de modèle",
  "system.purge-all-data": "Suppression de toutes les données",
  "system.purge-conversations-feedback": "Suppression des conversations et feedbacks",
  "auth.teacher-password-change": "Changement du mot de passe enseignant",
  "deployment.publish": "Publication d'une version",
  "update.apply": "Installation d'une mise à jour",
  "update.rollback": "Retour arrière (rollback)"
};

const roleLabels = {
  owner: "Administration",
  teacher: "Enseignant",
  app: "Mot de passe rotatif"
};

function roleTone(role) {
  if (role === "owner") {
    return "info";
  }
  if (role === "teacher") {
    return "success";
  }
  return "neutral";
}

export default function AuditLogManager() {
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pageSize = 50;

  async function loadEntries(targetPage = page) {
    setLoading(true);
    setError("");

    try {
      const payload = await fetchJson(`/api/admin/audit-log?page=${targetPage}&pageSize=${pageSize}`);
      setEntries(payload.items || []);
      setTotal(payload.total || 0);
      setPage(payload.page || targetPage);
    } catch (requestError) {
      setError(reportError("audit-log", requestError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadEntries(1);
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6">
      <section className="panel px-6 py-6 sm:px-8">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500 dark:text-slate-400">
          Administration
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-slate-50">
          Journal d'audit
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
          Trace des actions sensibles effectuées dans l'administration : qui a fait quoi, et
          quand. Ce journal n'est jamais effacé par les suppressions de données.
        </p>
      </section>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <section className="subpanel p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
            {total} action(s) enregistrée(s)
          </h3>
          <button className="ghost-button" onClick={() => loadEntries(page)} disabled={loading}>
            {loading ? "Chargement..." : "Actualiser"}
          </button>
        </div>

        <div className="mt-4 space-y-2">
          {!loading && entries.length === 0 ? (
            <EmptyState title="Aucune action enregistrée pour le moment." />
          ) : (
            entries.map((entry) => (
              <article
                key={entry.id}
                className="flex flex-col gap-2 rounded-[18px] border border-slate-200 bg-slate-50/60 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-700 dark:bg-slate-800/50"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {actionLabels[entry.action] || entry.action}
                    </span>
                    <StatusBadge tone={roleTone(entry.actorRole)}>
                      {roleLabels[entry.actorRole] || entry.actorRole}
                    </StatusBadge>
                  </div>
                  {entry.targetId ? (
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Cible : {entry.targetType ? `${entry.targetType} ` : ""}
                      {entry.targetId}
                    </p>
                  ) : null}
                </div>
                <p className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                  {formatDateTime(entry.createdAt)}
                </p>
              </article>
            ))
          )}
        </div>

        {totalPages > 1 ? (
          <div className="mt-5 flex items-center justify-center gap-3">
            <button
              className="ghost-button px-3 py-1.5 text-xs"
              disabled={page <= 1 || loading}
              onClick={() => loadEntries(page - 1)}
            >
              Précédent
            </button>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Page {page} / {totalPages}
            </span>
            <button
              className="ghost-button px-3 py-1.5 text-xs"
              disabled={page >= totalPages || loading}
              onClick={() => loadEntries(page + 1)}
            >
              Suivant
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
