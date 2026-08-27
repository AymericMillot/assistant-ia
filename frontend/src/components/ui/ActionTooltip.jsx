// Tooltip CSS-only (pas de dépendance JS) pour les rangées de boutons d'action
// des messages (copier, régénérer, évaluer...), affichée au survol ou au focus clavier.
export default function ActionTooltip({ label, children }) {
  return (
    <span className="group/tooltip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute -top-9 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100 dark:bg-slate-700"
      >
        {label}
      </span>
    </span>
  );
}
