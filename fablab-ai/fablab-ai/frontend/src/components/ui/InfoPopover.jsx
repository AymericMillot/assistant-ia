import { useEffect, useId, useRef, useState } from "react";

/**
 * Info-bulle accessible : s'ouvre au clic/tap ou au clavier (Entrée/Espace),
 * se ferme avec Échap, au clic extérieur ou en re-cliquant le déclencheur.
 * Fonctionne sur tactile contrairement à un tooltip hover-only.
 */
export default function InfoPopover({ label = "Informations", triggerContent = "i", children, align = "right" }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <span className="relative inline-flex" ref={containerRef}>
      <button
        type="button"
        className="message-info-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {triggerContent}
      </button>
      {open ? (
        <div
          id={popoverId}
          role="dialog"
          aria-label={label}
          className={`message-info-popover absolute bottom-full z-40 mb-2 w-64 rounded-[20px] border border-slate-200 bg-white p-4 text-left text-xs leading-5 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {children}
        </div>
      ) : null}
    </span>
  );
}
