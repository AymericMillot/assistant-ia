import { useEffect, useMemo, useState } from "react";
import { fetchJson, formatBytes, formatDateTime } from "../lib/api";
import { reportError } from "../lib/errors";
import UpdateProgressOverlay from "./UpdateProgressOverlay";
import Alert from "./ui/Alert";
import ConfirmDialog from "./ui/ConfirmDialog";
import StatusBadge from "./ui/StatusBadge";

function normalizeVersionParts(version) {
  return String(version || "0")
    .trim()
    .split(".")
    .map((part) => Number(part) || 0);
}

function compareVersions(left, right) {
  const a = normalizeVersionParts(left);
  const b = normalizeVersionParts(right);
  const maxLength = Math.max(a.length, b.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = a[index] || 0;
    const rightValue = b[index] || 0;
    if (leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1;
    }
  }

  return 0;
}

function statusLabel(status) {
  switch (status) {
    case "unavailable":
      return "Indisponible";
    case "checking":
      return "Vérification";
    case "downloading":
      return "Téléchargement";
    case "extracting":
      return "Préparation";
    case "copying":
      return "Application";
    case "rollback":
      return "Rollback";
    case "restarting":
      return "Redémarrage";
    case "completed":
      return "Terminée";
    case "error":
      return "Erreur";
    default:
      return "Disponible";
  }
}

