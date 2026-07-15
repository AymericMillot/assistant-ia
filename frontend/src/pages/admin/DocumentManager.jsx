import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { fetchJson, formatDateTime } from "../../lib/api";
import { reportError } from "../../lib/errors";
import Alert from "../../components/ui/Alert";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import EmptyState from "../../components/ui/EmptyState";
import StatusBadge from "../../components/ui/StatusBadge";

const acceptedExtensions = [".txt", ".pdf", ".odt", ".docx", ".csv", ".xlsx"];

function documentStatusTone(document) {
  if (document.indexingStatus === "indexed") {
    return "success";
  }

  if (document.indexingStatus === "error") {
    return "danger";
  }

  return "warning";
}

function statusLabel(document) {
  if (document.indexingStatus === "indexed") {
    return "Indexé";
  }

  if (document.indexingStatus === "error") {
    return "Erreur";
  }

  return "En attente";
}

export default function DocumentManager({ onRefreshSummary }) {
  const fileInputRef = useRef(null);
  const realtimeRefreshTimeoutRef = useRef(null);
  const [folders, setFolders] = useState([]);
  const [documentLinks, setDocumentLinks] = useState([]);
  const [expandedLinkId, setExpandedLinkId] = useState(null);
  const [linkPagesById, setLinkPagesById] = useState({});
  const [linkPagesLoading, setLinkPagesLoading] = useState(false);
  const [folderNames, setFolderNames] = useState([]);
  const [newFolder, setNewFolder] = useState("");
  const [targetFolder, setTargetFolder] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [linkDraft, setLinkDraft] = useState({
    title: "",
    description: "",
    url: ""
  });
  const [activeReindexingIds, setActiveReindexingIds] = useState({});
  const [duplicateImportState, setDuplicateImportState] = useState(null);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState(() => new Set());
  const [bulkMoveTarget, setBulkMoveTarget] = useState("");
  const [confirmState, setConfirmState] = useState(null);
  const [chunkPreview, setChunkPreview] = useState(null);

  const sortDocumentsAlphabetically = (documents) =>
    [...(documents || [])].sort((left, right) =>
      String(left.originalName || left.filename || "").localeCompare(
        String(right.originalName || right.filename || ""),
        "fr",
        {
          sensitivity: "base",
          numeric: true,
          ignorePunctuation: true
        }
      )
    );

  const hasActiveReindexing = useMemo(
    () => Object.keys(activeReindexingIds).length > 0,
    [activeReindexingIds]
  );

  const selectedCount = selectedDocumentIds.size;

  function closeConfirm() {
    setConfirmState(null);
  }

  function askConfirmation(options) {
    setConfirmState(options);
  }

  async function loadDocuments({ silent = false } = {}) {
    if (!silent) {
      setLoading(true);
    }

    try {
      const [documentPayload, folderPayload, linkPayload] = await Promise.all([
        fetchJson("/api/admin/documents"),
        fetchJson("/api/admin/folders"),
        fetchJson("/api/admin/document-links")
      ]);

      setFolders(documentPayload.folders);
      setFolderNames(folderPayload.folders);
      setDocumentLinks(linkPayload.links || []);

      if (folderPayload.folders.length > 0) {
        setTargetFolder((current) => current || folderPayload.folders[0]);
      }

      const validIds = new Set(
        documentPayload.folders.flatMap((folder) => folder.documents.map((document) => document.id))
      );
      setSelectedDocumentIds((current) => {
        const next = new Set([...current].filter((id) => validIds.has(id)));
        return next.size === current.size ? current : next;
      });

      setActiveReindexingIds((current) => {
        const next = {};
        const activeIdsFromServer = new Set(documentPayload.activeDocumentIndexIds || []);

        activeIdsFromServer.forEach((documentId) => {
          next[documentId] = true;
        });

        const documents = documentPayload.folders.flatMap((folder) => folder.documents);

        documents.forEach((document) => {
          const isActive = Boolean(next[document.id] || current[document.id]);
          if (!isActive) {
            return;
          }

          if (document.indexingStatus === "indexed" || document.indexingStatus === "error") {
            delete next[document.id];
            return;
          }

          next[document.id] = true;
        });

        return next;
      });
    } catch (requestError) {
      setError(reportError("documents:load", requestError));
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }

  function updateLinkDraft(field, value) {
    setLinkDraft((current) => ({
      ...current,
      [field]: value
    }));
  }

  async function createDocumentLink(event) {
    event.preventDefault();
    if (!linkDraft.title.trim() || !linkDraft.description.trim() || !linkDraft.url.trim()) {
      setError("Renseignez le titre, la description et le lien.");
      return;
    }

    setLoading(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/document-links", {
        method: "POST",
        body: JSON.stringify({
          title: linkDraft.title,
          description: linkDraft.description,
          url: linkDraft.url
        })
      });
      setMessage(payload.message);
      setLinkDraft({
        title: "",
        description: "",
        url: ""
      });
      await loadDocuments({ silent: true });
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError("documents:create-link", requestError));
    } finally {
      setLoading(false);
    }
  }

  async function refreshDocumentLink(linkId) {
    setLoading(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson(`/api/admin/document-links/${linkId}/refresh`, {
        method: "POST",
        timeoutMs: 60000
      });
      setMessage(payload.message);
      await loadDocuments({ silent: true });
    } catch (requestError) {
      setError(reportError("documents:refresh-link", requestError));
      await loadDocuments({ silent: true });
    } finally {
      setLoading(false);
    }
  }

  async function toggleLinkPages(linkId) {
    if (expandedLinkId === linkId) {
      setExpandedLinkId(null);
      return;
    }

    setExpandedLinkId(linkId);
    if (linkPagesById[linkId]) {
      return;
    }

    setLinkPagesLoading(true);
    try {
      const payload = await fetchJson(`/api/admin/document-links/${linkId}/pages`);
      setLinkPagesById((current) => ({ ...current, [linkId]: payload.pages || [] }));
    } catch (requestError) {
      setError(reportError("documents:link-pages", requestError));
    } finally {
      setLinkPagesLoading(false);
    }
  }

  async function toggleDocumentLink(linkId, isEnabled) {
    setLoading(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson(`/api/admin/document-links/${linkId}`, {
        method: "PATCH",
        body: JSON.stringify({ isEnabled: !isEnabled })
      });
      setMessage(payload.message);
      await loadDocuments({ silent: true });
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError("documents:toggle-link", requestError));
    } finally {
      setLoading(false);
    }
  }

  function requestDeleteDocumentLink(link) {
    askConfirmation({
      variant: "danger",
      title: "Supprimer ce lien documentaire ?",
      message: `Le lien « ${link.title} » ne sera plus proposé par l'assistant.`,
      confirmLabel: "Supprimer",
      onConfirm: async () => {
        closeConfirm();
        setLoading(true);
        setError("");
        setMessage("");

        try {
          const payload = await fetchJson(`/api/admin/document-links/${link.id}`, {
            method: "DELETE"
          });
          setMessage(payload.message);
          await loadDocuments({ silent: true });
          onRefreshSummary();
        } catch (requestError) {
          setError(reportError("documents:delete-link", requestError));
        } finally {
          setLoading(false);
        }
      }
    });
  }

  useEffect(() => {
    loadDocuments();
  }, []);

  useEffect(() => {
    const socket = io("/", {
      transports: ["websocket"],
      withCredentials: true
    });

    const scheduleRealtimeRefresh = () => {
      if (realtimeRefreshTimeoutRef.current) {
        window.clearTimeout(realtimeRefreshTimeoutRef.current);
      }

      realtimeRefreshTimeoutRef.current = window.setTimeout(() => {
        loadDocuments({ silent: true });
        realtimeRefreshTimeoutRef.current = null;
      }, 250);
    };

    socket.on("indexing:progress", () => {
      scheduleRealtimeRefresh();
      onRefreshSummary();
    });

    return () => {
      if (realtimeRefreshTimeoutRef.current) {
        window.clearTimeout(realtimeRefreshTimeoutRef.current);
        realtimeRefreshTimeoutRef.current = null;
      }
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!hasActiveReindexing) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      loadDocuments({ silent: true });
    }, 2500);

    return () => window.clearInterval(timer);
  }, [hasActiveReindexing]);

  function normalizeFiles(fileList) {
    const files = Array.from(fileList || []);
    const validFiles = files.filter((file) =>
      acceptedExtensions.some((extension) => file.name.toLowerCase().endsWith(extension))
    );

    if (validFiles.length !== files.length) {
      setError(
        "Certains fichiers ont été ignorés. Vérifiez simplement que leur format est accepté."
      );
    }

    return validFiles;
  }

  function getDuplicateReasonLabel(reason) {
    if (reason === "name-and-content") {
      return "Même nom et même contenu";
    }

    if (reason === "content") {
      return "Même contenu";
    }

    if (reason === "name") {
      return "Même nom";
    }

    return "Doublon détecté";
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function handleDragOver(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!dragActive) {
      setDragActive(true);
    }
  }

  function handleDragLeave(event) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
  }

  function handleDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    setError("");
    handleIncomingFiles(event.dataTransfer.files);
  }

  async function createFolder(event) {
    event.preventDefault();
    if (!newFolder.trim()) {
      return;
    }

    setLoading(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/folders", {
        method: "POST",
        body: JSON.stringify({ name: newFolder })
      });
      setMessage(payload.message);
      setNewFolder("");
      setTargetFolder(newFolder.trim());
      await loadDocuments({ silent: true });
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError("documents:create-folder", requestError));
    } finally {
      setLoading(false);
    }
  }

  // Dépôt ou sélection de fichiers = envoi immédiat vers le dossier choisi (une seule étape).
  function handleIncomingFiles(fileList) {
    const files = normalizeFiles(fileList);
    if (files.length === 0) {
      return;
    }

    if (!targetFolder) {
      setError("Choisissez d'abord un dossier de destination, puis redéposez vos fichiers.");
      return;
    }

    setPendingFiles(files);
    setDuplicateImportState(null);
    submitUpload(files, "reject");
  }

  async function submitUpload(files, duplicateStrategy = "reject") {
    if (!files || files.length === 0 || !targetFolder) {
      return;
    }

    setLoading(true);
    setError("");
    setMessage("");

    try {
      const formData = new FormData();
      formData.append("folderName", targetFolder);
      formData.append("duplicateStrategy", duplicateStrategy);
      files.forEach((file) => formData.append("files", file));

      const response = await fetch(
        new URL("/api/admin/documents/upload", window.location.origin).toString(),
        {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "application/json"
          },
          body: formData
        }
      );
      const contentType = response.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await response.json()
        : { message: "" };

      if (!response.ok) {
        if (response.status === 409 && Array.isArray(payload.duplicates)) {
          setDuplicateImportState({
            duplicates: payload.duplicates,
            targetFolder,
            selectedCount: files.length
          });
          setError(payload.message || "Des doublons ont été détectés.");
          return;
        }

        const uploadError = new Error(payload.message || "Téléversement impossible.");
        uploadError.statusCode = response.status;
        throw uploadError;
      }

      setMessage(payload.message);
      setPendingFiles([]);
      setDuplicateImportState(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      await loadDocuments({ silent: true });
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError("documents:upload", requestError, "Le téléversement a échoué. Réessayez."));
    } finally {
      setLoading(false);
    }
  }

  async function resolveDuplicateImport(strategy) {
    await submitUpload(pendingFiles, strategy);
  }

  async function applyMoveDocument(documentId, destination) {
    setLoading(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson(`/api/admin/documents/${documentId}/move`, {
        method: "PATCH",
        body: JSON.stringify({ folderName: destination })
      });
      setMessage(payload.message);
      await loadDocuments({ silent: true });
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError("documents:move", requestError));
    } finally {
      setLoading(false);
    }
  }

  async function applyVisibility(documentId, visibility) {
    setLoading(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson(`/api/admin/documents/${documentId}/visibility`, {
        method: "PATCH",
        body: JSON.stringify({ visibility })
      });
      setMessage(payload.message);
      await loadDocuments({ silent: true });
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError("documents:visibility", requestError));
    } finally {
      setLoading(false);
    }
  }

  // Le select ne déclenche plus rien directement : il ouvre une confirmation avec aperçu de l'action.
  function requestVisibilityChange(document, nextVisibility) {
    const currentVisibility = document.visibility || "public";
    if (nextVisibility === currentVisibility) {
      return;
    }

    const goingPublic = nextVisibility === "public";
    askConfirmation({
      variant: goingPublic ? "danger" : "normal",
      title: goingPublic ? "Rendre ce document public ?" : "Rendre ce document privé ?",
      message: `« ${document.originalName} » — ${
        goingPublic
          ? "l'assistant pourra proposer ce fichier au téléchargement dans ses réponses."
          : "l'assistant pourra toujours s'en servir pour répondre, mais ne le proposera plus au téléchargement."
      }`,
      confirmLabel: goingPublic ? "Rendre public" : "Rendre privé",
      onConfirm: async () => {
        closeConfirm();
        await applyVisibility(document.id, nextVisibility);
      }
    });
  }

  function requestMoveDocument(document, destinationFolder) {
    if (destinationFolder === document.folderName) {
      return;
    }

    askConfirmation({
      variant: "normal",
      title: "Déplacer ce document ?",
      message: `« ${document.originalName} » sera déplacé de « ${document.folderName} » vers « ${destinationFolder} » puis réindexé.`,
      confirmLabel: "Déplacer",
      onConfirm: async () => {
        closeConfirm();
        await applyMoveDocument(document.id, destinationFolder);
      }
    });
  }

  async function loadChunkPreview(document) {
    setChunkPreview({
      documentId: document.id,
      documentName: document.originalName,
      loading: true,
      error: "",
      data: null
    });

    try {
      const payload = await fetchJson(`/api/admin/documents/${document.id}/preview-chunks`);
      setChunkPreview({
        documentId: document.id,
        documentName: document.originalName,
        loading: false,
        error: "",
        data: payload
      });
    } catch (requestError) {
      setChunkPreview({
        documentId: document.id,
        documentName: document.originalName,
        loading: false,
        error: reportError("documents:preview-chunks", requestError, "Impossible de prévisualiser ce document."),
        data: null
      });
    }
  }

  async function reindexDocument(documentId) {
    setLoading(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson(`/api/admin/documents/${documentId}/reindex`, {
        method: "POST"
      });
      setMessage(payload.message);
      setActiveReindexingIds((current) => ({
        ...current,
        [documentId]: Date.now()
      }));
      await loadDocuments({ silent: true });
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError("documents:reindex", requestError));
    } finally {
      setLoading(false);
    }
  }

  async function cancelReindexDocument(documentId) {
    setLoading(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson(`/api/admin/documents/${documentId}/reindex/cancel`, {
        method: "POST"
      });
      setMessage(payload.message);
      setActiveReindexingIds((current) => {
        const next = { ...current };
        delete next[documentId];
        return next;
      });
      await loadDocuments({ silent: true });
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError("documents:cancel-reindex", requestError));
    } finally {
      setLoading(false);
    }
  }

  function requestDeleteDocument(document) {
    askConfirmation({
      variant: "danger",
      title: "Supprimer ce document ?",
      message: `« ${document.originalName} » sera retiré du dossier « ${document.folderName} ».`,
      consequences: ["Le fichier et son indexation seront supprimés définitivement."],
      confirmLabel: "Supprimer",
      onConfirm: async () => {
        closeConfirm();
        setLoading(true);
        setError("");
        setMessage("");

        try {
          const payload = await fetchJson(`/api/admin/documents/${document.id}`, {
            method: "DELETE"
          });
          setMessage(payload.message);
          setActiveReindexingIds((current) => {
            const next = { ...current };
            delete next[document.id];
            return next;
          });
          await loadDocuments({ silent: true });
          onRefreshSummary();
        } catch (requestError) {
          setError(reportError("documents:delete", requestError));
        } finally {
          setLoading(false);
        }
      }
    });
  }

  function requestDeleteFolder(folder) {
    askConfirmation({
      variant: "critical",
      title: `Supprimer le dossier « ${folder.name} » ?`,
      message: "Cette action est irréversible.",
      consequences: [
        `${folder.documentCount} document(s) seront supprimés définitivement.`,
        "Les indexations associées seront effacées.",
        "Les réponses de l'assistant ne pourront plus s'appuyer sur ces fichiers."
      ],
      requireText: "supprimer",
      confirmLabel: "Supprimer définitivement",
      onConfirm: async () => {
        closeConfirm();
        setLoading(true);
        setError("");
        setMessage("");

        try {
          const payload = await fetchJson(`/api/admin/folders/${encodeURIComponent(folder.name)}`, {
            method: "DELETE",
            body: JSON.stringify({ confirmation: "oui" })
          });
          setMessage(payload.message);
          await loadDocuments({ silent: true });
          onRefreshSummary();
        } catch (requestError) {
          setError(reportError("documents:delete-folder", requestError));
        } finally {
          setLoading(false);
        }
      }
    });
  }

  function toggleDocumentSelection(documentId) {
    setSelectedDocumentIds((current) => {
      const next = new Set(current);
      if (next.has(documentId)) {
        next.delete(documentId);
      } else {
        next.add(documentId);
      }
      return next;
    });
  }

  function toggleFolderSelection(folder) {
    const folderIds = folder.documents.map((document) => document.id);
    const allSelected = folderIds.every((id) => selectedDocumentIds.has(id));

    setSelectedDocumentIds((current) => {
      const next = new Set(current);
      folderIds.forEach((id) => {
        if (allSelected) {
          next.delete(id);
        } else {
          next.add(id);
        }
      });
      return next;
    });
  }

  async function runBulkAction(body, summaryScope) {
    setLoading(true);
    setError("");
    setMessage("");

    try {
      const payload = await fetchJson("/api/admin/documents/bulk", {
        method: "POST",
        body: JSON.stringify({ ...body, documentIds: [...selectedDocumentIds] })
      });

      if (payload.failed?.length > 0) {
        setError(
          `${payload.message} Documents en échec : ${payload.failed
            .map((item) => `#${item.documentId} (${item.message})`)
            .join(", ")}`
        );
      } else {
        setMessage(payload.message);
      }

      setSelectedDocumentIds(new Set());
      setBulkMoveTarget("");
      await loadDocuments({ silent: true });
      onRefreshSummary();
    } catch (requestError) {
      setError(reportError(summaryScope, requestError));
    } finally {
      setLoading(false);
    }
  }

  function requestBulkDelete() {
    askConfirmation({
      variant: "danger",
      title: `Supprimer ${selectedCount} document(s) ?`,
      consequences: ["Les fichiers et leurs indexations seront supprimés définitivement."],
      confirmLabel: "Tout supprimer",
      onConfirm: async () => {
        closeConfirm();
        await runBulkAction({ action: "delete" }, "documents:bulk-delete");
      }
    });
  }

  function requestBulkVisibility(visibility) {
    const goingPublic = visibility === "public";
    askConfirmation({
      variant: goingPublic ? "danger" : "normal",
      title: goingPublic
        ? `Rendre ${selectedCount} document(s) publics ?`
        : `Rendre ${selectedCount} document(s) privés ?`,
      message: goingPublic
        ? "L'assistant pourra proposer ces fichiers au téléchargement dans ses réponses."
        : "L'assistant ne proposera plus ces fichiers au téléchargement.",
      confirmLabel: goingPublic ? "Rendre publics" : "Rendre privés",
      onConfirm: async () => {
        closeConfirm();
        await runBulkAction({ action: "visibility", visibility }, "documents:bulk-visibility");
      }
    });
  }

  function requestBulkMove() {
    if (!bulkMoveTarget) {
      setError("Choisissez un dossier de destination pour le déplacement groupé.");
      return;
    }

    askConfirmation({
      variant: "normal",
      title: `Déplacer ${selectedCount} document(s) ?`,
      message: `Les documents sélectionnés seront déplacés vers « ${bulkMoveTarget} » puis réindexés.`,
      confirmLabel: "Déplacer",
      onConfirm: async () => {
        closeConfirm();
        await runBulkAction({ action: "move", folderName: bulkMoveTarget }, "documents:bulk-move");
      }
    });
  }

  function requestBulkReindex() {
    askConfirmation({
      variant: "normal",
      title: `Réindexer ${selectedCount} document(s) ?`,
      message: "Les documents seront ajoutés à la file d'indexation.",
      confirmLabel: "Réindexer",
      onConfirm: async () => {
        closeConfirm();
        await runBulkAction({ action: "reindex" }, "documents:bulk-reindex");
      }
    });
  }

  return (
    <div className="space-y-6">
      <ConfirmDialog
        open={Boolean(confirmState)}
        variant={confirmState?.variant}
        title={confirmState?.title}
        message={confirmState?.message}
        consequences={confirmState?.consequences || []}
        requireText={confirmState?.requireText || ""}
        confirmLabel={confirmState?.confirmLabel}
        onConfirm={confirmState?.onConfirm}
        onCancel={closeConfirm}
      />

      {chunkPreview ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/30 px-4 backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setChunkPreview(null);
            }
          }}
        >
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-[28px] border border-white/80 bg-white p-6 shadow-[0_30px_80px_rgba(15,23,42,0.25)] dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-950 dark:text-slate-50">
                  Aperçu du découpage
                </h3>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{chunkPreview.documentName}</p>
              </div>
              <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => setChunkPreview(null)}>
                Fermer
              </button>
            </div>

            {chunkPreview.loading ? (
              <p className="mt-6 text-sm text-slate-500 dark:text-slate-400">Extraction en cours...</p>
            ) : null}

            {chunkPreview.error ? (
              <Alert tone="error" className="mt-4">
                {chunkPreview.error}
              </Alert>
            ) : null}

            {chunkPreview.data ? (
              <div className="mt-4 space-y-3">
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {chunkPreview.data.totalChunks} extrait(s) au total
                  {chunkPreview.data.truncated ? " (aperçu limité aux 40 premiers)" : ""}.
                </p>
                {chunkPreview.data.chunks.map((chunk) => (
                  <article
                    key={chunk.index}
                    className="rounded-[18px] border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/60"
                  >
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500">
                      Extrait {chunk.index + 1} · {chunk.charCount} caractères
                    </p>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700 dark:text-slate-300">
                      {chunk.content}
                    </p>
                  </article>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
        <section className="subpanel p-6">
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Nouveau dossier</h3>
          <form className="mt-4 space-y-4" onSubmit={createFolder}>
            <input
              className="input"
              placeholder="Exemple : electronique"
              value={newFolder}
              onChange={(event) => setNewFolder(event.target.value)}
            />
            <button className="soft-button w-full" disabled={loading}>
              Créer le dossier
            </button>
          </form>
        </section>

        <section className="subpanel p-6">
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
            Téléversement de documents
          </h3>
          <div className="mt-4 space-y-4">
            <select
              className="input"
              value={targetFolder}
              onChange={(event) => setTargetFolder(event.target.value)}
              disabled={folderNames.length === 0}
              aria-label="Dossier de destination"
            >
              <option value="">
                {folderNames.length === 0 ? "Créez d'abord un dossier" : "Choisissez un dossier"}
              </option>
              {folderNames.map((folderName) => (
                <option key={folderName} value={folderName}>
                  {folderName}
                </option>
              ))}
            </select>

            <div
              className={`flex min-h-[184px] cursor-pointer flex-col items-center justify-center rounded-[26px] border border-dashed px-6 py-8 text-center transition ${
                dragActive
                  ? "border-brand bg-white shadow-[0_20px_50px_rgba(59,130,246,0.18)] dark:bg-slate-800"
                  : "border-line bg-accent/60 dark:border-slate-600 dark:bg-slate-800/50"
              }`}
              onDragEnter={handleDragOver}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={openFilePicker}
              role="button"
              tabIndex={0}
              aria-label="Déposer ou choisir des fichiers à téléverser"
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openFilePicker();
                }
              }}
            >
              <span className="text-lg font-bold text-slate-900 dark:text-slate-100">
                {targetFolder
                  ? `Déposez vos fichiers : envoi direct vers « ${targetFolder} »`
                  : "Glissez-déposez vos fichiers ou cliquez ici"}
              </span>
              <span className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                Import multiple sans limite de nombre de fichiers par envoi. Le téléversement
                démarre dès le dépôt.
              </span>
              <input
                ref={fileInputRef}
                className="hidden"
                type="file"
                multiple
                accept=".txt,.pdf,.odt,.docx,.csv,.xlsx"
                onChange={(event) => handleIncomingFiles(event.target.files)}
              />
            </div>

            {loading && pendingFiles.length > 0 ? (
              <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                Téléversement de {pendingFiles.length} fichier(s) en cours...
              </div>
            ) : null}
          </div>
        </section>
      </div>

      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      {duplicateImportState && (
        <section className="rounded-[26px] border border-amber-200 bg-amber-50/80 p-6 dark:border-amber-900/60 dark:bg-amber-950/30">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Doublons détectés</h3>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-300">
                Certains fichiers existent déjà dans le dossier{" "}
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  {duplicateImportState.targetFolder}
                </span>
                . Choisissez une action pour toute cette importation : ignorer les doublons,
                remplacer les anciens fichiers en supprimant leurs données existantes, ou renommer
                les nouveaux fichiers en ajoutant un numéro à la fin.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                className="ghost-button"
                disabled={loading}
                onClick={() => {
                  setDuplicateImportState(null);
                  setPendingFiles([]);
                  setError("");
                }}
              >
                Annuler
              </button>
              <button
                className="ghost-button"
                disabled={loading}
                onClick={() => resolveDuplicateImport("ignore")}
              >
                Ignorer tous
              </button>
              <button
                className="ghost-button"
                disabled={loading}
                onClick={() => resolveDuplicateImport("rename")}
              >
                Renommer tous
              </button>
              <button
                className="soft-button"
                disabled={loading}
                onClick={() => resolveDuplicateImport("replace")}
              >
                Remplacer tous
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-3">
            {duplicateImportState.duplicates.map((duplicate, index) => (
              <article
                key={`${duplicate.incomingName}-${duplicate.existingDocument?.id || index}`}
                className="rounded-[22px] border border-amber-200 bg-white/85 p-4 dark:border-amber-900/60 dark:bg-slate-900/70"
              >
                <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {duplicate.incomingName}
                    </p>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                      {getDuplicateReasonLabel(duplicate.reason)} avec{" "}
                      <span className="font-medium text-slate-700 dark:text-slate-200">
                        {duplicate.existingDocument?.originalName || duplicate.existingDocument?.filename}
                      </span>
                    </p>
                  </div>
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-400 dark:text-slate-500">
                    {duplicate.existingDocument?.folderName}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {selectedCount > 0 ? (
        <section className="sticky top-3 z-30 rounded-[26px] border border-brand/30 bg-white/95 p-4 shadow-[0_18px_45px_rgba(59,130,246,0.18)] backdrop-blur dark:border-brand/40 dark:bg-slate-900/95">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {selectedCount} document(s) sélectionné(s)
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button className="ghost-button" disabled={loading} onClick={requestBulkReindex} type="button">
                Réindexer
              </button>
              <button
                className="ghost-button"
                disabled={loading}
                onClick={() => requestBulkVisibility("public")}
                type="button"
              >
                Rendre publics
              </button>
              <button
                className="ghost-button"
                disabled={loading}
                onClick={() => requestBulkVisibility("private")}
                type="button"
              >
                Rendre privés
              </button>
              <div className="flex items-center gap-2">
                <select
                  className="input w-auto min-w-[150px] py-2"
                  value={bulkMoveTarget}
                  onChange={(event) => setBulkMoveTarget(event.target.value)}
                  aria-label="Dossier de destination du déplacement groupé"
                >
                  <option value="">Déplacer vers...</option>
                  {folderNames.map((folderName) => (
                    <option key={folderName} value={folderName}>
                      {folderName}
                    </option>
                  ))}
                </select>
                <button
                  className="ghost-button"
                  disabled={loading || !bulkMoveTarget}
                  onClick={requestBulkMove}
                  type="button"
                >
                  Déplacer
                </button>
              </div>
              <button className="danger-button" disabled={loading} onClick={requestBulkDelete} type="button">
                Supprimer
              </button>
              <button
                className="ghost-button"
                onClick={() => setSelectedDocumentIds(new Set())}
                type="button"
              >
                Tout désélectionner
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="subpanel p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="max-w-3xl">
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
              Arborescence documentaire
            </h3>
            <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
              Vue claire des fichiers, de leur indexation et de leur visibilité. Cochez plusieurs
              documents pour agir en une seule fois.
            </p>
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <StatusBadge tone="neutral" withDot={false}>
                Privé : utilisable pour répondre, jamais téléchargeable
              </StatusBadge>
              <StatusBadge tone="info" withDot={false}>
                Public : utilisable pour répondre et proposable au téléchargement
              </StatusBadge>
            </div>
          </div>

          <button className="ghost-button self-start" disabled={loading} onClick={() => loadDocuments()}>
            Actualiser
          </button>
        </div>

        <div className="mt-6 space-y-6">
          {folders.length === 0 && !loading ? (
            <EmptyState
              title="Aucun dossier pour le moment"
              description="Créez un premier dossier puis déposez-y vos documents pour alimenter l'assistant."
            />
          ) : null}

          {folders.map((folder) => {
            const folderIds = folder.documents.map((document) => document.id);
            const allFolderSelected =
              folderIds.length > 0 && folderIds.every((id) => selectedDocumentIds.has(id));

            return (
              <section
                key={folder.name}
                className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-soft dark:border-slate-700 dark:bg-slate-900"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex items-center gap-3">
                    {folder.documents.length > 0 ? (
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 accent-slate-900 dark:accent-slate-100"
                        checked={allFolderSelected}
                        onChange={() => toggleFolderSelection(folder)}
                        aria-label={`Sélectionner tous les documents du dossier ${folder.name}`}
                      />
                    ) : null}
                    <div>
                      <h4 className="text-xl font-semibold tracking-[-0.03em] text-slate-950 dark:text-slate-50">
                        {folder.name}
                      </h4>
                      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                        {folder.documentCount} document{folder.documentCount > 1 ? "s" : ""}
                      </p>
                    </div>
                  </div>

                  <button
                    className="ghost-button border-rose-200 text-rose-700 hover:border-rose-300 hover:bg-rose-50 dark:border-rose-900/60 dark:text-rose-400 dark:hover:bg-rose-950/40"
                    disabled={loading}
                    onClick={() => requestDeleteFolder(folder)}
                  >
                    Supprimer le dossier
                  </button>
                </div>

                <div className="mt-5 space-y-4">
                  {folder.documents.length === 0 ? (
                    <EmptyState title="Aucun document dans ce dossier." />
                  ) : null}

                  {sortDocumentsAlphabetically(folder.documents).map((document) => {
                    const isSingleReindexActive =
                      Boolean(activeReindexingIds[document.id]) &&
                      document.indexingStatus !== "indexed" &&
                      document.indexingStatus !== "error";

                    return (
                      <article
                        key={document.id}
                        className={`rounded-[24px] border p-4 transition ${
                          selectedDocumentIds.has(document.id)
                            ? "border-brand/50 bg-accent/70 dark:border-brand/60 dark:bg-slate-800"
                            : "border-slate-200 bg-slate-50/60 dark:border-slate-700 dark:bg-slate-800/50"
                        }`}
                      >
                        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[auto_minmax(0,1.4fr)_minmax(220px,0.62fr)_minmax(220px,0.78fr)_auto]">
                          <div className="flex items-start pt-1">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-slate-300 accent-slate-900 dark:accent-slate-100"
                              checked={selectedDocumentIds.has(document.id)}
                              onChange={() => toggleDocumentSelection(document.id)}
                              aria-label={`Sélectionner ${document.originalName}`}
                            />
                          </div>

                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h5 className="min-w-0 break-words text-base font-semibold text-slate-900 dark:text-slate-100">
                                {document.originalName}
                              </h5>
                              <StatusBadge
                                tone={(document.visibility || "public") === "public" ? "info" : "neutral"}
                                withDot={false}
                              >
                                {(document.visibility || "public") === "public" ? "Public" : "Privé"}
                              </StatusBadge>
                              <StatusBadge tone={documentStatusTone(document)}>
                                {statusLabel(document)}
                              </StatusBadge>
                            </div>
                            <p className="mt-2 break-all text-sm text-slate-500 dark:text-slate-400">
                              {document.relativePath}
                            </p>
                            {document.lastError ? (
                              <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">
                                {document.lastError}
                              </p>
                            ) : null}

                            {isSingleReindexActive ? (
                              <div className="mt-4 max-w-xl">
                                <div className="mb-2 flex items-center justify-between text-xs font-medium text-emerald-700 dark:text-emerald-400">
                                  <span>Indexation manuelle en cours</span>
                                  <span>Traitement du fichier...</span>
                                </div>
                                <div className="h-2 overflow-hidden rounded-full bg-emerald-100 dark:bg-emerald-950/60">
                                  <div className="h-full w-full animate-pulse rounded-full bg-gradient-to-r from-emerald-400 via-emerald-500 to-emerald-400" />
                                </div>
                              </div>
                            ) : null}
                          </div>

                          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                            <div className="rounded-[20px] border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900">
                              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500">
                                Chunks
                              </p>
                              <p className="mt-2 text-base font-semibold text-slate-900 dark:text-slate-100">
                                {document.chunkCount}
                              </p>
                            </div>
                            <div className="rounded-[20px] border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900">
                              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500">
                                Dernière indexation
                              </p>
                              <p className="mt-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                                {formatDateTime(document.lastIndexedAt)}
                              </p>
                            </div>
                          </div>

                          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-1">
                            <div>
                              <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500">
                                Visibilité
                              </label>
                              <select
                                className="input min-w-0 bg-white dark:bg-slate-900"
                                disabled={loading}
                                value={document.visibility || "public"}
                                onChange={(event) => requestVisibilityChange(document, event.target.value)}
                              >
                                <option value="private">Privé</option>
                                <option value="public">Public</option>
                              </select>
                            </div>

                            <div>
                              <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500">
                                Déplacer
                              </label>
                              <select
                                className="input min-w-0 bg-white dark:bg-slate-900"
                                disabled={loading}
                                value={document.folderName}
                                onChange={(event) => requestMoveDocument(document, event.target.value)}
                              >
                                {folderNames.map((folderName) => (
                                  <option key={folderName} value={folderName}>
                                    {folderName}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-start justify-start gap-2 xl:flex-col xl:items-stretch">
                            <button
                              className="ghost-button w-full min-w-[124px]"
                              disabled={loading}
                              onClick={() => loadChunkPreview(document)}
                            >
                              Aperçu du découpage
                            </button>
                            <button
                              className="ghost-button w-full min-w-[124px]"
                              disabled={loading}
                              onClick={() =>
                                isSingleReindexActive
                                  ? cancelReindexDocument(document.id)
                                  : reindexDocument(document.id)
                              }
                            >
                              {isSingleReindexActive ? "Arrêter l'indexation" : "Indexer"}
                            </button>
                            <button
                              className="ghost-button w-full min-w-[124px] border-rose-200 text-rose-700 hover:border-rose-300 hover:bg-rose-50 dark:border-rose-900/60 dark:text-rose-400 dark:hover:bg-rose-950/40"
                              disabled={loading}
                              onClick={() => requestDeleteDocument(document)}
                            >
                              Supprimer
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </section>

      <section className="subpanel p-6">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Liens documentaires</h3>
            <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
              Ajoutez une documentation web avec un titre, une description et un lien. Le contenu
              de la page est automatiquement récupéré et indexé : l'assistant s'appuie dessus pour
              répondre et cite le lien comme source.
            </p>

            <form className="mt-4 space-y-4" onSubmit={createDocumentLink}>
              <input
                className="input"
                placeholder="Titre du lien"
                value={linkDraft.title}
                onChange={(event) => updateLinkDraft("title", event.target.value)}
              />
              <textarea
                className="input min-h-[110px]"
                placeholder="Description utile pour aider l'assistant à comprendre le contenu"
                value={linkDraft.description}
                onChange={(event) => updateLinkDraft("description", event.target.value)}
              />
              <input
                className="input"
                placeholder="https://..."
                value={linkDraft.url}
                onChange={(event) => updateLinkDraft("url", event.target.value)}
              />
              <button className="soft-button" disabled={loading}>
                Ajouter le lien documentaire
              </button>
            </form>
          </div>

          <div className="space-y-4">
            {documentLinks.length === 0 ? (
              <EmptyState title="Aucun lien documentaire enregistré." />
            ) : (
              documentLinks.map((link) => (
                <article
                  key={link.id}
                  className="rounded-[22px] border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-700 dark:bg-slate-800/50"
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                          {link.title}
                        </h4>
                        <StatusBadge tone={link.isEnabled ? "success" : "neutral"}>
                          {link.isEnabled ? "Actif" : "Désactivé"}
                        </StatusBadge>
                        {link.scrapeStatus === "ok" && (
                          <StatusBadge tone="info">Contenu indexé</StatusBadge>
                        )}
                        {link.scrapeStatus === "pending" && (
                          <StatusBadge tone="warning">Analyse en cours</StatusBadge>
                        )}
                        {link.scrapeStatus === "error" && (
                          <StatusBadge tone="danger">Analyse échouée</StatusBadge>
                        )}
                      </div>
                      <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                        {link.description}
                      </p>
                      {link.scrapeStatus === "error" && link.scrapeError && (
                        <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">
                          {link.scrapeError}
                        </p>
                      )}
                      <a
                        className="mt-2 inline-block break-all text-sm text-sky-700 underline decoration-sky-300 underline-offset-4 dark:text-sky-400 dark:decoration-sky-700"
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {link.url}
                      </a>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        className="ghost-button"
                        disabled={loading || link.scrapeStatus === "pending"}
                        onClick={() => refreshDocumentLink(link.id)}
                        type="button"
                      >
                        {link.scrapeStatus === "pending" ? "Analyse..." : "Réanalyser"}
                      </button>
                      <button
                        className="ghost-button"
                        onClick={() => toggleLinkPages(link.id)}
                        type="button"
                      >
                        {expandedLinkId === link.id ? "Masquer le détail" : "Détail de l'analyse"}
                      </button>
                      <button
                        className="ghost-button"
                        disabled={loading}
                        onClick={() => toggleDocumentLink(link.id, link.isEnabled)}
                        type="button"
                      >
                        {link.isEnabled ? "Désactiver" : "Activer"}
                      </button>
                      <button
                        className="ghost-button border-rose-200 text-rose-700 hover:border-rose-300 hover:bg-rose-50 dark:border-rose-900/60 dark:text-rose-400 dark:hover:bg-rose-950/40"
                        disabled={loading}
                        onClick={() => requestDeleteDocumentLink(link)}
                        type="button"
                      >
                        Supprimer
                      </button>
                    </div>
                  </div>

                  {expandedLinkId === link.id && (
                    <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-700">
                      {linkPagesLoading && !linkPagesById[link.id] ? (
                        <p className="text-sm text-slate-500 dark:text-slate-400">Chargement...</p>
                      ) : (linkPagesById[link.id] || []).length === 0 ? (
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                          Aucune analyse enregistrée pour ce lien.
                        </p>
                      ) : (
                        <ul className="space-y-2">
                          {linkPagesById[link.id].map((page) => (
                            <li
                              key={page.id}
                              className="flex flex-col gap-1 rounded-xl bg-white/80 px-3 py-2 text-sm dark:bg-slate-900/50"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <StatusBadge tone={page.status === "success" ? "success" : "danger"}>
                                  {page.status === "success" ? "Analysée" : "Échec"}
                                </StatusBadge>
                                <span className="break-all text-slate-600 dark:text-slate-300">
                                  {page.url}
                                </span>
                              </div>
                              <span className="text-xs text-slate-400">
                                {formatDateTime(page.fetchedAt || page.createdAt)}
                                {page.status === "success" ? ` · ${page.characters} caractères` : ""}
                              </span>
                              {page.errorMessage && (
                                <span className="text-xs text-rose-600 dark:text-rose-400">
                                  {page.errorMessage}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </article>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
