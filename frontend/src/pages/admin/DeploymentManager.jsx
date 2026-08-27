import { useEffect, useState } from "react";
import { fetchJson, formatDateTime } from "../../lib/api";
import { reportError } from "../../lib/errors";
import Alert from "../../components/ui/Alert";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import StatusBadge from "../../components/ui/StatusBadge";

function buildDefaultNotes(version) {
  return `Version ${version} — publiée le ${formatDateTime(new Date())}.`;
}

// Persiste le brouillon de note (auto-genere ou modifie a la main) dans le
// navigateur : un rechargement de la page (ou une fermeture d'onglet avant
// publication) ne doit ni le perdre, ni regenerer un nouvel horodatage.
const NOTES_DRAFT_STORAGE_KEY = "fablab-admin-deployment-notes-draft";

function loadNotesDraft(version) {
  try {
    const raw = window.localStorage.getItem(NOTES_DRAFT_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (parsed?.version !== version || typeof parsed?.notes !== "string") {
      return null;
    }

    return parsed.notes;
  } catch {
    return null;
  }
}

function saveNotesDraft(version, notes) {
  try {
    window.localStorage.setItem(NOTES_DRAFT_STORAGE_KEY, JSON.stringify({ version, notes }));
  } catch {
    // Stockage indisponible (navigation privee, quota...) : la note reste utilisable,
    // simplement non persistante pour cette session.
  }
}

function clearNotesDraft() {
  try {
    window.localStorage.removeItem(NOTES_DRAFT_STORAGE_KEY);
  } catch {
    // Rien a faire si le stockage est indisponible.
  }
}

function statusLabel(status) {
  switch (status) {
    case "building":
      return "Construction de l'archive";
    case "hashing":
      return "Calcul de l'empreinte";
    case "uploading":
      return "Envoi vers le serveur";
    case "verifying":
      return "Vérification publique";
    case "completed":
      return "Publiée";
    case "completed-unverified":
      return "Envoyée (vérification à confirmer)";
    case "error":
      return "Erreur";
    default:
      return "Prêt";
  }
}

export default function DeploymentManager() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  // Tant que l'admin n'a pas modifie la note a la main, elle reste generee/restauree
  // automatiquement (voir l'effet plus bas) plutot que de rester figee a vide.
  const [notesEdited, setNotesEdited] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  const [ftpConfig, setFtpConfig] = useState(null);
  const [ftpForm, setFtpForm] = useState({
    host: "",
    remoteDir: "",
    publicBaseUrl: "",
    user: "",
    password: ""
  });
  const [ftpSaving, setFtpSaving] = useState(false);
  const [ftpMessage, setFtpMessage] = useState("");
  const [ftpError, setFtpError] = useState("");

  async function loadFtpConfig() {
    try {
      const payload = await fetchJson("/api/admin/deployment/ftp-config");
      setFtpConfig(payload);
      setFtpForm((current) => ({
        ...current,
        host: payload.host || "",
        remoteDir: payload.remoteDir || "",
        publicBaseUrl: payload.publicBaseUrl || ""
      }));
    } catch (requestError) {
      reportError("deployment:ftp-config-load", requestError);
    }
  }

  async function submitFtpConfig(event) {
    event.preventDefault();
    setFtpMessage("");
    setFtpError("");
    setFtpSaving(true);

    try {
      const payload = await fetchJson("/api/admin/deployment/ftp-config", {
        method: "PUT",
        body: JSON.stringify(ftpForm)
      });
      setFtpMessage(payload.message);
      setFtpForm((current) => ({ ...current, user: "", password: "" }));
      await loadFtpConfig();
    } catch (requestError) {
      setFtpError(reportError("deployment:ftp-config-save", requestError));
    } finally {
      setFtpSaving(false);
    }
  }

  const busy = Boolean(status?.state?.busy);
  const logs = status?.state?.logs || [];

  async function loadStatus() {
    try {
      const payload = await fetchJson("/api/admin/deployment/status");
      setStatus(payload);
      setVersion((current) => current || payload.suggestedNextVersion || "");
      setError("");
    } catch (requestError) {
      setError(reportError("deployment:status", requestError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStatus();
    loadFtpConfig();
  }, []);

  useEffect(() => {
    if (!busy) {
      return undefined;
    }

    const interval = window.setInterval(loadStatus, 2000);
    return () => window.clearInterval(interval);
  }, [busy]);

  useEffect(() => {
    if (status?.state?.status === "completed" || status?.state?.status === "completed-unverified") {
      clearNotesDraft();
      setVersion(status.suggestedNextVersion || "");
      setNotesEdited(false);
    }
  }, [status?.state?.status, status?.state?.completedAt]);

  // Note de version pre-remplie par defaut (date/heure + version), persistee dans
  // le navigateur pour ne pas se reinitialiser au moindre rechargement de page et
  // ne jamais bloquer la publication faute d'avoir ecrit un texte a la main.
  useEffect(() => {
    if (!version || notesEdited) {
      return;
    }

    const draft = loadNotesDraft(version);
    if (draft !== null) {
      setNotes(draft);
      setNotesEdited(true);
      return;
    }

    const defaultNotes = buildDefaultNotes(version);
    setNotes(defaultNotes);
    saveNotesDraft(version, defaultNotes);
  }, [version, notesEdited]);

  async function publish() {
    setConfirmOpen(false);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/deployment/publish", {
        method: "POST",
        body: JSON.stringify({ version: version.trim(), notes: notes.trim() })
      });
      setMessage(payload.message);
      setStatus((current) => ({ ...(current || {}), state: payload.state }));
    } catch (requestError) {
      setError(reportError("deployment:publish", requestError, "La publication n'a pas pu démarrer."));
    }
  }

  function requestPublish(event) {
    event.preventDefault();
    if (!version.trim() || !notes.trim() || busy) {
      return;
    }
    setConfirmOpen(true);
  }

  if (loading) {
    return (
      <section className="subpanel px-6 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
        Chargement...
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <ConfirmDialog
        open={confirmOpen}
        variant="normal"
        title={`Publier la version ${version} ?`}
        message="Le projet actuel sera archivé, vérifié puis envoyé publiquement sur le serveur de mise à jour. Les autres instances pourront ensuite installer cette version."
        confirmLabel="Publier"
        onConfirm={publish}
        onCancel={() => setConfirmOpen(false)}
      />

      <section className="panel px-6 py-6 sm:px-8">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500 dark:text-slate-400">
          Administration
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-slate-50">
          Export et déploiement
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
          Publie le projet actuellement en cours de modification comme nouvelle version, accessible
          par toutes les instances via le système de mise à jour.
        </p>
      </section>

      {!status?.configured ? (
        <Alert tone="warning">
          Configuration FTP de déploiement incomplète. Renseignez DEPLOY_FTP_HOST, DEPLOY_FTP_USER,
          DEPLOY_FTP_PASSWORD et DEPLOY_FTP_REMOTE_DIR dans le fichier .env du serveur.
        </Alert>
      ) : null}
      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <section className="subpanel p-6">
        <div className="grid gap-3 md:grid-cols-2">
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
              État
            </p>
            <div className="mt-3 flex items-center gap-2">
              <StatusBadge tone={status?.state?.status === "error" ? "danger" : busy ? "info" : "neutral"}>
                {statusLabel(status?.state?.status)}
              </StatusBadge>
            </div>
            {status?.state?.completedAt ? (
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                Dernière action {formatDateTime(status.state.completedAt)}
              </p>
            ) : null}
          </article>
        </div>

        <form className="mt-6 space-y-4" onSubmit={requestPublish}>
          <div>
            <label className="mb-2 block text-sm font-semibold text-slate-700 dark:text-slate-200">
              Numéro de version
            </label>
            <input
              className="input max-w-xs"
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              placeholder={status?.suggestedNextVersion || "1.014"}
              disabled={busy}
            />
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Pré-rempli automatiquement ({status?.suggestedNextVersion}), modifiable si besoin.
            </p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-slate-700 dark:text-slate-200">
              Note de version
            </label>
            <textarea
              className="input min-h-[120px]"
              value={notes}
              onChange={(event) => {
                setNotesEdited(true);
                setNotes(event.target.value);
                saveNotesDraft(version, event.target.value);
              }}
              placeholder="Ce qui a changé dans cette version..."
              disabled={busy}
            />
          </div>

          <button
            className="soft-button"
            disabled={busy || !version.trim() || !notes.trim() || !status?.configured}
          >
            {busy ? "Publication en cours..." : "Publier cette version"}
          </button>
        </form>

        {busy ? (
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between text-sm text-slate-600 dark:text-slate-300">
              <span>{status?.state?.message}</span>
              <span>{status?.state?.progress || 0}%</span>
            </div>
            <div className="h-3 rounded-full bg-slate-200 dark:bg-slate-700">
              <div
                className="h-3 rounded-full bg-brand transition-all duration-300"
                style={{ width: `${status?.state?.progress || 0}%` }}
              />
            </div>
          </div>
        ) : null}

        {status?.state?.status === "completed" && status?.publicUrl ? (
          <Alert tone="success" className="mt-4">
            Publiée : <span className="break-all">{status.publicUrl}</span>
          </Alert>
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

      <section className="subpanel p-6">
        <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
          Identifiants FTP de déploiement
        </h3>
        <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
          Stockés chiffrés en base plutôt qu'en clair dans la configuration serveur. Laisser
          utilisateur/mot de passe vide pour conserver la valeur déjà enregistrée.
        </p>

        {ftpConfig && !ftpConfig.encryptionAvailable ? (
          <Alert tone="warning" className="mt-4">
            CONFIG_ENCRYPTION_KEY n'est pas configurée sur le serveur : impossible de stocker des
            identifiants chiffrés tant qu'elle n'est pas définie.
          </Alert>
        ) : null}

        <form className="mt-4 grid max-w-xl gap-4" onSubmit={submitFtpConfig}>
          <div>
            <label className="mb-2 block text-sm font-semibold text-slate-700 dark:text-slate-200">Hôte</label>
            <input
              type="text"
              className="input"
              value={ftpForm.host}
              onChange={(event) => setFtpForm((current) => ({ ...current, host: event.target.value }))}
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-semibold text-slate-700 dark:text-slate-200">
              Utilisateur {ftpConfig?.hasUser ? "(déjà enregistré)" : ""}
            </label>
            <input
              type="text"
              className="input"
              value={ftpForm.user}
              onChange={(event) => setFtpForm((current) => ({ ...current, user: event.target.value }))}
              autoComplete="off"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-semibold text-slate-700 dark:text-slate-200">
              Mot de passe {ftpConfig?.hasPassword ? "(déjà enregistré)" : ""}
            </label>
            <input
              type="password"
              className="input"
              value={ftpForm.password}
              onChange={(event) => setFtpForm((current) => ({ ...current, password: event.target.value }))}
              autoComplete="new-password"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-semibold text-slate-700 dark:text-slate-200">
              Dossier distant
            </label>
            <input
              type="text"
              className="input"
              value={ftpForm.remoteDir}
              onChange={(event) => setFtpForm((current) => ({ ...current, remoteDir: event.target.value }))}
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-semibold text-slate-700 dark:text-slate-200">
              URL publique de vérification
            </label>
            <input
              type="url"
              className="input"
              value={ftpForm.publicBaseUrl}
              onChange={(event) => setFtpForm((current) => ({ ...current, publicBaseUrl: event.target.value }))}
            />
          </div>

          {ftpMessage ? <Alert tone="success">{ftpMessage}</Alert> : null}
          {ftpError ? <Alert tone="error">{ftpError}</Alert> : null}

          <button className="soft-button" disabled={ftpSaving}>
            {ftpSaving ? "Enregistrement..." : "Enregistrer la configuration FTP"}
          </button>
        </form>
      </section>
    </div>
  );
}