export default function UpdateManager() {
  const [status, setStatus] = useState(null);
  const [releases, setReleases] = useState([]);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [confirmState, setConfirmState] = useState(null);
  const [showLogs, setShowLogs] = useState(false);

  const busy = Boolean(status?.state?.busy);
  const backups = status?.backups || [];
  const logs = status?.state?.logs || [];

  // `releases` vient d'un endpoint non mis en cache côté updater, contrairement à
  // `status.latestVersion` (cache de 60s) : on s'appuie sur lui quand il est plus récent
  // pour éviter d'afficher/installer une version périmée.
  const latestVersion = useMemo(() => {
    const fromReleases = releases[0]?.version || "";
    const fromStatus = status?.latestVersion || "";
    return compareVersions(fromReleases, fromStatus) > 0 ? fromReleases : fromStatus;
  }, [releases, status?.latestVersion]);

  const updateAvailable =
    Boolean(status?.updateAvailable) ||
    (Boolean(latestVersion) &&
      Boolean(status?.currentVersion) &&
      compareVersions(latestVersion, status.currentVersion) > 0);

  const buttonClassName = useMemo(() => {
    if (busy) {
      return "soft-button";
    }

    if (updateAvailable) {
      return "update-attention-button";
    }

    return "ghost-button";
  }, [busy, updateAvailable]);

  async function loadStatus() {
    setChecking(true);
    try {
      const [statusPayload, releasesPayload] = await Promise.all([
        fetchJson("/api/admin/update/status"),
        fetchJson("/api/releases").catch(() => null)
      ]);
      setStatus(statusPayload);
      if (releasesPayload) {
        setReleases(releasesPayload.releases || []);
      }
      setError("");
    } catch (requestError) {
      setError(reportError("update:status", requestError));
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    loadStatus();
  }, []);

  useEffect(() => {
    if (status?.state?.status !== "unavailable") {
      return undefined;
    }

    const retryInterval = window.setInterval(() => {
      loadStatus();
    }, 3000);

    return () => window.clearInterval(retryInterval);
  }, [status?.state?.status]);

  // Une mise a jour peut etre declenchee ailleurs que depuis cette page
  // (./update.sh en terminal, un autre onglet admin...) : sans ce sondage de
  // fond, l'affichage resterait fige sur l'ancienne version tant que la page
  // n'est pas rechargee manuellement. On rafraichit periodiquement, et
  // immediatement des que l'onglet redevient visible/actif.
  useEffect(() => {
    const backgroundInterval = window.setInterval(() => {
      if (!overlayVisible) {
        loadStatus();
      }
    }, 20000);

    function handleVisible() {
      if (document.visibilityState === "visible" && !overlayVisible) {
        loadStatus();
      }
    }

    window.addEventListener("focus", handleVisible);
    document.addEventListener("visibilitychange", handleVisible);

    return () => {
      window.clearInterval(backgroundInterval);
      window.removeEventListener("focus", handleVisible);
      document.removeEventListener("visibilitychange", handleVisible);
    };
  }, [overlayVisible]);

  // Le popup de progression ne doit jamais rester bloque : on se fie
  // uniquement a l'etat "termine"/"erreur" renvoye par l'updater (pas a une
  // comparaison de numero de version, plus fragile), et un bouton de
  // fermeture manuelle reste disponible a tout moment dans l'overlay - le
  // fermer n'interrompt jamais la mise a jour, qui tourne cote serveur.
  useEffect(() => {
    if (!overlayVisible) {
      return undefined;
    }

    let active = true;
    let reloadTimer = null;

    const interval = window.setInterval(async () => {
      try {
        const statusPayload = await fetchJson("/api/admin/update/status");
        if (!active) {
          return;
        }

        setStatus(statusPayload);

        const state = statusPayload?.state || {};
        if (!state.busy && state.status === "completed" && !reloadTimer) {
          reloadTimer = window.setTimeout(() => {
            if (active) {
              window.location.reload();
            }
          }, 1500);
        }
      } catch {
        // Coupure reseau ponctuelle pendant le redemarrage des services :
        // sans consequence, le prochain sondage reessaiera.
      }
    }, 2500);

    return () => {
      active = false;
      window.clearInterval(interval);
      if (reloadTimer) {
        window.clearTimeout(reloadTimer);
      }
    };
  }, [overlayVisible]);

  function dismissOverlay() {
    setOverlayVisible(false);
  }

  function requestApplyUpdate(explicitVersion = "") {
    // Version affichée uniquement : quand aucune version explicite n'est choisie
    // (bouton "Installer la dernière version"), on n'envoie rien au backend et on
    // le laisse résoudre lui-même la version la plus récente, sans cache.
    const displayVersion = String(explicitVersion || latestVersion || "").trim();

    setConfirmState({
      variant: "normal",
      title: `Installer la version ${displayVersion || "disponible"} ?`,
      message:
        "L'ancien code sera intégralement remplacé par la nouvelle version, puis les services redémarreront. Les documents, réglages et données sont conservés. Une sauvegarde de rollback est créée automatiquement avant l'installation.",
      confirmLabel: "Installer",
      onConfirm: async () => {
        setConfirmState(null);
        await applyUpdate(String(explicitVersion || "").trim());
      }
    });
  }

  async function applyUpdate(targetVersion) {
    try {
      const payload = await fetchJson("/api/admin/update/apply", {
        method: "POST",
        body: JSON.stringify(targetVersion ? { targetVersion } : {})
      });
      setOverlayVisible(true);
      setStatus((current) => ({
        ...(current || {}),
        state: payload.state
      }));
      setError("");
    } catch (requestError) {
      setError(reportError("update:apply", requestError));
    }
  }

  function requestRollback(backup) {
    setConfirmState({
      variant: "danger",
      title: `Revenir à la version ${backup.version} ?`,
      message: `L'application sera restaurée dans l'état sauvegardé le ${formatDateTime(backup.createdAt)}. Les documents, réglages et données actuels sont conservés.`,
      consequences: ["Le code applicatif actuel sera remplacé par celui de la sauvegarde."],
      confirmLabel: "Restaurer",
      onConfirm: async () => {
        setConfirmState(null);
        await rollback(backup);
      }
    });
  }

  async function rollback(backup) {
    try {
      const payload = await fetchJson("/api/admin/update/rollback", {
        method: "POST",
        body: JSON.stringify({ backupId: backup.id })
      });
      setOverlayVisible(true);
      setStatus((current) => ({
        ...(current || {}),
        state: payload.state
      }));
      setError("");
    } catch (requestError) {
      setError(reportError("update:rollback", requestError));
    }
  }

  return (
    <>
      <ConfirmDialog
        open={Boolean(confirmState)}
        variant={confirmState?.variant}
        title={confirmState?.title}
        message={confirmState?.message}
        consequences={confirmState?.consequences || []}
        confirmLabel={confirmState?.confirmLabel}
        onConfirm={confirmState?.onConfirm}
        onCancel={() => setConfirmState(null)}
      />

      <section className="subpanel p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Mise à jour</h3>
              {updateAvailable && <StatusBadge tone="info">Nouvelle version</StatusBadge>}
            </div>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              Les versions sont lues sur le serveur de mise à jour officiel. Chaque installation
              vérifie l&apos;intégrité du package (SHA256), crée une sauvegarde de rollback et
              remplace intégralement le code applicatif, sans toucher aux données.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <button className="ghost-button" onClick={loadStatus} disabled={checking || busy}>
              {checking ? "Vérification..." : "Vérifier"}
            </button>
            <button
              className={buttonClassName}
              onClick={() => requestApplyUpdate()}
              disabled={busy || !updateAvailable}
            >
              {busy ? "Mise à jour..." : updateAvailable ? "Installer la dernière version" : "À jour"}
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <article className="rounded-[24px] border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
              Version actuelle
            </p>
            <p className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-slate-50">
              {status?.currentVersion || "1.000"}
            </p>
          </article>
          <article className="rounded-[24px] border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
              Dernière version
            </p>
            <p className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-slate-50">
              {latestVersion || status?.currentVersion || "1.000"}
            </p>
          </article>
          <article className="rounded-[24px] border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
              État
            </p>
            <p className="mt-3 text-base font-semibold text-slate-950 dark:text-slate-50">
              {statusLabel(status?.state?.status)}
            </p>
            {status?.state?.completedAt && (
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                Dernière action {formatDateTime(status.state.completedAt)}
              </p>
            )}
          </article>
        </div>

        {status?.release?.notes && (
          <div className="mt-4 rounded-[24px] border border-slate-200 bg-[#f7f8fa] p-4 text-sm leading-6 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {status.release.notes}
          </div>
        )}

        {error ? <Alert tone="error" className="mt-4">{error}</Alert> : null}
        {!error && status?.state?.status === "unavailable" && (
          <Alert tone="warning" className="mt-4">
            {status?.state?.message || "Le service de mise à jour est temporairement indisponible."}
          </Alert>
        )}
        {status?.state?.status === "error" && status?.state?.error ? (
          <Alert tone="error" className="mt-4">
            La dernière opération a échoué : {status.state.error}
            {backups.length > 0
              ? " Vous pouvez restaurer une sauvegarde ci-dessous si nécessaire."
              : ""}
          </Alert>
        ) : null}

        {releases.length > 1 ? (
          <div className="mt-6">
            <h4 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
              Versions disponibles sur le serveur
            </h4>
            <div className="mt-3 space-y-2">
              {releases.map((release) => {
                const isCurrent = release.version === status?.currentVersion;
                return (
                  <div
                    key={release.version}
                    className="flex flex-col gap-2 rounded-[20px] border border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-slate-700 dark:bg-slate-900"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        Version {release.version}
                      </span>
                      {isCurrent ? <StatusBadge tone="success">Installée</StatusBadge> : null}
                      {release.publishedAt ? (
                        <span className="text-xs text-slate-400 dark:text-slate-500">
                          {formatDateTime(release.publishedAt)}
                        </span>
                      ) : null}
                    </div>
                    {!isCurrent ? (
                      <button
                        className="ghost-button px-3 py-1.5 text-xs"
                        disabled={busy}
                        onClick={() => requestApplyUpdate(release.version)}
                      >
                        Installer cette version
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {backups.length > 0 ? (
          <div className="mt-6">
            <h4 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
              Sauvegardes de rollback
            </h4>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Créées automatiquement avant chaque mise à jour ({status?.retention || 3} conservées).
            </p>
            <div className="mt-3 space-y-2">
              {backups.map((backup) => (
                <div
                  key={backup.id}
                  className="flex flex-col gap-2 rounded-[20px] border border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-slate-700 dark:bg-slate-900"
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">
                      Version {backup.version}
                    </span>
                    <span className="text-xs text-slate-400 dark:text-slate-500">
                      {formatDateTime(backup.createdAt)} · {formatBytes(backup.size)}
                    </span>
                  </div>
                  <button
                    className="ghost-button px-3 py-1.5 text-xs"
                    disabled={busy}
                    onClick={() => requestRollback(backup)}
                  >
                    Restaurer
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {logs.length > 0 ? (
          <div className="mt-6">
            <button
              className="ghost-button px-3 py-1.5 text-xs"
              type="button"
              onClick={() => setShowLogs((current) => !current)}
            >
              {showLogs ? "Masquer le journal" : `Afficher le journal (${logs.length})`}
            </button>
            {showLogs ? (
              <pre className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-[20px] border border-slate-200 bg-slate-50 p-4 text-xs leading-5 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                {logs.join("\n")}
              </pre>
            ) : null}
          </div>
        ) : null}
      </section>

      <UpdateProgressOverlay visible={overlayVisible} status={status} onClose={dismissOverlay} />
    </>
  );
}
