/** État vide uniforme pour les listes et résultats. */
export default function EmptyState({ title, description, action = null }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-[24px] border border-dashed border-slate-300 bg-slate-50/60 px-6 py-10 text-center dark:border-slate-700 dark:bg-slate-800/40">
      <svg
        className="h-8 w-8 text-slate-400 dark:text-slate-500"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12h8" />
      </svg>
      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</p>
      {description ? <p className="max-w-sm text-sm leading-6 text-slate-500 dark:text-slate-400">{description}</p> : null}
      {action}
    </div>
  );
}
