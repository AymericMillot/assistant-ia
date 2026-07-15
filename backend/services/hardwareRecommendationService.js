import { getModelCatalog } from "../config/modelCatalog.js";

// Seuils simples et volontairement prudents : on privilegie un modele qui
// tourne confortablement plutot que le plus gros modele possible.
// - RAM < 8 Go : categorie "vitesse" (modeles tres legers, CPU uniquement).
// - RAM 8-16 Go sans GPU : categorie "classique" (bon compromis CPU).
// - RAM >= 16 Go sans GPU, ou peu de coeurs : reste en "classique".
// - RAM >= 16 Go avec GPU et au moins 8 coeurs CPU : categorie "raisonnement"
//   (les modeles plus lourds tirent parti du GPU et de plusieurs coeurs).
function chooseCategoryId({ cpuCores, hasGpu, ramGb }) {
  if (ramGb < 8) {
    return "vitesse";
  }

  if (ramGb < 16) {
    return "classique";
  }

  if (hasGpu && cpuCores >= 8) {
    return "raisonnement";
  }

  return "classique";
}

function buildRationale({ cpuCores, hasGpu, gpuModel, ramGb, diskGb }, category) {
  const parts = [
    `${ramGb} Go de RAM`,
    `${cpuCores} coeur${cpuCores > 1 ? "s" : ""} CPU`,
    hasGpu ? `GPU disponible${gpuModel ? ` (${gpuModel})` : ""}` : "pas de GPU dedie"
  ];

  if (Number(diskGb) > 0) {
    parts.push(`${diskGb} Go de stockage disponible`);
  }

  return `D'apres ${parts.join(", ")}, la categorie "${category.label}" (${category.description}) est la mieux adaptee pour ce serveur.`;
}

export function recommendModel({ cpuCores, hasGpu, gpuModel = "", ramGb, diskGb = 0 } = {}) {
  const normalizedCpuCores = Math.max(1, Number(cpuCores) || 1);
  const normalizedRamGb = Math.max(0, Number(ramGb) || 0);
  const normalizedDiskGb = Math.max(0, Number(diskGb) || 0);
  const normalizedHasGpu = Boolean(hasGpu);

  const categoryId = chooseCategoryId({
    cpuCores: normalizedCpuCores,
    hasGpu: normalizedHasGpu,
    ramGb: normalizedRamGb
  });
  const modelCatalog = getModelCatalog();
  const category = modelCatalog.find((entry) => entry.id === categoryId) || modelCatalog[0];
  const recommendedModel = category?.models?.[0] || null;

  if (!recommendedModel) {
    return {
      recommendedModelName: null,
      category: categoryId,
      rationale: "Aucun modele du catalogue ne correspond a cette configuration."
    };
  }

  return {
    recommendedModelName: recommendedModel.name,
    category: categoryId,
    rationale: buildRationale(
      {
        cpuCores: normalizedCpuCores,
        hasGpu: normalizedHasGpu,
        gpuModel,
        ramGb: normalizedRamGb,
        diskGb: normalizedDiskGb
      },
      category
    )
  };
}
