/**
 * Catalogue de suggestions de modèles Ollama, servi par l'API admin.
 *
 * Ce fichier est la seule source de vérité du catalogue : le frontend ne
 * contient plus de liste codée en dur. L'état « installé / actif » est
 * toujours lu en direct depuis Ollama ; ce catalogue ne sert qu'à proposer
 * des téléchargements. Pour l'ajuster, modifier ce fichier puis redémarrer
 * le backend (aucun rebuild du frontend nécessaire).
 */
import fs from "fs";
import path from "path";

const rawModelCatalog = [
  {
    id: "vitesse",
    label: "Vitesse",
    description: "Modèles légers pour une réponse rapide sur CPU.",
    models: [
      {
        name: "llama3.2:1b",
        label: "Llama 3.2 1B",
        size: "Très léger",
        description: "Idéal pour les tests rapides et les machines modestes."
      },
      {
        name: "qwen2.5:1.5b",
        label: "Qwen 2.5 1.5B",
        size: "Léger",
        description: "Rapide tout en restant agréable pour du question-réponse."
      },
      {
        name: "smollm2:1.7b",
        label: "SmolLM2 1.7B",
        size: "Léger",
        description: "Compact et réactif pour un assistant local très sobre."
      },
      {
        name: "gemma4:latest",
        label: "Gemma 4",
        size: "Récent",
        description: "Modèle principal recommandé pour le projet et l'usage documentaire."
      },
      {
        name: "phi3:mini",
        label: "Phi 3 Mini",
        size: "Léger",
        description: "Très fluide, souvent efficace pour les demandes courtes."
      },
      {
        name: "exaone3.5:2.4b",
        label: "EXAONE 3.5 2.4B",
        size: "Compact",
        description: "Alternative légère pour varier le comportement du chat."
      }
    ]
  },
  {
    id: "classique",
    label: "Classique",
    description: "Modèles polyvalents pour l'usage général et documentaire.",
    models: [
      {
        name: "mistral:latest",
        label: "Mistral",
        size: "Équilibré",
        description: "Très bon compromis entre qualité, vitesse et simplicité."
      },
      {
        name: "mistral:7b-instruct",
        label: "Mistral 7B Instruct",
        size: "Équilibré",
        description: "Version instruct plus stable pour les réponses utiles au quotidien."
      },
      {
        name: "llama3.2:3b",
        label: "Llama 3.2 3B",
        size: "Équilibré",
        description: "Bon choix pour un assistant local simple et rapide."
      },
      {
        name: "qwen2.5:3b",
        label: "Qwen 2.5 3B",
        size: "Équilibré",
        description: "Souvent très bon en français et en recherche documentaire."
      },
      {
        name: "phi4-mini:latest",
        label: "Phi 4 Mini",
        size: "Compact récent",
        description: "Modèle récent, efficace pour de nombreux usages généraux."
      },
      {
        name: "gemma3:4b",
        label: "Gemma 3 4B",
        size: "Équilibré",
        description: "Bonne option intermédiaire pour une qualité plus confortable."
      }
    ]
  },
  {
    id: "raisonnement",
    label: "Raisonnement",
    description: "Modèles plus adaptés aux explications structurées et au raisonnement.",
    models: [
      {
        name: "deepseek-r1:1.5b",
        label: "DeepSeek R1 1.5B",
        size: "Léger",
        description: "Porte d'entrée légère vers des réponses plus structurées."
      },
      {
        name: "deepseek-r1:7b",
        label: "DeepSeek R1 7B",
        size: "Puissant",
        description: "Solide pour l'explication pas à pas et le raisonnement local."
      },
      {
        name: "qwen2.5:7b",
        label: "Qwen 2.5 7B",
        size: "Puissant",
        description: "Bonne tenue sur les questions longues et détaillées."
      },
      {
        name: "qwq:32b",
        label: "QwQ 32B",
        size: "Très lourd",
        description: "Raisonnement ambitieux, à réserver aux machines très patientes."
      },
      {
        name: "deepseek-r1:14b",
        label: "DeepSeek R1 14B",
        size: "Lourd",
        description: "Version plus ambitieuse pour privilégier la profondeur."
      }
    ]
  },
  {
    id: "vision",
    label: "Multimodal",
    description: "Modèles à garder sous la main pour l'image ou des usages hybrides.",
    models: [
      {
        name: "llava:7b",
        label: "LLaVA 7B",
        size: "Vision",
        description: "Utile pour travailler plus tard avec des images."
      },
      {
        name: "llama3.2-vision:11b",
        label: "Llama 3.2 Vision 11B",
        size: "Vision",
        description: "Modèle plus riche pour traiter texte et image."
      },
      {
        name: "moondream:latest",
        label: "Moondream",
        size: "Vision léger",
        description: "Option compacte pour les usages visuels."
      }
    ]
  }
];

// Categorie -> role fonctionnel utilise pour la selection multi-modeles
// (texte / image / raisonnement). Derive de l'id de categorie plutot que
// repete sur chaque modele.
const categoryRoleHints = {
  vitesse: "text",
  classique: "text",
  raisonnement: "reasoning",
  vision: "image"
};

// Detection du fournisseur a partir du nom du modele, pour afficher un
// marqueur (ex. drapeau francais pour Mistral) sans dupliquer l'info.
const providerNamePatterns = [
  ["mistral", /^(mistral|mixtral|codestral|ministral|devstral|pixtral|magistral)/i],
  ["meta", /^llama/i],
  ["google", /^gemma/i],
  ["microsoft", /^phi/i],
  ["alibaba", /^qwen|^qwq/i],
  ["deepseek", /^deepseek/i],
  ["lg", /^exaone/i]
];

export function detectProvider(modelName) {
  const match = providerNamePatterns.find(([, pattern]) => pattern.test(modelName));
  return match ? match[0] : "other";
}

function enrichCatalog(catalog) {
  return catalog.map((category) => ({
    ...category,
    models: category.models.map((model) => ({
      ...model,
      roleHint: model.roleHint || categoryRoleHints[category.id] || "text",
      provider: model.provider || detectProvider(model.name)
    }))
  }));
}

function isValidCatalogShape(candidate) {
  return (
    Array.isArray(candidate) &&
    candidate.length > 0 &&
    candidate.every(
      (category) =>
        category &&
        typeof category.id === "string" &&
        Array.isArray(category.models) &&
        category.models.every((model) => model && typeof model.name === "string")
    )
  );
}

// Catalogue statique embarque dans le depot : filet de securite ultime, toujours
// disponible meme sans acces reseau ou si le cache d'actualisation est absent/corrompu.
export const staticModelCatalog = enrichCatalog(rawModelCatalog);

/**
 * Catalogue effectif : lit le cache d'actualisation hebdomadaire s'il existe et est
 * valide (voir modelCatalogRefreshService.js), sinon retombe sur le catalogue
 * statique. Relu a chaque appel (fichier local, cout negligeable) pour que
 * l'admin voie un rafraichissement sans redemarrer le backend.
 */
export function getModelCatalog() {
  try {
    const cachePath = path.resolve(process.cwd(), "data/model-catalog-cache.json");
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (isValidCatalogShape(parsed)) {
      return enrichCatalog(parsed);
    }
  } catch {
    // Cache absent, illisible ou invalide : on utilise le catalogue statique.
  }

  return staticModelCatalog;
}

// Conserve pour compatibilite : valeur figee au chargement du module.
// Preferer getModelCatalog() pour beneficier des actualisations sans redemarrage.
export const modelCatalog = staticModelCatalog;
