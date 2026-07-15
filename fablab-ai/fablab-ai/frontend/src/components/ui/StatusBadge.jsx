const tones = {
  neutral: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
  success:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300",
  warning:
    "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300",
  danger: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300",
  info: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300"
};

const dots = {
  neutral: "bg-slate-400",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
  info: "bg-sky-500"
};

/** Pastille de statut uniforme — le libellé texte accompagne toujours la couleur. */
export default function StatusBadge({ tone = "neutral", children, withDot = true }) {
  return (
    <span className={`status-pill ${tones[tone] || tones.neutral}`}>
      {withDot ? <span className={`h-1.5 w-1.5 rounded-full ${dots[tone] || dots.neutral}`} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
