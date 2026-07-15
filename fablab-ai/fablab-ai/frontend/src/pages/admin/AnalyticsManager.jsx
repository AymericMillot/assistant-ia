import { useEffect, useState } from "react";
import { fetchJson, formatDateTime } from "../../lib/api";
import { reportError } from "../../lib/errors";
import Alert from "../../components/ui/Alert";
import EmptyState from "../../components/ui/EmptyState";
import StatusBadge from "../../components/ui/StatusBadge";

export default function AnalyticsManager() {
  const [topQuestions, setTopQuestions] = useState([]);
  const [unansweredQuestions, setUnansweredQuestions] = useState([]);
  const [scoreSummary, setScoreSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadAnalytics() {
    setLoading(true);
    setError("");

    try {
      const [topPayload, unansweredPayload, scorePayload] = await Promise.all([
        fetchJson("/api/admin/analytics/top-questions"),
        fetchJson("/api/admin/analytics/unanswered-questions"),
        fetchJson("/api/admin/retrieval-scores")
      ]);
      setTopQuestions(topPayload.questions || []);
      setUnansweredQuestions(unansweredPayload.questions || []);
      setScoreSummary(scorePayload);
    } catch (requestError) {
      setError(reportError("analytics", requestError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAnalytics();
  }, []);

  if (loading) {
    return (
      <section className="subpanel px-6 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
        Chargement...
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section className="panel px-6 py-6 sm:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500 dark:text-slate-400">
              Analytics
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-slate-50">
              Ce que demandent les utilisateurs
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              Questions les plus fréquentes, questions sans réponse documentaire fiable, et
              distribution des scores de pertinence pour calibrer les seuils au fil du temps.
            </p>
          </div>
          <button className="ghost-button" onClick={loadAnalytics}>
            Actualiser
          </button>
        </div>
      </section>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {scoreSummary ? (
        <section className="subpanel p-6">
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
            Calibration des scores de pertinence
          </h3>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <article className="rounded-[20px] border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                Échantillons
              </p>
              <p className="mt-2 text-xl font-semibold text-slate-950 dark:text-slate-50">
                {scoreSummary.sampleCount}
              </p>
            </article>
            <article className="rounded-[20px] border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                Hors-sujet / sans contexte
              </p>
              <p className="mt-2 text-xl font-semibold text-slate-950 dark:text-slate-50">
                {Math.round((scoreSummary.outOfScopeRate || 0) * 100)} %
              </p>
            </article>
            <article className="rounded-[20px] border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                Score moyen
              </p>
              <p className="mt-2 text-xl font-semibold text-slate-950 dark:text-slate-50">
                {scoreSummary.averageOfAverageScores ?? "—"}
              </p>
            </article>
            <article className="rounded-[20px] border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                Plage observée
              </p>
              <p className="mt-2 text-xl font-semibold text-slate-950 dark:text-slate-50">
                {scoreSummary.minObservedScore ?? "—"} – {scoreSummary.maxObservedScore ?? "—"}
              </p>
            </article>
          </div>
        </section>
      ) : null}

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="subpanel p-6">
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Questions les plus posées</h3>
          <div className="mt-4 space-y-3">
            {topQuestions.length === 0 ? (
              <EmptyState title="Pas encore assez de conversations pour dégager une tendance." />
            ) : (
              topQuestions.map((item, index) => (
                <article
                  key={`${item.question}-${index}`}
                  className="rounded-[18px] border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-700 dark:bg-slate-800/50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm leading-6 text-slate-800 dark:text-slate-200">{item.question}</p>
                    <StatusBadge tone="info" withDot={false}>
                      {item.occurrences}×
                    </StatusBadge>
                  </div>
                  <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                    Dernière fois : {formatDateTime(item.lastAskedAt)}
                  </p>
                </article>
              ))
            )}
          </div>
        </div>

        <div className="subpanel p-6">
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
            Questions sans réponse documentaire fiable
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            L'assistant a répondu sur ses connaissances générales, faute de contexte interne
            suffisamment pertinent. Utile pour savoir quoi documenter en priorité.
          </p>
          <div className="mt-4 space-y-3">
            {unansweredQuestions.length === 0 ? (
              <EmptyState title="Aucune question hors-sujet récente détectée." />
            ) : (
              unansweredQuestions.map((item) => (
                <article
                  key={item.id}
                  className="rounded-[18px] border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-900/50 dark:bg-amber-950/20"
                >
                  <p className="text-sm leading-6 text-slate-800 dark:text-slate-200">{item.question}</p>
                  <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                    {formatDateTime(item.createdAt)}
                  </p>
                </article>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
