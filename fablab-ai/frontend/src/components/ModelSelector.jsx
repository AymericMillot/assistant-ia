function FrenchFlagBadge() {
  return (
    <svg
      viewBox="0 0 3 2"
      className="h-3 w-4 shrink-0 rounded-[2px] border border-slate-300/60"
      aria-label="Modèle français"
      role="img"
    >
      <rect width="1" height="2" x="0" fill="#0055A4" />
      <rect width="1" height="2" x="1" fill="#FFFFFF" />
      <rect width="1" height="2" x="2" fill="#EF4135" />
    </svg>
  );
}

export default function ModelSelector({
  title = "Modèle actif",
  models,
  activeModel,
  selectedModel,
  onSelect,
  onActivate,
  busy,
  optional = false
}) {
  const selectedModelIsFrench = models.some(
    (model) => model.name === selectedModel && model.provider === "mistral"
  );

  return (
    <div className="subpanel flex flex-col gap-4 p-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-brand/70">{title}</p>
        <h3 className="mt-1 flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-slate-100">
          {activeModel || (optional ? "Aucun (optionnel)" : "Non défini")}
        </h3>
      </div>

      <div className="flex flex-col gap-3 md:flex-row">
        <div className="relative md:flex-1">
          <select
            className="input w-full"
            value={selectedModel}
            onChange={(event) => onSelect(event.target.value)}
          >
            {optional ? <option value="">Aucun</option> : null}
            {models.map((model) => (
              <option key={model.name} value={model.name}>
                {model.name}
                {model.provider === "mistral" ? " (FR)" : ""}
              </option>
            ))}
          </select>
          {selectedModelIsFrench ? (
            <span className="pointer-events-none absolute right-9 top-1/2 -translate-y-1/2">
              <FrenchFlagBadge />
            </span>
          ) : null}
        </div>

        <button className="soft-button" disabled={busy || !selectedModel} onClick={onActivate}>
          Activer ce modèle
        </button>
      </div>
    </div>
  );
}
