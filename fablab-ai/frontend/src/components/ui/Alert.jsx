const tones = {
  error: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200",
  success:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200",
  warning:
    "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
  info: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-200"
};

/** Bandeau d'alerte uniforme (erreur, succès, avertissement, information). */
export default function Alert({ tone = "info", children, className = "" }) {
  if (!children) {
    return null;
  }

  return (
    <div
      className={`rounded-2xl border px-4 py-3 text-sm leading-6 ${tones[tone] || tones.info} ${className}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
