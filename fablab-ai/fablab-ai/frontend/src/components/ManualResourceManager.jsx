import { useEffect, useState } from "react";
import { fetchJson, formatDateTime } from "../lib/api";
import { reportError } from "../lib/errors";
import Alert from "./ui/Alert";
import ConfirmDialog from "./ui/ConfirmDialog";
import EmptyState from "./ui/EmptyState";
import StatusBadge from "./ui/StatusBadge";

const emptyForm = {
  title: "",
  content: ""
};

export default function ManualResourceManager() {
  const [resources, setResources] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [resourceToDelete, setResourceToDelete] = useState(null);

  async function loadResources() {
    try {
      const payload = await fetchJson("/api/admin/manual-resources");
      setResources(payload.resources);
      setError("");
    } catch (requestError) {
      setError(reportError("personnalisation:load", requestError));
    }
  }

  useEffect(() => {
    loadResources();
  }, []);

  async function createResource(event) {
    event.preventDefault();
    if (!form.title.trim() || !form.content.trim()) {
      return;
    }

    setLoading(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/manual-resources", {
        method: "POST",
        body: JSON.stringify({
          title: form.title,
          content: form.content,
          isEnabled: true
        })
      });
      setMessage(payload.message);
      setForm(emptyForm);
      await loadResources();
    } catch (requestError) {
      setError(reportError("personnalisation:create", requestError));
    } finally {
      setLoading(false);
    }
  }

  async function toggleResource(resource) {
    setLoading(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson(`/api/admin/manual-resources/${resource.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          isEnabled: !resource.isEnabled
        })
      });
      setMessage(payload.message);
      await loadResources();
    } catch (requestError) {
      setError(reportError("personnalisation:toggle", requestError));
    } finally {
      setLoading(false);
    }
  }

  async function deleteResource() {
    if (!resourceToDelete) {
      return;
    }

    setLoading(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson(`/api/admin/manual-resources/${resourceToDelete.id}`, {
        method: "DELETE"
      });
      setMessage(payload.message);
      setResourceToDelete(null);
      await loadResources();
    } catch (requestError) {
      setError(reportError("personnalisation:delete", requestError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <ConfirmDialog
        open={Boolean(resourceToDelete)}
        variant="danger"
        title="Supprimer cette ressource de personnalisation ?"
        message={
          resourceToDelete
            ? `« ${resourceToDelete.title} » ne guidera plus les réponses de l'assistant.`
            : ""
        }
        confirmLabel="Supprimer"
        onConfirm={deleteResource}
        onCancel={() => setResourceToDelete(null)}
      />

      <section className="subpanel p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
              Base de personnalisation
            </h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              Ajoutez ici des règles métier, corrections d&apos;incohérences, vocabulaire maison
              ou nuances importantes. Cette zone est séparée des dossiers et sert de couche
              prioritaire pour guider l&apos;assistant.
            </p>
          </div>

          <button className="ghost-button" onClick={loadResources} disabled={loading}>
            Actualiser
          </button>
        </div>

        <form className="mt-5 space-y-4" onSubmit={createResource}>
          <input
            className="input"
            placeholder="Titre de la règle ou de la ressource"
            value={form.title}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                title: event.target.value
              }))
            }
          />
          <textarea
            className="input min-h-[180px] resize-y"
            placeholder="Exemple : Quand un membre parle de la laser, il faut comprendre découpe laser. Toujours rappeler la check-list de ventilation avant usage..."
            value={form.content}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                content: event.target.value
              }))
            }
          />
          <button className="soft-button" disabled={loading || !form.title.trim() || !form.content.trim()}>
            Ajouter la ressource
          </button>
        </form>
      </section>

      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <section className="subpanel p-5">
        <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Ressources actives</h3>
        <div className="mt-5 space-y-4">
          {resources.length === 0 && (
            <EmptyState title="Aucune ressource de personnalisation pour le moment." />
          )}

          {resources.map((resource) => (
            <article
              key={resource.id}
              className="rounded-[24px] border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-3">
                    <h4 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                      {resource.title}
                    </h4>
                    <StatusBadge tone={resource.isEnabled ? "success" : "neutral"}>
                      {resource.isEnabled ? "Active" : "Désactivée"}
                    </StatusBadge>
                  </div>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-600 dark:text-slate-300">
                    {resource.content}
                  </p>
                  <p className="mt-3 text-xs uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500">
                    Mise à jour {formatDateTime(resource.updatedAt)}
                  </p>
                </div>

                <div className="flex gap-3">
                  <button className="ghost-button" disabled={loading} onClick={() => toggleResource(resource)}>
                    {resource.isEnabled ? "Désactiver" : "Activer"}
                  </button>
                  <button
                    className="ghost-button border-rose-200 text-rose-700 hover:border-rose-300 hover:bg-rose-50 dark:border-rose-900/60 dark:text-rose-400 dark:hover:bg-rose-950/40"
                    disabled={loading}
                    onClick={() => setResourceToDelete(resource)}
                  >
                    Supprimer
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
