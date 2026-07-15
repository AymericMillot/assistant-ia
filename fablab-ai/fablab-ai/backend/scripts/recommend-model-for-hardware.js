// Suggere un modele Ollama a partir du questionnaire materiel saisi pendant
// install.sh (reponses passees par variables d'env). Imprime un JSON sur une
// seule ligne pour rester facile a parser depuis le script shell appelant.
import { recommendModel } from "../services/hardwareRecommendationService.js";

const result = recommendModel({
  cpuCores: Number(process.env.INSTALL_CPU_CORES || 0),
  hasGpu: process.env.INSTALL_HAS_GPU === "1",
  gpuModel: process.env.INSTALL_GPU_MODEL || "",
  ramGb: Number(process.env.INSTALL_RAM_GB || 0),
  diskGb: Number(process.env.INSTALL_DISK_GB || 0)
});

console.log(JSON.stringify(result));
