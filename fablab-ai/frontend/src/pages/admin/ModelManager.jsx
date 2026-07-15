import { useEffect, useMemo, useState } from "react";
import ModelSelector from "../../components/ModelSelector";
import { fetchJson, formatDateTime } from "../../lib/api";
import { reportError } from "../../lib/errors";
import { consumeNdjsonResponse } from "../../lib/streaming";
import Alert from "../../components/ui/Alert";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import EmptyState from "../../components/ui/EmptyState";
import StatusBadge from "../../components/ui/StatusBadge";
import InfoPopover from "../../components/ui/InfoPopover";

export default function ModelManager({ onRefreshSummary }) {
  const [models, setModels] = useState([]);
  const [ollamaAvailable, setOllamaAvailable] = useState(true);
  const [catalog, setCatalog] = useState([]);
  const [catalogUpdatedAt, setCatalogUpdatedAt] = useState(null);
  const [catalogRefreshBusy, setCatalogRefreshBusy] = useState(false);
  const [activeModel, setActiveModel] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [activeImageModel, setActiveImageModel] = useState("");
  const [selectedImageModel, setSelectedImageModel] = useState("");
  const [activeReasoningModel, setActiveReasoningModel] = useState("");
  const [selectedReasoningModel, setSelectedReasoningModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [newModel, setNewModel] = useState("");
  const [activeView, setActiveView] = useState("all");
  const [pullState, setPullState] = useState({ progress: 0, status: "" });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmState, setConfirmState] = useState(null);
  const [hardwareForm, setHardwareForm] = useState({
    cpuCores: "",
    hasGpu: false,
    gpuModel: "",
    ramGb: "",
    diskGb: "",
    notes: ""
  });
  const [recommendation, setRecommendation] = useState(null);
  const [recommendationBusy, setRecommendationBusy] = useState(false);
  const [recommendationError, setRecommendationError] = useState("");

  const installViews = useMemo(
    () => [{ id: "all", label: "Tous" }, ...catalog.map((family) => ({ id: family.id, label: family.label }))],
    [catalog]
  );

  const displayedFamilies = useMemo(() => {
    if (activeView === "all") {
      return catalog;
    }

    return catalog.filter((family) => family.id === activeView);
  }, [activeView, catalog]);

  const installedModelNames = useMemo(
    () => new Set(models.map((model) => String(model.name || "").toLowerCase())),
    [models]
  );

  async function loadModels() {
    try {
      const payload = await fetchJson("/api/admin/models");
      setModels(payload.models || []);
      setOllamaAvailable(payload.ollamaAvailable !== false);
      setActiveModel(payload.activeModel);
      setSelectedModel(payload.activeModel || payload.models?.[0]?.name || "");
      setActiveImageModel(payload.activeImageModel || "");
      setSelectedImageModel(payload.activeImageModel || "");
      setActiveReasoningModel(payload.activeReasoningModel || "");
      setSelectedReasoningModel(payload.activeReasoningModel || "");
    } catch (requestError) {
      setError(reportError("modeles:load", requestError));
    }
  }

  async function loadCatalog() {
    try {
      const payload = await fetchJson("/api/admin/models/catalog");
      setCatalog(payload.catalog || []);
      setCatalogUpdatedAt(payload.cached ? payload.updatedAt : null);
    } catch (requestError) {
      // Le catalogue est optionnel : son absence ne bloque pas la gestion des modèles installés.
      reportError("modeles:catalog", requestError);
    }
  }

  async function refreshCatalog() {
    setCatalogRefreshBusy(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/models/catalog/refresh", { method: "POST" });
      setMessage(payload.message);
      await loadCatalog();
    } catch (requestError) {
      setError(reportError("modeles:catalog-refresh", requestError));
    } finally {
      setCatalogRefreshBusy(false);
    }
  }

  useEffect(() => {
    loadModels();
    loadCatalog();
  }, []);

  const roleActiveModels = { text: activeModel, image: activeImageModel, reasoning: activeReasoningModel };
  const roleLabels = { text: "texte", image: "image", reasoning: "raisonnement" };

  function requestActivateModel(modelName = selectedModel, role = "text") {
    if (!modelName || modelName === roleActiveModels[role]) {
      return;
    }

    setConfirmState({
      variant: "normal",
      title: `Activer le modèle « ${modelName} » pour le rôle ${roleLabels[role]} ?`,
      message:
        "Le changement s'applique immédiatement pour tous les utilisateurs du chat. Les premières réponses peuvent être plus lentes le temps du chargement du modèle.",
      confirmLabel: "Activer",
      onConfirm: async () => {
        setConfirmState(null);
        await activateModel(modelName, role);
      }
    });
  }

  async function activateModel(modelName, role = "text") {
    setBusy(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/models/activate", {
        method: "POST",
        body: JSON.stringify({ modelName, role })
      });
      setActiveModel(payload.activeModel);
      setSelectedModel(payload.activeModel);
      setActiveImageModel(payload.activeImageModel || "");
      setSelectedImageModel(payload.activeImageModel || "");
      setActiveReasoningModel(payload.activeReasoningModel || "");
      setSelectedReasoningModel(payload.activeReasoningModel || "");
      setMessage(payload.message);
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError("modeles:activate", requestError));
    } finally {
      setBusy(false);
    }
  }

  function requestDeleteModel(modelName) {
    setConfirmState({
      variant: "danger",
      title: `Supprimer le modèle « ${modelName} » ?`,
      message: "Le modèle sera retiré du disque. Vous pourrez le retélécharger plus tard si besoin.",
      confirmLabel: "Supprimer",
      onConfirm: async () => {
        setConfirmState(null);
        await deleteModel(modelName);
      }
    });
  }

  async function deleteModel(modelName) {
    setBusy(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson(`/api/admin/models/${encodeURIComponent(modelName)}`, {
        method: "DELETE"
      });
      setMessage(payload.message);
      if (payload.activeModel) {
        setActiveModel(payload.activeModel);
        setSelectedModel(payload.activeModel);
      }
      await loadModels();
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError("modeles:delete", requestError));
    } finally {
      setBusy(false);
    }
  }

  async function pullModel(event) {
    event.preventDefault();
    await pullSpecificModel(newModel.trim());
  }

  function updateHardwareField(field, value) {
    setHardwareForm((current) => ({ ...current, [field]: value }));
  }

  async function requestHardwareRecommendation(event) {
    event.preventDefault();
    setRecommendationBusy(true);
    setRecommendationError("");
    setRecommendation(null);

    try {
      const payload = await fetchJson("/api/admin/models/recommend", {
        method: "POST",
        body: JSON.stringify({
          cpuCores: Number(hardwareForm.cpuCores),
          hasGpu: hardwareForm.hasGpu,
          gpuModel: hardwareForm.gpuModel,
          ramGb: Number(hardwareForm.ramGb),
          diskGb: hardwareForm.diskGb ? Number(hardwareForm.diskGb) : undefined
        })
      });
      setRecommendation(payload);
    } catch (requestError) {
      setRecommendationError(reportError("modeles:recommend", requestError));
    } finally {
      setRecommendationBusy(false);
    }
  }

  async function pullSpecificModel(modelName) {
    if (!modelName) {
      return;
    }

    setBusy(true);
    setError("");
    setMessage("");
    setPullState({ progress: 5, status: "Démarrage du téléchargement..." });

    try {
      const response = await fetch("/api/admin/models/pull", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ modelName })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const pullError = new Error(payload.message || "Téléchargement impossible.");
        pullError.statusCode = response.status;
        throw pullError;
      }

      await consumeNdjsonResponse(response, (payload) => {
        const total = Number(payload.total || 0);
        const completed = Number(payload.completed || 0);
        const progress =
          total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : pullState.progress;

        setPullState({
          progress: progress || 20,
          status: payload.status || "Téléchargement en cours..."
        });
      });

      setPullState({ progress: 100, status: "Modèle téléchargé." });
      setMessage("Modèle téléchargé avec succès.");
      setNewModel("");
      await loadModels();
      onRefreshSummary();
    } catch (requestError) {
      setError(
        reportError(
          "modeles:pull",
          requestError,
          "Le téléchargement a échoué. Vérifiez le nom du modèle et la connexion internet."
        )
      );
      setPullState({ progress: 0, status: "" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <ConfirmDialog
        open={Boolean(confirmState)}
        variant={confirmState?.variant}
        title={confirmState?.title}
        message={confirmState?.message}
        confirmLabel={confirmState?.confirmLabel}
        onConfirm={confirmState?.onConfirm}
        onCancel={() => setConfirmState(null)}
      />

      {!ollamaAvailable ? (
        <Alert tone="warning">
          Le service Ollama est injoignable pour le moment. La liste des modèles installés
          s&apos;affichera dès qu&apos;il sera de nouveau disponible.
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <ModelSelector
          title="Modèle de texte (principal)"
          models={models}
          activeModel={activeModel}
          selectedModel={selectedModel}
          onSelect={setSelectedModel}
          onActivate={() => requestActivateModel(selectedModel, "text")}
          busy={busy}
        />
        <ModelSelector
          title="Modèle d'image (optionnel)"
          models={models}
          activeModel={activeImageModel}
          selectedModel={selectedImageModel}
          onSelect={setSelectedImageModel}
          onActivate={() => requestActivateModel(selectedImageModel, "image")}
          busy={busy}
          optional
        />
        <ModelSelector
          title="Modèle de raisonnement (optionnel)"
          models={models}
          activeModel={activeReasoningModel}
          selectedModel={selectedReasoningModel}
          onSelect={setSelectedReasoningModel}
          onActivate={() => requestActivateModel(selectedReasoningModel, "reasoning")}
          busy={busy}
          optional
        />
      </div>

      {catalog.length > 0 ? (
        <section className="subpanel p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                  Suggestions de modèles
                </h3>
                <InfoPopover label="À propos du catalogue">
                  Ce catalogue est actualisé automatiquement une fois par mois depuis
                  ollama.com/library (ou une source distante personnalisée si configurée par
                  l&apos;administrateur du serveur). En cas d&apos;échec, la dernière version connue
                  (ou le catalogue intégré à l&apos;application) reste utilisée.
                </InfoPopover>
              </div>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Une sélection triée selon le besoin : vitesse, usage classique, raisonnement ou
                multimodal. L&apos;état « installé » est vérifié en direct auprès d&apos;Ollama.
              </p>
              <p className="mt-1 text-xs text-slate-400">
                {catalogUpdatedAt
                  ? `Dernière actualisation : ${formatDateTime(catalogUpdatedAt)}`
                  : "Catalogue intégré (jamais actualisé depuis une source distante)."}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                className="ghost-button"
                disabled={catalogRefreshBusy}
                onClick={refreshCatalog}
                type="button"
              >
                {catalogRefreshBusy ? "Actualisation..." : "Actualiser le catalogue"}
              </button>
              {installViews.map((view) => (
                <button
                  key={view.id}
                  className={activeView === view.id ? "soft-button" : "ghost-button"}
                  disabled={busy}
                  onClick={() => setActiveView(view.id)}
                >
                  {view.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6 space-y-6">
            {displayedFamilies.map((family) => (
              <div
                key={family.id}
                className="rounded-[26px] border border-slate-200 bg-white/70 p-5 dark:border-slate-700 dark:bg-slate-900/70"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h4 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                      {family.label}
                    </h4>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                      {family.description}
                    </p>
                  </div>
                  <div className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400 dark:text-slate-500">
                    {family.models.length} modèles
                  </div>
                </div>

                <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {family.models.map((model) => {
                    const isInstalled = installedModelNames.has(model.name.toLowerCase());

                    return (
                      <article
                        key={model.name}
                        className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-soft dark:border-slate-700 dark:bg-slate-900"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h5 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                              {model.label}
                            </h5>
                            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                              {model.name}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            {isInstalled && <StatusBadge tone="success">Déjà installé</StatusBadge>}
                            <StatusBadge tone="neutral" withDot={false}>
                              {model.size}
                            </StatusBadge>
                          </div>
                        </div>

                        <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
                          {model.description}
                        </p>

                        <div className="mt-5 flex gap-3">
                          <button
                            className="soft-button flex-1"
                            disabled={busy || isInstalled}
                            onClick={() => pullSpecificModel(model.name)}
                          >
                            {isInstalled ? "Installé" : "Installer"}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="subpanel p-5">
        <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
          Télécharger un nouveau modèle
        </h3>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Besoin d&apos;idées ? Vous pouvez chercher d&apos;autres modèles sur{" "}
          <a
            className="font-medium text-slate-700 underline decoration-slate-300 underline-offset-4 transition hover:text-slate-900 dark:text-slate-300 dark:decoration-slate-600 dark:hover:text-slate-100"
            href="https://ollama.com/search"
            rel="noreferrer"
            target="_blank"
          >
            ollama.com/search
          </a>
          .
        </p>
        <form className="mt-4 flex flex-col gap-3 lg:flex-row" onSubmit={pullModel}>
          <input
            className="input lg:flex-1"
            placeholder="Exemple : mistral:latest"
            value={newModel}
            onChange={(event) => setNewModel(event.target.value)}
          />
          <button className="soft-button" disabled={busy || !newModel.trim()}>
            Télécharger
          </button>
        </form>

        {(pullState.status || pullState.progress > 0) && (
          <div className="mt-4 rounded-2xl bg-slate-50 p-4 dark:bg-slate-800">
            <div className="mb-3 flex items-center justify-between text-sm text-slate-600 dark:text-slate-300">
              <span>{pullState.status}</span>
              <span>{pullState.progress}%</span>
            </div>
            <div className="h-3 rounded-full bg-slate-200 dark:bg-slate-700">
              <div
                className="h-3 rounded-full bg-brand transition-all duration-300"
                style={{ width: `${pullState.progress}%` }}
              />
            </div>
          </div>
        )}
      </section>

      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <section className="subpanel p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
              Modèles installés sur cette machine
            </h3>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Liste lue en direct depuis Ollama : activation, suppression et suivi du modèle actif.
            </p>
          </div>
          <button className="ghost-button" onClick={loadModels}>
            Actualiser
          </button>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {models.length === 0 ? (
            <div className="md:col-span-2 xl:col-span-3">
              <EmptyState
                title={ollamaAvailable ? "Aucun modèle installé" : "Ollama injoignable"}
                description={
                  ollamaAvailable
                    ? "Téléchargez un premier modèle depuis les suggestions ci-dessus ou par son nom."
                    : "La liste des modèles s'affichera dès que le service Ollama répondra."
                }
              />
            </div>
          ) : null}

          {models.map((model) => (
            <article
              key={model.name}
              className={`rounded-[24px] border p-5 ${
                model.name === activeModel
                  ? "border-brand/40 bg-accent dark:border-brand/60 dark:bg-slate-800"
                  : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                    {model.name}
                  </h4>
                  <p className="mt-2 text-xs font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
                    Mis à jour {formatDateTime(model.modifiedAt)}
                  </p>
                </div>
                {model.name === activeModel && (
                  <StatusBadge tone="info" withDot={false}>
                    Actif
                  </StatusBadge>
                )}
              </div>

              <div className="mt-6 flex gap-3">
                <button
                  className="soft-button flex-1"
                  disabled={busy || model.name === activeModel}
                  onClick={() => requestActivateModel(model.name)}
                >
                  Activer
                </button>
                <button
                  className="ghost-button border-rose-200 text-rose-700 hover:border-rose-300 hover:bg-rose-50 dark:border-rose-900/60 dark:text-rose-400 dark:hover:bg-rose-950/40"
                  disabled={busy || models.length <= 1}
                  onClick={() => requestDeleteModel(model.name)}
                >
                  Supprimer
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="subpanel p-5">
        <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
          Recommandation pour ce serveur
        </h3>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Renseignez les capacités de la machine pour obtenir une suggestion de modèle adaptée.
        </p>

        <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={requestHardwareRecommendation}>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">Cœurs CPU</span>
            <input
              type="number"
              min="1"
              className="input"
              value={hardwareForm.cpuCores}
              onChange={(event) => updateHardwareField("cpuCores", event.target.value)}
              required
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">RAM (Go)</span>
            <input
              type="number"
              min="1"
              className="input"
              value={hardwareForm.ramGb}
              onChange={(event) => updateHardwareField("ramGb", event.target.value)}
              required
            />
          </label>

          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={hardwareForm.hasGpu}
              onChange={(event) => updateHardwareField("hasGpu", event.target.checked)}
            />
            <span className="font-medium text-slate-700 dark:text-slate-300">GPU disponible</span>
          </label>

          {hardwareForm.hasGpu && (
            <label className="block text-sm sm:col-span-2">
              <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">
                Modèle de GPU (optionnel)
              </span>
              <input
                type="text"
                className="input"
                value={hardwareForm.gpuModel}
                onChange={(event) => updateHardwareField("gpuModel", event.target.value)}
              />
            </label>
          )}

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">
              Stockage disponible (Go, optionnel)
            </span>
            <input
              type="number"
              min="0"
              className="input"
              value={hardwareForm.diskGb}
              onChange={(event) => updateHardwareField("diskGb", event.target.value)}
            />
          </label>

          <div className="sm:col-span-2">
            <button className="soft-button" disabled={recommendationBusy}>
              {recommendationBusy ? "Analyse..." : "Obtenir une recommandation"}
            </button>
          </div>
        </form>

        {recommendationError ? (
          <Alert tone="error" className="mt-4">
            {recommendationError}
          </Alert>
        ) : null}

        {recommendation ? (
          <Alert tone="info" className="mt-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p>{recommendation.rationale}</p>
              {recommendation.recommendedModelName ? (
                <button
                  type="button"
                  className="soft-button whitespace-nowrap"
                  disabled={busy || recommendation.recommendedModelName === activeModel}
                  onClick={() => requestActivateModel(recommendation.recommendedModelName)}
                >
                  Activer {recommendation.recommendedModelName}
                </button>
              ) : null}
            </div>
          </Alert>
        ) : null}
      </section>
    </div>
  );
}
