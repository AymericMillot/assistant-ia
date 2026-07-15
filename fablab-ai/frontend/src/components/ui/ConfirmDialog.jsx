import { useEffect, useRef, useState } from "react";

const variantStyles = {
  normal: {
    confirmClass: "soft-button",
    iconClass: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
  },
  danger: {
    confirmClass: "danger-button",
    iconClass: "bg-rose-50 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400"
  },
  critical: {
    confirmClass: "danger-button",
    iconClass: "bg-rose-50 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400"
  }
};

/**
 * Boîte de confirmation unique pour tout le projet.
 *
 * Niveaux de risque :
 * - variant="normal"  : confirmation simple (actions réversibles ou peu risquées)
 * - variant="danger"  : action destructive, bouton rouge + liste des conséquences
 * - variant="critical": action irréversible, exige la saisie de `requireText`
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  consequences = [],
  variant = "normal",
  requireText = "",
  confirmLabel = "Confirmer",
  cancelLabel = "Annuler",
  onConfirm,
  onCancel
}) {
  const [typedText, setTypedText] = useState("");
  const [working, setWorking] = useState(false);
  const cancelButtonRef = useRef(null);

  const styles = variantStyles[variant] || variantStyles.normal;
  const needsTypedConfirmation = variant === "critical" && requireText;
  const confirmDisabled =
    working || (needsTypedConfirmation && typedText.trim().toLowerCase() !== requireText.toLowerCase());

  useEffect(() => {
    if (open) {
      setTypedText("");
      setWorking(false);
      cancelButtonRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handleKeyDown(event) {
      if (event.key === "Escape" && !working) {
        onCancel?.();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, working, onCancel]);

  if (!open) {
    return null;
  }

  async function handleConfirm() {
    if (confirmDisabled) {
      return;
    }

    setWorking(true);
    try {
      await onConfirm?.();
    } finally {
      setWorking(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/30 px-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !working) {
          onCancel?.();
        }
      }}
    >
      <div
        className="w-full max-w-md rounded-[28px] border border-white/80 bg-white p-6 shadow-[0_30px_80px_rgba(15,23,42,0.25)] dark:border-slate-700 dark:bg-slate-900"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <div className="flex items-start gap-4">
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${styles.iconClass}`}
            aria-hidden="true"
          >
            {variant === "normal" ? (
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4M12 16h.01" />
              </svg>
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                <path d="M12 9v4M12 17h.01" />
              </svg>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <h3 id="confirm-dialog-title" className="text-lg font-semibold text-slate-950 dark:text-slate-50">
              {title}
            </h3>
            {message ? (
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{message}</p>
            ) : null}
          </div>
        </div>

        {consequences.length > 0 ? (
          <ul className="mt-4 space-y-1.5 rounded-[20px] border border-rose-200/70 bg-rose-50/70 px-4 py-3 text-sm leading-6 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
            {consequences.map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden="true">•</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {needsTypedConfirmation ? (
          <div className="mt-4">
            <label className="mb-2 block text-sm font-semibold text-slate-700 dark:text-slate-200" htmlFor="confirm-dialog-input">
              Tapez « {requireText} » pour confirmer
            </label>
            <input
              id="confirm-dialog-input"
              className="input"
              value={typedText}
              onChange={(event) => setTypedText(event.target.value)}
              autoComplete="off"
              disabled={working}
            />
          </div>
        ) : null}

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            ref={cancelButtonRef}
            className="ghost-button"
            type="button"
            onClick={onCancel}
            disabled={working}
          >
            {cancelLabel}
          </button>
          <button
            className={styles.confirmClass}
            type="button"
            onClick={handleConfirm}
            disabled={confirmDisabled}
          >
            {working ? "En cours..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
