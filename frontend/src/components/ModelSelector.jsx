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
  return (
    <div className="subpanel flex flex-col gap-4 p-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-brand/70">{title}</p>
        <h3 className="mt-1 flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-slate-100">
          {activeModel || (optional ? "Aucun (optionnel)" : "Non défini")}
        </h3>
      </div>

      <div className="flex flex-col gap-3 md:flex-row">
        <select
          className="input w-full md:flex-1"
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

        <button className="soft-button" disabled={busy || !selectedModel} onClick={onActivate}>
          Activer ce modèle
        </button>
      </div>
    </div>
  );
}
