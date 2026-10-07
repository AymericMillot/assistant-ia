import { useEffect, useRef, useState } from "react";
import { fetchJson, formatBytes, formatDateTime } from "../../lib/api";
import { reportError } from "../../lib/errors";
import Alert from "../../components/ui/Alert";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import EmptyState from "../../components/ui/EmptyState";
import StatusBadge from "../../components/ui/StatusBadge";

const triggerLabels = {
  manuel: "Manuelle",
  auto: "Automatique",
  "avant-restauration": "Avant restauration"
};

const restoreConsequences = [
  "Toutes les données actuelles (comptes, réglages, conversations, documents, skills) sont remplacées.",
  "Une sauvegarde de sécurité de l'état actuel est créée juste avant.",
  "Les documents sont ensuite réindexés : les réponses peuvent être incomplètes pendant quelques minutes.",
  "Vous devrez peut-être vous reconnecter."
];

export default function BackupManager() {
  const [overview, setOverview] = useState(null);
  const [schedule, setSchedule] = useState({ enabled: true, time: "03:00", retention: 7 });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [backupToRestore, setBackupToRestore] = useState(null);
  const [backupToDelete, setBackupToDelete] = useState(null);
  const [uploadFile, setUploadFile] = useState(null);
  const fileInputRef = useRef(null);

  function applyOverview(payload) {
    setOverview(payload);
    if (payload?.schedule) {
      setSchedule(payload.schedule);
    }
  }

  async function load() {
    try {
      applyOverview(await fetchJson("/api/admin/backups"));
    } catch (requestError) {
      setError(reportError("backups:load", requestError));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function run(action, context) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const payload = await action();
      if (payload?.backups) {
        applyOverview(payload);
      } else {
        await load();
      }
      setMessage(payload?.message || "");
    } catch (requestError) {
      setError(reportError(context, requestError));
    } finally {
      setBusy(false);
    }
  }

  function createBackup() {
    run(() => fetchJson("/api/admin/backups", { method: "POST", timeoutMs: 15 * 60 * 1000 }), "backups:create");
  }

  function saveSchedule(event) {
    event.preventDefault();
    run(
      () =>
        fetchJson("/api/admin/backups/schedule", {
          method: "PUT",
          body: JSON.stringify({ ...schedule, retention: Number(schedule.retention) })
        }),
      "backups:schedule"
    );
  }

  async function restoreUploaded() {
    const file = uploadFile;
    setUploadFile(null);
    await run(async () => {
      const formData = new FormData();
      formData.append("confirmation", "restaurer");
      formData.append("archive", file);
      const response = await fetch("/api/admin/backups/restore-upload", {
        method: "POST",
        credentials: "include",
        body: formData
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || "La restauration a échoué.");
      }
      return payload;
    }, "backups:restore-upload");
  }

  const backups = overview?.backups || [];

  return (
    <div className="space-y-6">
      <section className="panel px-6 py-6 sm:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500 dark:text-slate-400">
              Sauvegardes
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-slate-50">
              Sauvegarder et restaurer l&apos;assistant
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              Une sauvegarde contient la base (comptes, réglages, conversations, retours, skills), les documents,
              les pièces jointes et l&apos;identité visuelle. L&apos;index de recherche est reconstruit après une
              restauration. Téléchargez régulièrement une sauvegarde hors du serveur.
            </p>
          </div>
          <button className="soft-button" type="button" disabled={busy} onClick={createBackup}>
            {busy ? "Opération en cours…" : "Sauvegarder maintenant"}
          </button>
        </div>
      </section>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}
      <Alert tone="warning">
        Les secrets chiffrés (identifiants FTP de déploiement) ne se restaurent correctement que sur une instance
        utilisant la même clé <code>CONFIG_ENCRYPTION_KEY</code>.
      </Alert>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="subpanel p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Sauvegardes disponibles</h3>
            {overview?.disk ? (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Espace libre : {formatBytes(overview.disk.freeBytes)}
              </span>
            ) : null}
          </div>
          <div className="mt-4 space-y-2">
            {backups.length === 0 ? (
              <EmptyState title="Aucune sauvegarde pour l'instant." />
            ) : (
              backups.map((backup) => (
                <article
                  key={backup.name}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{formatDateTime(backup.createdAt)}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {formatBytes(backup.size)} · {backup.name}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={backup.trigger === "avant-restauration" ? "warning" : "neutral"} withDot={false}>
                      {triggerLabels[backup.trigger] || backup.trigger}
                    </StatusBadge>
                    <a
                      className="ghost-button px-3 py-1.5 text-[13px]"
                      href={`/api/admin/backups/${encodeURIComponent(backup.name)}/download`}
                    >
                      Télécharger
                    </a>
                    <button
                      className="ghost-button px-3 py-1.5 text-[13px]"
                      type="button"
                      disabled={busy}
                      onClick={() => setBackupToRestore(backup)}
                    >
                      Restaurer
                    </button>
                    <button
                      className="ghost-button px-3 py-1.5 text-[13px] text-rose-600 dark:text-rose-300"
                      type="button"
                      disabled={busy}
                      onClick={() => setBackupToDelete(backup)}
                    >
                      Supprimer
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </div>

        <div className="space-y-6">
          <form className="subpanel space-y-4 p-6" onSubmit={saveSchedule}>
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Sauvegarde automatique</h3>
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={schedule.enabled}
                onChange={(event) => setSchedule({ ...schedule, enabled: event.target.checked })}
              />
              Une sauvegarde par jour
            </label>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
              Heure
              <input
                type="time"
                className="input mt-2"
                value={schedule.time}
                onChange={(event) => setSchedule({ ...schedule, time: event.target.value })}
              />
            </label>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
              Nombre de sauvegardes conservées
              <input
                type="number"
                min={1}
                max={60}
                className="input mt-2"
                value={schedule.retention}
                onChange={(event) => setSchedule({ ...schedule, retention: event.target.value })}
              />
            </label>
            <button className="soft-button" type="submit" disabled={busy}>
              Enregistrer
            </button>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Dernière sauvegarde : {overview?.lastBackupAt ? formatDateTime(overview.lastBackupAt) : "jamais"}. Reportée
              si une conversation est en cours.
            </p>
          </form>

          <div className="subpanel space-y-3 p-6">
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Restaurer depuis un fichier</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Archive <code>.tar.gz</code> téléchargée depuis cet écran (ou depuis une autre installation).
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".gz,.tgz,application/gzip"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) {
                  setUploadFile(file);
                }
              }}
            />
            <button className="ghost-button" type="button" disabled={busy} onClick={() => fileInputRef.current?.click()}>
              Choisir une archive…
            </button>
          </div>
        </div>
      </section>

      <ConfirmDialog
        open={Boolean(backupToRestore) || Boolean(uploadFile)}
        variant="critical"
        requireText="restaurer"
        title="Restaurer cette sauvegarde ?"
        message={
          backupToRestore
            ? `Sauvegarde du ${formatDateTime(backupToRestore.createdAt)}.`
            : uploadFile
              ? `Archive « ${uploadFile.name} ».`
              : ""
        }
        consequences={restoreConsequences}
        confirmLabel="Restaurer"
        onCancel={() => {
          setBackupToRestore(null);
          setUploadFile(null);
        }}
        onConfirm={async () => {
          if (uploadFile) {
            await restoreUploaded();
            return;
          }
          const target = backupToRestore;
          setBackupToRestore(null);
          await run(
            () =>
              fetchJson(`/api/admin/backups/${encodeURIComponent(target.name)}/restore`, {
                method: "POST",
                body: JSON.stringify({ confirmation: "restaurer" }),
                timeoutMs: 15 * 60 * 1000
              }),
            "backups:restore"
          );
        }}
      />

      <ConfirmDialog
        open={Boolean(backupToDelete)}
        variant="danger"
        title="Supprimer cette sauvegarde ?"
        message={backupToDelete ? `Sauvegarde du ${formatDateTime(backupToDelete.createdAt)}.` : ""}
        confirmLabel="Supprimer"
        onCancel={() => setBackupToDelete(null)}
        onConfirm={async () => {
          const target = backupToDelete;
          setBackupToDelete(null);
          await run(
            () => fetchJson(`/api/admin/backups/${encodeURIComponent(target.name)}`, { method: "DELETE" }),
            "backups:delete"
          );
        }}
      />
    </div>
  );
}
