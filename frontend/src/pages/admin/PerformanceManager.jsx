import { useEffect, useState } from "react";
import { fetchJson, formatBytes, formatDateTime, formatDuration, formatPercent } from "../../lib/api";
import { reportError } from "../../lib/errors";

function MetricCard({ title, value, hint }) {
  return (
    <article className="subpanel p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">{title}</p>
      <p className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-slate-950">{value}</p>
      {hint ? <p className="mt-2 text-sm leading-6 text-slate-500">{hint}</p> : null}
    </article>
  );
}

export default function PerformanceManager() {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadSnapshot({ silent = false } = {}) {
    if (!silent) {
      setLoading(true);
    }

    try {
      const payload = await fetchJson("/api/admin/performance");
      setSnapshot(payload);
      setError("");
    } catch (requestError) {
      setError(reportError("performance", requestError));
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    loadSnapshot();
    const timer = window.setInterval(() => {
      loadSnapshot({ silent: true });
    }, 4000);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="space-y-6">
      <section className="panel px-6 py-6 sm:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500">
              Performance
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-[-0.05em] text-slate-950">
              État de la machine en direct
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
              Suivi utile du CPU, de la mémoire, du disque, de la température, du GPU et du temps
              depuis le déploiement.
            </p>
          </div>

          <button className="ghost-button" disabled={loading} onClick={() => loadSnapshot()}>
            {loading ? "Actualisation..." : "Actualiser"}
          </button>
        </div>
      </section>

      {error ? (
        <section className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </section>
      ) : null}

      {snapshot?.warnings?.length ? (
        <section className="subpanel px-5 py-4 sm:px-6">
          <div className="space-y-2">
            {snapshot.warnings.map((warning) => (
              <p key={warning} className="text-sm leading-6 text-slate-600">
                {warning}
              </p>
            ))}
          </div>
        </section>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-4">
        <MetricCard
          title="Déploiement"
          value={formatDuration(snapshot?.deployment?.deploymentAgeSeconds || 0)}
          hint={
            snapshot?.deployment?.deployedAt
              ? `Depuis le ${formatDateTime(snapshot.deployment.deployedAt)}`
              : "Indisponible"
          }
        />
        <MetricCard
          title="Uptime backend"
          value={formatDuration(snapshot?.deployment?.backendUptimeSeconds || 0)}
          hint="Temps depuis le démarrage du serveur"
        />
        <MetricCard
          title="CPU"
          value={formatPercent(snapshot?.cpu?.usagePercent)}
          hint={`${snapshot?.cpu?.logicalCores || 0} cœurs logiques`}
        />
        <MetricCard
          title="Mémoire"
          value={formatPercent(snapshot?.memory?.usagePercent)}
          hint={`${formatBytes(snapshot?.memory?.usedBytes)} / ${formatBytes(snapshot?.memory?.totalBytes)}`}
        />
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <div className="space-y-6">
          <section className="subpanel px-5 py-5 sm:px-6">
            <h3 className="text-lg font-semibold text-slate-950">Système</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-[20px] border border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-600">
                <p>Hôte : {snapshot?.environment?.hostname || "Inconnu"}</p>
                <p>Environnement : {snapshot?.environment?.scopeLabel || "Inconnu"}</p>
                <p>OS : {snapshot?.environment?.platform || "?"} {snapshot?.environment?.release || ""}</p>
                <p>Architecture : {snapshot?.environment?.arch || "?"}</p>
                <p>Node.js : {snapshot?.environment?.nodeVersion || "?"}</p>
                <p className="mt-2">Déployé par : {snapshot?.deployment?.deployedBy || "Inconnu"}</p>
              </div>
              <div className="rounded-[20px] border border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-600">
                <p>Accès utile :</p>
                <div className="mt-2 space-y-1">
                  {snapshot?.deployment?.localAccessUrl ? (
                    <p className="break-all">{snapshot.deployment.localAccessUrl}</p>
                  ) : (
                    <p>URL réseau indisponible</p>
                  )}
                  {snapshot?.deployment?.localhostAccessUrl ? (
                    <p className="break-all text-slate-500">{snapshot.deployment.localhostAccessUrl}</p>
                  ) : null}
                  {(snapshot?.environment?.localIpAddresses || []).length > 0 ? (
                    <p className="pt-2 text-xs uppercase tracking-[0.18em] text-slate-400">
                      IPs vues depuis le service : {snapshot.environment.localIpAddresses.join(", ")}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          <section className="subpanel px-5 py-5 sm:px-6">
            <h3 className="text-lg font-semibold text-slate-950">CPU et mémoire</h3>
            <div className="mt-4 space-y-4">
              <div className="rounded-[20px] border border-slate-200 bg-white p-4 text-sm text-slate-600">
                <p className="font-medium text-slate-800">{snapshot?.cpu?.model || "Inconnu"}</p>
                <p className="mt-2">Charge CPU : {formatPercent(snapshot?.cpu?.usagePercent)}</p>
                <p>Load average 1 min : {snapshot?.cpu?.loadAverage1m ?? "Indisponible"}</p>
                <p>Load average 5 min : {snapshot?.cpu?.loadAverage5m ?? "Indisponible"}</p>
                <p>Load average 15 min : {snapshot?.cpu?.loadAverage15m ?? "Indisponible"}</p>
              </div>

              <div className="rounded-[20px] border border-slate-200 bg-white p-4 text-sm text-slate-600">
                <p>Mémoire utilisée : {formatBytes(snapshot?.memory?.usedBytes)}</p>
                <p>Mémoire libre : {formatBytes(snapshot?.memory?.freeBytes)}</p>
                <p>Mémoire totale : {formatBytes(snapshot?.memory?.totalBytes)}</p>
                <p className="mt-2">Mémoire backend (RSS) : {formatBytes(snapshot?.memory?.processRssBytes)}</p>
                <p>Heap utilisé : {formatBytes(snapshot?.memory?.heapUsedBytes)}</p>
                <p>Heap total : {formatBytes(snapshot?.memory?.heapTotalBytes)}</p>
              </div>
            </div>
          </section>

          <section className="subpanel px-5 py-5 sm:px-6">
            <h3 className="text-lg font-semibold text-slate-950">Disques</h3>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {(snapshot?.storage || []).map((item) => (
                <article key={item.path} className="rounded-[20px] border border-slate-200 bg-white p-4 text-sm text-slate-600">
                  <p className="font-medium text-slate-800">{item.label}</p>
                  <p className="mt-2">Utilisé : {formatBytes(item.usedBytes)}</p>
                  <p>Disponible : {formatBytes(item.availableBytes)}</p>
                  <p>Total : {formatBytes(item.totalBytes)}</p>
                  <p>Occupation : {formatPercent(item.usagePercent)}</p>
                  <p className="mt-2 break-all text-xs text-slate-400">{item.path}</p>
                </article>
              ))}
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <section className="subpanel px-5 py-5 sm:px-6">
            <h3 className="text-lg font-semibold text-slate-950">Température</h3>
            <div className="mt-4 space-y-3">
              <article className="rounded-[20px] border border-slate-200 bg-white p-4 text-sm text-slate-600">
                <p>Max : {snapshot?.thermal?.maxCelsius ? `${snapshot.thermal.maxCelsius} °C` : "Indisponible"}</p>
                <p>Moyenne : {snapshot?.thermal?.averageCelsius ? `${snapshot.thermal.averageCelsius} °C` : "Indisponible"}</p>
              </article>
              {(snapshot?.thermal?.sensors || []).length > 0 ? (
                snapshot.thermal.sensors.map((sensor) => (
                  <article
                    key={`${sensor.label}-${sensor.celsius}`}
                    className="rounded-[18px] border border-slate-200 bg-slate-50/70 px-4 py-3 text-sm text-slate-600"
                  >
                    <p className="font-medium text-slate-800">{sensor.label}</p>
                    <p className="mt-1">{sensor.celsius} °C</p>
                  </article>
                ))
              ) : (
                <p className="text-sm text-slate-500">Aucun capteur de température accessible.</p>
              )}
            </div>
          </section>

          <section className="subpanel px-5 py-5 sm:px-6">
            <h3 className="text-lg font-semibold text-slate-950">GPU</h3>
            <div className="mt-4 space-y-3">
              {(snapshot?.gpu?.devices || []).length > 0 ? (
                snapshot.gpu.devices.map((gpu) => (
                  <article key={gpu.name} className="rounded-[20px] border border-slate-200 bg-white p-4 text-sm text-slate-600">
                    <p className="font-medium text-slate-800">{gpu.name}</p>
                    <p className="mt-2">Utilisation : {formatPercent(gpu.utilizationPercent)}</p>
                    <p>Mémoire : {gpu.memoryUsedMiB} MiB / {gpu.memoryTotalMiB} MiB</p>
                    <p>Température : {Number.isFinite(gpu.temperatureCelsius) ? `${gpu.temperatureCelsius} °C` : "Indisponible"}</p>
                    <p>Puissance : {Number.isFinite(gpu.powerDrawWatts) ? `${gpu.powerDrawWatts} W` : "Indisponible"}</p>
                  </article>
                ))
              ) : (
                <p className="text-sm text-slate-500">Aucun GPU accessible ou détecté.</p>
              )}
            </div>
          </section>

          <section className="subpanel px-5 py-5 sm:px-6">
            <h3 className="text-lg font-semibold text-slate-950">Actualisation</h3>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Dernier relevé : {snapshot?.collectedAt ? formatDateTime(snapshot.collectedAt) : "Indisponible"}
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              Rafraîchissement automatique toutes les 4 secondes.
            </p>
          </section>
        </div>
      </section>
    </div>
  );
}
