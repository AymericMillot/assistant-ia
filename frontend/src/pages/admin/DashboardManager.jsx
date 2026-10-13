import { useEffect, useState } from "react";
import { fetchJson, formatBytes, formatDateTime } from "../../lib/api";
import { reportError } from "../../lib/errors";
import Alert from "../../components/ui/Alert";
import StatusBadge from "../../components/ui/StatusBadge";

function StatTile({ label, value, hint, tone = "neutral", onClick }) {
  const toneClasses = {
    neutral: "",
    warning: "border-amber-200 dark:border-amber-900/60",
    danger: "border-rose-200 dark:border-rose-900/60",
    success: "border-emerald-200 dark:border-emerald-900/60"
  };
  const Element = onClick ? "button" : "article";

  return (
    <Element
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`rounded-[20px] border border-slate-200 bg-white p-4 text-left dark:border-slate-700 dark:bg-slate-900 ${
        toneClasses[tone] || ""
      } ${onClick ? "transition hover:border-slate-300 hover:shadow-soft dark:hover:border-slate-600" : ""}`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-950 dark:text-slate-50">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p> : null}
    </Element>
  );
}

function ActivityBars({ perDay }) {
  // 14 derniers jours, y compris les jours sans question.
  const days = [];
  const counts = new Map(perDay.map((entry) => [entry.day, entry.count]));
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    days.push({ key, label: date.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" }), count: counts.get(key) || 0 });
  }
  const max = Math.max(1, ...days.map((day) => day.count));

  return (
    <div>
      <div className="flex h-32 items-end gap-1.5" role="img" aria-label="Questions posées sur les 14 derniers jours">
        {days.map((day) => (
          <div key={day.key} className="group relative flex h-full flex-1 flex-col justify-end">
            <div
              className="rounded-t-md bg-slate-800 transition group-hover:bg-sky-600 dark:bg-slate-300 dark:group-hover:bg-sky-400"
              style={{ height: `${Math.max(day.count > 0 ? 4 : 1, (day.count / max) * 100)}%` }}
            />
            <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-1.5 py-0.5 text-[11px] text-white opacity-0 group-hover:opacity-100">
              {day.count}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-1.5 text-[10px] text-slate-400">
        {days.map((day, index) => (
          <span key={day.key} className="flex-1 text-center">
            {index % 2 === 0 ? day.label : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function DashboardManager({ onNavigate, updateAvailable, availableTabs = new Set() }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      setData(await fetchJson("/api/admin/dashboard"));
      setError("");
    } catch (requestError) {
      setError(reportError("dashboard", requestError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const interval = window.setInterval(load, 60000);
    return () => window.clearInterval(interval);
  }, []);

  if (loading && !data) {
    return (
      <section className="subpanel px-6 py-8 text-center text-sm text-slate-500 dark:text-slate-400">Chargement...</section>
    );
  }

  const activity = data?.activity || {};
  const ratings = activity.ratingsWeek || { up: 0, down: 0 };
  const totalRatings = ratings.up + ratings.down;
  const satisfaction = totalRatings > 0 ? Math.round((ratings.up / totalRatings) * 100) : null;
  const documents = data?.documents || {};
  const disk = data?.disk;
  const diskFreeRatio = disk?.totalBytes ? disk.freeBytes / disk.totalBytes : null;
  const lastBackupAt = data?.backups?.lastBackupAt;
  const backupAgeDays = lastBackupAt ? (Date.now() - new Date(lastBackupAt).getTime()) / 86400000 : null;

  const alerts = [];
  if (updateAvailable) {
    alerts.push({ tone: "info", text: "Une nouvelle version est disponible.", tab: "mise-a-jour" });
  }
  if (documents.erroredDocuments > 0) {
    alerts.push({ tone: "warning", text: `${documents.erroredDocuments} document(s) en erreur d'indexation.`, tab: "documents" });
  }
  if (activity.pendingAttachments > 0) {
    alerts.push({ tone: "info", text: `${activity.pendingAttachments} pièce(s) jointe(s) à trier.`, tab: "pieces-jointes" });
  }
  if (activity.pendingFeedback > 0) {
    alerts.push({ tone: "info", text: `${activity.pendingFeedback} correction(s) en attente.`, tab: "feedback" });
  }
  if (diskFreeRatio !== null && diskFreeRatio < 0.1) {
    alerts.push({ tone: "error", text: `Espace disque faible : ${formatBytes(disk.freeBytes)} libres.` });
  }
  if (backupAgeDays === null || backupAgeDays > 7) {
    alerts.push({
      tone: "warning",
      text: lastBackupAt ? "Aucune sauvegarde depuis plus de 7 jours." : "Aucune sauvegarde n'a encore été faite.",
      tab: "sauvegardes"
    });
  }

  return (
    <div className="space-y-6">
      <section className="panel px-6 py-6 sm:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500 dark:text-slate-400">
              Tableau de bord
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-slate-50">
              L&apos;essentiel en un coup d&apos;œil
            </h2>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              Modèle actif : <span className="font-medium text-slate-700 dark:text-slate-200">{data?.activeModel || "—"}</span>
              {" · "}Embedding : <span className="font-medium text-slate-700 dark:text-slate-200">{data?.embeddingModel || "—"}</span>
              {data?.indexing?.isRunning ? " · indexation en cours" : ""}
            </p>
          </div>
          <button className="ghost-button" type="button" onClick={load}>
            Actualiser
          </button>
        </div>
      </section>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {alerts.length > 0 ? (
        <section className="space-y-2">
          {alerts.map((alert) => (
            <Alert key={alert.text} tone={alert.tone}>
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span>{alert.text}</span>
                {alert.tab && onNavigate && availableTabs.has(alert.tab) ? (
                  <button type="button" className="font-semibold underline underline-offset-4" onClick={() => onNavigate(alert.tab)}>
                    Voir
                  </button>
                ) : null}
              </span>
            </Alert>
          ))}
        </section>
      ) : (
        <Alert tone="success">Tout est en ordre.</Alert>
      )}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Questions aujourd'hui" value={activity.questionsToday ?? 0} />
        <StatTile
          label="Questions (7 jours)"
          value={activity.questionsWeek ?? 0}
          hint={`${activity.conversationsWeek ?? 0} conversation(s)`}
        />
        <StatTile
          label="Satisfaction (7 jours)"
          value={satisfaction === null ? "—" : `${satisfaction} %`}
          hint={totalRatings > 0 ? `${ratings.up} 👍 · ${ratings.down} 👎` : "Aucune évaluation"}
          tone={satisfaction !== null && satisfaction < 60 ? "warning" : "neutral"}
        />
        <StatTile
          label="Sans réponse (7 jours)"
          value={data?.unansweredWeekCount ?? 0}
          hint="À documenter en priorité"
          tone={(data?.unansweredWeekCount || 0) > 0 ? "warning" : "neutral"}
          onClick={onNavigate ? () => onNavigate("analytics") : undefined}
        />
        <StatTile
          label="Documents indexés"
          value={`${documents.indexedDocuments ?? 0} / ${documents.totalDocuments ?? 0}`}
          hint={documents.pendingDocuments > 0 ? `${documents.pendingDocuments} en attente` : `${documents.folderCount ?? 0} dossier(s)`}
          tone={documents.erroredDocuments > 0 ? "warning" : "neutral"}
          onClick={onNavigate ? () => onNavigate("documents") : undefined}
        />
        <StatTile
          label="Skills actifs"
          value={`${data?.skills?.enabled ?? 0} / ${data?.skills?.total ?? 0}`}
          onClick={onNavigate ? () => onNavigate("skills") : undefined}
        />
        <StatTile
          label="Dernière sauvegarde"
          value={lastBackupAt ? formatDateTime(lastBackupAt) : "Jamais"}
          tone={backupAgeDays === null || backupAgeDays > 7 ? "warning" : "neutral"}
        />
        <StatTile
          label="Espace disque libre"
          value={disk ? formatBytes(disk.freeBytes) : "—"}
          hint={disk ? `sur ${formatBytes(disk.totalBytes)}` : null}
          tone={diskFreeRatio !== null && diskFreeRatio < 0.1 ? "danger" : "neutral"}
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="subpanel p-6">
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Activité des 14 derniers jours</h3>
          <div className="mt-6">
            <ActivityBars perDay={activity.perDay || []} />
          </div>
        </div>

        <div className="subpanel p-6">
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Questions de la semaine</h3>
          {(data?.topQuestionsWeek || []).length === 0 ? (
            <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">Pas encore de question cette semaine.</p>
          ) : (
            <ul className="mt-4 space-y-2">
              {data.topQuestionsWeek.map((item) => (
                <li key={item.question} className="flex items-start justify-between gap-3 text-sm">
                  <span className="text-slate-700 dark:text-slate-200">{item.question}</span>
                  <StatusBadge tone="info" withDot={false}>
                    {item.occurrences}×
                  </StatusBadge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
