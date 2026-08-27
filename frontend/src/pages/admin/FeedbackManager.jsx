import { useEffect, useMemo, useState } from "react";
import { fetchJson, formatDateTime } from "../../lib/api";
import { reportError } from "../../lib/errors";
import Alert from "../../components/ui/Alert";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import EmptyState from "../../components/ui/EmptyState";
import InfoPopover from "../../components/ui/InfoPopover";
import StatusBadge from "../../components/ui/StatusBadge";

const groundingModeLabels = {
  hybrid: "Documents + personnalisation",
  manual: "Personnalisation uniquement",
  documents: "Documents uniquement",
  general: "Connaissances générales (aucun contexte interne fiable)"
};

function RetrievalMetadataDetails({ metadata }) {
  if (!metadata) {
    return <p>Aucune donnée de récupération enregistrée.</p>;
  }

  return (
    <div className="space-y-3">
      <p>
        <span className="font-semibold">Mode : </span>
        {groundingModeLabels[metadata.groundingMode] || metadata.groundingMode || "Inconnu"}
      </p>
      {metadata.averagePriorityScore !== null && metadata.averagePriorityScore !== undefined ? (
        <p>Score moyen de priorité : {metadata.averagePriorityScore}</p>
      ) : null}
      {metadata.chunksUsed?.length > 0 ? (
        <div>
          <p className="font-semibold">Extraits de documents utilisés :</p>
          <ul className="mt-1 space-y-1">
            {metadata.chunksUsed.map((chunk, index) => (
              <li key={`${chunk.fileName}-${index}`}>
                {chunk.fileName || "Document"} ({chunk.folder || "?"}) — priorité {chunk.priorityScore ?? "?"}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p>Aucun extrait de document utilisé.</p>
      )}
      {metadata.manualResourcesUsed?.length > 0 ? (
        <div>
          <p className="font-semibold">Personnalisations utilisées :</p>
          <ul className="mt-1 space-y-1">
            {metadata.manualResourcesUsed.map((title) => (
              <li key={title}>{title}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {metadata.improvementRulesUsed?.length > 0 ? (
        <div>
          <p className="font-semibold">Corrections admin appliquées :</p>
          <ul className="mt-1 space-y-1">
            {metadata.improvementRulesUsed.map((instruction, index) => (
              <li key={index}>{instruction}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

const defaultForm = {
  correctedResponse: "",
  instructions: ""
};
const defaultPositiveInstruction =
  "Cette réponse est correcte. Garde cette logique, ce ton et cette formulation pour les prochaines questions similaires.";

function getLastItem(items) {
  return Array.isArray(items) && items.length > 0 ? items[items.length - 1] : null;
}

function truncate(value, length = 120) {
  const text = String(value || "").trim();
  if (text.length <= length) {
    return text;
  }

  return `${text.slice(0, length).trim()}…`;
}

export default function FeedbackManager() {
  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState(null);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [selectedExchangeId, setSelectedExchangeId] = useState(null);
  const [feedbackList, setFeedbackList] = useState([]);
  const [activeRulesCount, setActiveRulesCount] = useState(null);
  const [generatedInstructions, setGeneratedInstructions] = useState("");
  const [filters, setFilters] = useState({
    isResolved: ""
  });
  const [form, setForm] = useState(defaultForm);
  const [positiveInstruction, setPositiveInstruction] = useState(defaultPositiveInstruction);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [feedbackToDelete, setFeedbackToDelete] = useState(null);
  const [ratingsOverview, setRatingsOverview] = useState(null);
  const [showRatingDetails, setShowRatingDetails] = useState(false);

  const selectedFeedback = useMemo(
    () =>
      feedbackList.filter(
        (feedback) => !feedback.isDeleted && feedback.feedbackStatus === "resolved"
      ),
    [feedbackList]
  );

  async function loadConversations(nextSelectedId = null) {
    setLoadingList(true);
    setError("");

    try {
      const query = new URLSearchParams();
      if (filters.isResolved !== "") {
        query.set("isResolved", filters.isResolved);
      }

      const payload = await fetchJson(`/api/admin/conversations?${query.toString()}`);
      const items = payload.items || [];
      setConversations(items);

      const preferredId = nextSelectedId || selectedConversationId || items[0]?.id || null;
      setSelectedConversationId(preferredId);

      if (preferredId) {
        await loadConversationDetail(preferredId);
      } else {
        setSelectedConversation(null);
        setSelectedExchangeId(null);
      }
    } catch (requestError) {
      setError(reportError("feedback:conversations", requestError));
    } finally {
      setLoadingList(false);
    }
  }

  async function loadConversationDetail(conversationId) {
    if (!conversationId) {
      setSelectedConversation(null);
      return;
    }

    setLoadingDetail(true);
    setError("");

    try {
      const payload = await fetchJson(`/api/admin/conversations/${conversationId}`);
      setSelectedConversation(payload);
      setSelectedExchangeId(getLastItem(payload?.exchanges)?.id || null);
    } catch (requestError) {
      setError(reportError("feedback:detail", requestError));
    } finally {
      setLoadingDetail(false);
    }
  }

  async function loadFeedbackSummary() {
    try {
      const [feedbackPayload, rulesPayload, ratingsPayload] = await Promise.all([
        fetchJson("/api/admin/feedback"),
        fetchJson("/api/admin/improvement-rules").catch(() => null),
        fetchJson("/api/admin/ratings").catch(() => null)
      ]);
      setFeedbackList(feedbackPayload.feedback || []);
      if (rulesPayload) {
        const rules = rulesPayload.rules || rulesPayload.items || [];
        setActiveRulesCount(rules.filter((rule) => rule.enabled !== false).length);
      }
      if (ratingsPayload) {
        setRatingsOverview(ratingsPayload);
      }
    } catch (requestError) {
      setError(reportError("feedback:summary", requestError));
    }
  }

  async function previewPromptRules() {
    try {
      const payload = await fetchJson("/api/admin/feedback-instructions");
      setGeneratedInstructions(payload.instructionsText || "");
      setMessage("Aperçu des consignes actives affiché ci-dessous.");
    } catch (requestError) {
      setError(reportError("feedback:preview-rules", requestError));
    }
  }

  useEffect(() => {
    loadConversations();
    loadFeedbackSummary();
  }, [filters.isResolved]);

  async function updateConversationFlags(conversationId, updates) {
    setSaving(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson(`/api/admin/conversations/${conversationId}`, {
        method: "PUT",
        body: JSON.stringify(updates)
      });
      setMessage(payload.message);
      await loadConversations(conversationId);
      await loadFeedbackSummary();
    } catch (requestError) {
      setError(reportError("feedback:update-conversation", requestError));
    } finally {
      setSaving(false);
    }
  }

  async function submitFeedback(event) {
    event.preventDefault();
    if (!selectedConversation?.conversation?.id) {
      return;
    }

    setSaving(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/feedback", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: selectedConversation.conversation.id,
          exchange_id: selectedExchangeId,
          corrected_response: form.correctedResponse,
          instructions: form.instructions
        })
      });

      setMessage(
        `${payload.message} La règle associée sera appliquée automatiquement dès que le feedback sera marqué résolu.`
      );
      setForm(defaultForm);
      await loadConversationDetail(selectedConversation.conversation.id);
      await loadFeedbackSummary();
    } catch (requestError) {
      setError(reportError("feedback:submit", requestError));
    } finally {
      setSaving(false);
    }
  }

  async function validateCurrentResponse() {
    const latestExchange = getLastItem(selectedConversation?.exchanges);
    const activeExchange =
      selectedConversation?.exchanges?.find((exchange) => exchange.id === selectedExchangeId) ||
      latestExchange;
    if (!selectedConversation?.conversation?.id || !activeExchange?.answer?.trim()) {
      return;
    }

    setSaving(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/feedback", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: selectedConversation.conversation.id,
          exchange_id: activeExchange.id,
          corrected_response: activeExchange.answer,
          instructions: positiveInstruction.trim() || defaultPositiveInstruction,
          feedback_status: "resolved"
        })
      });

      setMessage(`${payload.message} La règle est active immédiatement.`);
      setPositiveInstruction(defaultPositiveInstruction);
      await loadConversationDetail(selectedConversation.conversation.id);
      await loadFeedbackSummary();
      await loadConversations(selectedConversation.conversation.id);
    } catch (requestError) {
      setError(reportError("feedback:validate", requestError));
    } finally {
      setSaving(false);
    }
  }

  async function updateFeedbackStatus(feedbackId, feedbackStatus) {
    setSaving(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson(`/api/admin/feedback/${feedbackId}`, {
        method: "PUT",
        body: JSON.stringify({ feedback_status: feedbackStatus })
      });
      setMessage(
        feedbackStatus === "resolved"
          ? `${payload.message} La règle associée est maintenant active.`
          : payload.message
      );
      await loadFeedbackSummary();
      if (selectedConversation?.conversation?.id) {
        await loadConversationDetail(selectedConversation.conversation.id);
      }
    } catch (requestError) {
      setError(reportError("feedback:status", requestError));
    } finally {
      setSaving(false);
    }
  }

  async function deleteFeedback() {
    if (!feedbackToDelete) {
      return;
    }

    setSaving(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson(`/api/admin/feedback/${feedbackToDelete.id}`, {
        method: "DELETE"
      });
      setMessage(payload.message);
      setFeedbackToDelete(null);
      await loadFeedbackSummary();
      if (selectedConversation?.conversation?.id) {
        await loadConversationDetail(selectedConversation.conversation.id);
      }
    } catch (requestError) {
      setError(reportError("feedback:delete", requestError));
    } finally {
      setSaving(false);
    }
  }

  const pendingFeedbackCount = feedbackList.filter(
    (feedback) => !feedback.isDeleted && feedback.feedbackStatus === "pending"
  ).length;

  return (
    <div className="space-y-6">
      <ConfirmDialog
        open={Boolean(feedbackToDelete)}
        variant="danger"
        title={`Masquer le feedback #${feedbackToDelete?.id} ?`}
        message="Le feedback sera masqué et la règle associée sera désactivée. L'assistant ne l'appliquera plus."
        confirmLabel="Masquer"
        onConfirm={deleteFeedback}
        onCancel={() => setFeedbackToDelete(null)}
      />

      <section className="panel px-6 py-6 sm:px-8">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500 dark:text-slate-400">
            Feedback / Correction
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-slate-50">
            Corriger les réponses et capitaliser les cas traités
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
            Chaque correction enregistrée est transformée automatiquement en règle. Dès qu&apos;un
            feedback est marqué résolu, sa règle est appliquée par l&apos;assistant, sans autre
            action de votre part.
          </p>
        </div>
      </section>

      {pendingFeedbackCount > 0 ? (
        <Alert tone="warning">
          {pendingFeedbackCount} correction(s) en attente : marquez-les « résolu » pour que
          l&apos;assistant les applique.
        </Alert>
      ) : null}
      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      {ratingsOverview && (
        <section className="subpanel px-5 py-5 sm:px-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-lg font-semibold text-slate-950 dark:text-slate-50">
                Avis des utilisateurs
              </h3>
              <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
                Les évaluations données dans le chat guident automatiquement les prochaines
                réponses de l&apos;assistant sur des questions similaires.
              </p>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <StatusBadge tone="success">
                <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
                  <path
                    d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3Zm0 0 5.5-6.5a1.5 1.5 0 0 1 2.6.9L14.5 9H19a2 2 0 0 1 1.98 2.29l-1.14 8A2 2 0 0 1 17.86 21H10a3 3 0 0 1-3-3v-8Z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {ratingsOverview.stats?.upCount || 0}
              </StatusBadge>
              <StatusBadge tone={ratingsOverview.stats?.downCount > 0 ? "danger" : "neutral"}>
                <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
                  <path
                    d="M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3Zm0 0-5.5 6.5a1.5 1.5 0 0 1-2.6-.9L9.5 15H5a2 2 0 0 1-1.98-2.29l1.14-8A2 2 0 0 1 6.14 3H14a3 3 0 0 1 3 3v8Z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {ratingsOverview.stats?.downCount || 0}
              </StatusBadge>
            </div>
          </div>

          {(ratingsOverview.recentDown || []).length > 0 && (
            <div className="mt-4">
              <button
                className="ghost-button"
                type="button"
                aria-expanded={showRatingDetails}
                onClick={() => setShowRatingDetails((current) => !current)}
              >
                {showRatingDetails
                  ? "Masquer les réponses signalées"
                  : `Voir les réponses signalées (${ratingsOverview.recentDown.length})`}
              </button>

              {showRatingDetails && (
                <ul className="mt-4 space-y-3">
                  {ratingsOverview.recentDown.map((rating) => (
                    <li
                      key={rating.id}
                      className="rounded-[18px] border border-rose-200/70 bg-rose-50/50 px-4 py-3 text-sm leading-6 dark:border-rose-900/50 dark:bg-rose-950/30"
                    >
                      <p className="font-semibold text-slate-900 dark:text-slate-100">
                        {truncate(rating.question, 160)}
                      </p>
                      <p className="mt-1 text-slate-600 dark:text-slate-300">
                        {truncate(rating.answer, 240)}
                      </p>
                      <p className="mt-1 text-[12px] text-slate-500 dark:text-slate-400">
                        Signalée le {formatDateTime(rating.createdAt)}
                        {rating.conversationId
                          ? ` · conversation #${rating.conversationId} (sélectionnez-la ci-dessous pour corriger la réponse)`
                          : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      <section className="subpanel px-5 py-5 sm:px-6">
        <div className="grid gap-3 md:grid-cols-3">
          <select
            className="input"
            value={filters.isResolved}
            onChange={(event) =>
              setFilters((current) => ({ ...current, isResolved: event.target.value }))
            }
            aria-label="Filtrer les conversations"
          >
            <option value="">Toutes les conversations</option>
            <option value="false">Non résolues</option>
            <option value="true">Résolues</option>
          </select>

          <button className="ghost-button" disabled={loadingList} onClick={() => loadConversations()}>
            {loadingList ? "Actualisation..." : "Actualiser"}
          </button>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="subpanel px-5 py-5 sm:px-6">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-slate-950 dark:text-slate-50">Conversations</h3>
            <span className="text-sm text-slate-500 dark:text-slate-400">
              {conversations.length} affichée(s)
            </span>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-slate-500 dark:text-slate-400">
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th className="px-3 py-3 font-medium">ID</th>
                  <th className="px-3 py-3 font-medium">Créée le</th>
                  <th className="px-3 py-3 font-medium">Échanges</th>
                  <th className="px-3 py-3 font-medium">Résolue</th>
                  <th className="px-3 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {conversations.map((conversation) => (
                  <tr
                    key={conversation.id}
                    className={`border-b border-slate-100 transition hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60 ${
                      selectedConversationId === conversation.id
                        ? "bg-slate-50 dark:bg-slate-800/60"
                        : ""
                    }`}
                  >
                    <td className="px-3 py-4 font-semibold text-slate-900 dark:text-slate-100">
                      {conversation.id}
                    </td>
                    <td className="px-3 py-4 text-slate-500 dark:text-slate-400">
                      {formatDateTime(conversation.createdAt)}
                    </td>
                    <td className="px-3 py-4 text-slate-500 dark:text-slate-400">
                      {conversation.exchangeCount}
                    </td>
                    <td className="px-3 py-4">
                      <StatusBadge tone={conversation.isResolved ? "success" : "warning"}>
                        {conversation.isResolved ? "Oui" : "Non"}
                      </StatusBadge>
                    </td>
                    <td className="px-3 py-4">
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="ghost-button px-3 py-1.5 text-xs"
                          onClick={() => {
                            setSelectedConversationId(conversation.id);
                            loadConversationDetail(conversation.id);
                          }}
                        >
                          Voir
                        </button>
                        <button
                          className="ghost-button px-3 py-1.5 text-xs"
                          disabled={saving}
                          onClick={() =>
                            updateConversationFlags(conversation.id, {
                              is_resolved: !conversation.isResolved
                            })
                          }
                        >
                          {conversation.isResolved ? "Annuler résolue" : "Résoudre"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!loadingList && conversations.length === 0 ? (
              <EmptyState title="Aucune conversation ne correspond aux filtres actuels." />
            ) : null}
          </div>
        </div>

        <div className="space-y-6">
          <section className="subpanel px-5 py-5 sm:px-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-950 dark:text-slate-50">Détail</h3>
              {selectedConversation?.conversation ? (
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  Conversation #{selectedConversation.conversation.id}
                </span>
              ) : null}
            </div>

            {loadingDetail ? (
              <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">Chargement...</p>
            ) : selectedConversation?.conversation ? (
              <div className="mt-4 space-y-5">
                <div className="rounded-[24px] border border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <p>Créée le : {formatDateTime(selectedConversation.conversation.createdAt)}</p>
                    <p>Résolue : {selectedConversation.conversation.isResolved ? "Oui" : "Non"}</p>
                  </div>
                </div>

                <div className="space-y-3">
                  {selectedConversation.exchanges.map((exchange) => (
                    <article
                      key={exchange.id}
                      className="rounded-[22px] border border-slate-200 bg-white px-4 py-4 dark:border-slate-700 dark:bg-slate-900"
                    >
                      <div className="grid gap-3">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                            Échange #{exchange.id}
                          </span>
                          <button
                            className={`ghost-button px-3 py-1.5 text-xs ${
                              selectedExchangeId === exchange.id
                                ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
                                : ""
                            }`}
                            type="button"
                            onClick={() => {
                              setSelectedExchangeId(exchange.id);
                              setForm({
                                correctedResponse: exchange.answer,
                                instructions: ""
                              });
                            }}
                          >
                            {selectedExchangeId === exchange.id
                              ? "Échange sélectionné"
                              : "Corriger cet échange"}
                          </button>
                        </div>
                        <div className="rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-800/60">
                          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                            Question
                          </p>
                          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-800 dark:text-slate-200">
                            {exchange.question}
                          </p>
                        </div>
                        <div className="rounded-[18px] border border-sky-100 bg-sky-50/60 px-4 py-3 dark:border-sky-900/50 dark:bg-sky-950/30">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                              Réponse
                            </p>
                            {exchange.retrievalMetadata ? (
                              <InfoPopover label="Pourquoi cette réponse ?" triggerContent="?">
                                <RetrievalMetadataDetails metadata={exchange.retrievalMetadata} />
                              </InfoPopover>
                            ) : null}
                          </div>
                          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-800 dark:text-slate-200">
                            {exchange.answer}
                          </p>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>

                <form className="space-y-4" onSubmit={submitFeedback}>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    Correction enregistrée pour l&apos;échange{" "}
                    <span className="font-medium text-slate-700 dark:text-slate-200">
                      #{selectedExchangeId || "non sélectionné"}
                    </span>
                    .
                  </p>
                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-200">
                      Ce que l&apos;assistant aurait dû répondre
                    </label>
                    <textarea
                      className="input min-h-[140px]"
                      value={form.correctedResponse}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          correctedResponse: event.target.value
                        }))
                      }
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-200">
                      Instructions pour l&apos;assistant
                    </label>
                    <textarea
                      className="input min-h-[140px]"
                      value={form.instructions}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          instructions: event.target.value
                        }))
                      }
                    />
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <button
                      className="soft-button"
                      disabled={
                        saving ||
                        !selectedExchangeId ||
                        !form.correctedResponse.trim() ||
                        !form.instructions.trim()
                      }
                      type="submit"
                    >
                      Enregistrer la correction
                    </button>
                    <button
                      className="ghost-button"
                      type="button"
                      disabled={saving}
                      onClick={() =>
                        updateConversationFlags(selectedConversation.conversation.id, {
                          is_resolved: true
                        })
                      }
                    >
                      Marquer résolue
                    </button>
                  </div>
                </form>

                <div className="rounded-[24px] border border-emerald-200 bg-emerald-50/70 p-4 dark:border-emerald-900/60 dark:bg-emerald-950/30">
                  <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">
                    Cette réponse est correcte
                  </p>
                  <p className="mt-1 text-sm leading-6 text-emerald-800/80 dark:text-emerald-300/80">
                    Enregistrez une bonne réponse pour féliciter l&apos;assistant et lui indiquer
                    de garder cette logique la prochaine fois.
                  </p>
                  <label className="mt-4 block text-sm font-medium text-emerald-900 dark:text-emerald-200">
                    Instruction positive
                  </label>
                  <textarea
                    className="input mt-2 min-h-[110px] border-emerald-200 bg-white dark:border-emerald-900/60 dark:bg-slate-900"
                    value={positiveInstruction}
                    onChange={(event) => setPositiveInstruction(event.target.value)}
                  />
                  <div className="mt-3 flex flex-wrap gap-3">
                    <button
                      className="soft-button"
                      type="button"
                      disabled={saving || !selectedExchangeId}
                      onClick={validateCurrentResponse}
                    >
                      Valider cette réponse
                    </button>
                  </div>
                </div>

                {selectedConversation.feedback.length > 0 ? (
                  <div className="space-y-3">
                    <h4 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                      Corrections déjà enregistrées
                    </h4>
                    {selectedConversation.feedback.map((feedback) => (
                      <article
                        key={feedback.id}
                        className="rounded-[22px] border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                            Feedback #{feedback.id}
                          </span>
                          <StatusBadge
                            tone={
                              feedback.feedbackStatus === "resolved"
                                ? "success"
                                : feedback.feedbackStatus === "ignored"
                                  ? "neutral"
                                  : "warning"
                            }
                          >
                            {feedback.feedbackStatus === "resolved"
                              ? "Résolu — règle active"
                              : feedback.feedbackStatus === "ignored"
                                ? "Ignoré"
                                : "En attente"}
                          </StatusBadge>
                          {feedback.exchangeId ? (
                            <StatusBadge tone="info" withDot={false}>
                              Échange #{feedback.exchangeId}
                            </StatusBadge>
                          ) : null}
                          {feedback.isDeleted ? (
                            <StatusBadge tone="danger">Masqué</StatusBadge>
                          ) : null}
                        </div>

                        <p className="mt-3 text-sm font-medium text-slate-700 dark:text-slate-200">
                          Réponse corrigée
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600 dark:text-slate-300">
                          {feedback.correctedResponse}
                        </p>

                        <p className="mt-3 text-sm font-medium text-slate-700 dark:text-slate-200">
                          Instructions
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600 dark:text-slate-300">
                          {feedback.instructions}
                        </p>
                        {feedback.exchangeQuestion ? (
                          <>
                            <p className="mt-3 text-sm font-medium text-slate-700 dark:text-slate-200">
                              Question corrigée
                            </p>
                            <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600 dark:text-slate-300">
                              {feedback.exchangeQuestion}
                            </p>
                          </>
                        ) : null}

                        <div className="mt-4 flex flex-wrap gap-2">
                          <button
                            className="ghost-button px-3 py-1.5 text-xs"
                            disabled={saving}
                            onClick={() => updateFeedbackStatus(feedback.id, "resolved")}
                          >
                            Marquer résolu
                          </button>
                          <button
                            className="ghost-button px-3 py-1.5 text-xs"
                            disabled={saving}
                            onClick={() => updateFeedbackStatus(feedback.id, "ignored")}
                          >
                            Ignorer
                          </button>
                          <button
                            className="ghost-button px-3 py-1.5 text-xs text-rose-700 dark:text-rose-400"
                            disabled={saving}
                            onClick={() => setFeedbackToDelete(feedback)}
                          >
                            Masquer
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
                Sélectionnez une conversation pour afficher son détail.
              </p>
            )}
          </section>

          <section className="subpanel px-5 py-5 sm:px-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-950 dark:text-slate-50">
                  Règles issues des feedbacks
                </h3>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  Les règles sont générées et appliquées automatiquement : aucune action manuelle
                  n&apos;est nécessaire.
                  {activeRulesCount !== null
                    ? ` ${activeRulesCount} règle(s) active(s) actuellement.`
                    : ""}
                </p>
              </div>
              <button className="ghost-button" disabled={saving} onClick={previewPromptRules}>
                Prévisualiser les consignes
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {selectedFeedback.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Aucun feedback résolu pour le moment.
                </p>
              ) : (
                selectedFeedback.map((feedback) => (
                  <article
                    key={feedback.id}
                    className="rounded-[20px] border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-700 dark:bg-slate-800/50"
                  >
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Feedback #{feedback.id}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                      {truncate(feedback.instructions, 220)}
                    </p>
                  </article>
                ))
              )}
            </div>

            {generatedInstructions ? (
              <div className="mt-5 rounded-[24px] border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Consignes actuellement injectées dans les réponses
                </p>
                <pre className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600 dark:text-slate-300">
                  {generatedInstructions}
                </pre>
              </div>
            ) : null}
          </section>
        </div>
      </section>
    </div>
  );
}
