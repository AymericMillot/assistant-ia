export default function FrenchFlagBadge({ className = "" }) {
  return (
    <svg
      viewBox="0 0 3 2"
      className={`h-3 w-4 shrink-0 rounded-[2px] border border-slate-300/60 ${className}`}
      aria-label="Modèle français"
      role="img"
    >
      <rect width="1" height="2" x="0" fill="#0055A4" />
      <rect width="1" height="2" x="1" fill="#FFFFFF" />
      <rect width="1" height="2" x="2" fill="#EF4135" />
    </svg>
  );
}
