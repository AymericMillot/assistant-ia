import { useEffect, useState } from "react";
import { fetchJson } from "../lib/api";
import { reportError } from "../lib/errors";

function formatVersionDate(value) {
  if (!value) {
    return null;
  }

  try {
    return new Intl.DateTimeFormat("fr-FR", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value));
  } catch {
    return null;
  }
}

function renderNotes(notes) {
  const lines = String(notes || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd());

  const hasBulletLikeLine = lines.some((line) => /^[-*•]\s+/.test(line));

  if (hasBulletLikeLine) {
    const items = lines
      .filter(Boolean)
      .map((line) => line.replace(/^[-*•]\s+/, "").trim())
      .filter(Boolean);

    return (
      <ul className="space-y-3 text-[15px] leading-7 text-slate-700 dark:text-slate-300">
        {items.map((item) => (
          <li key={item} className="flex gap-3">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400 dark:bg-slate-600" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-4 text-[15px] leading-7 text-slate-700 dark:text-slate-300">
      {lines.filter(Boolean).map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

/**
 * Page publique en lecture seule : aucune authentification requise, aucune
 * action possible (ni telechargement, ni installation). L'installation des
 * mises a jour reste reservee a l'administration (onglet "Mise a jour").
 */
export default function ReleaseNotesPage() {
  const [state, setState] = useState({
    loading: true,
    error: "",
    latestVersion: null,
    releases: []
  });

  useEffect(() => {
    let mounted = true;

    fetchJson("/api/releases", {
      retryCount: 1,
      timeoutMs: 12000
    })
      .then((payload) => {
        if (!mounted) {
          return;
        }

        setState({
          loading: false,
          error: "",
          latestVersion: payload.latestVersion || null,
          releases: Array.isArray(payload.releases) ? payload.releases : []
        });
      })
      .catch((error) => {
        if (!mounted) {
          return;
        }

        setState({
          loading: false,
          error: reportError("release-notes", error, "Impossible de charger les notes de version."),
          latestVersion: null,
          releases: []
        });
      });

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <section className="space-y-6">
      <div className="panel px-6 py-7 sm:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400 dark:text-slate-500">
              Historique des versions
            </p>
            <h1 className="text-3xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-slate-50">
              Notes de mise à jour
            </h1>
            <p className="max-w-3xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              Cette page regroupe les évolutions publiées du projet, à titre informatif.
            </p>
          </div>

          {state.latestVersion ? (
            <div className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
              Dernière version : {state.latestVersion}
            </div>
          ) : null}
        </div>
      </div>

      {state.loading ? (
        <div className="panel px-6 py-10 text-sm text-slate-500 dark:text-slate-400">
          Chargement des notes de version...
        </div>
      ) : null}

      {!state.loading && state.error ? (
        <div className="panel border border-slate-200 px-6 py-6 text-sm leading-6 text-slate-600 dark:border-slate-700 dark:text-slate-300">
          <p className="font-medium text-slate-900 dark:text-slate-100">
            Les notes de version ne sont pas disponibles pour le moment.
          </p>
          <p className="mt-2">{state.error}</p>
        </div>
      ) : null}

      {!state.loading && !state.error && state.releases.length === 0 ? (
        <div className="panel px-6 py-10 text-sm text-slate-500 dark:text-slate-400">
          Aucune note de version n&apos;a encore été publiée.
        </div>
      ) : null}

      {!state.loading && !state.error ? (
        <div className="space-y-5">
          {state.releases.map((release, index) => {
            const publishedAt =
              formatVersionDate(release.publishedAt || release.updatedAt || release.createdAt) || null;
            const isLatest = index === 0;

            return (
              <article key={`${release.version}-${index}`} className="panel px-6 py-7 sm:px-8">
                <div className="flex flex-col gap-2 border-b border-slate-100 pb-5 dark:border-slate-800">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-slate-50">
                      Version {release.version}
                    </h2>
                    {isLatest ? (
                      <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
                        Dernière publiée
                      </span>
                    ) : null}
                  </div>

                  {publishedAt ? (
                    <p className="text-sm text-slate-500 dark:text-slate-400">Publiée le {publishedAt}</p>
                  ) : null}
                </div>

                <div className="pt-6">
                  {release.notes?.trim() ? (
                    renderNotes(release.notes)
                  ) : (
                    <p className="text-sm leading-6 text-slate-500 dark:text-slate-400">
                      Aucune note détaillée n&apos;est disponible pour cette version.
                    </p>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
