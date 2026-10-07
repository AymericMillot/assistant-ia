// Lecture vocale et dictee via les API du navigateur (aucun serveur ajoute).
// Attention : selon le navigateur, la dictee peut transiter par un service de
// reconnaissance en ligne (Chrome, Edge) ; c'est signale a l'utilisateur.

function getRecognitionConstructor() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function isSpeechSynthesisSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

export function isDictationSupported() {
  // Le micro n'est accessible que sur une page securisee (https ou localhost).
  return Boolean(getRecognitionConstructor()) && window.isSecureContext;
}

export function toSpeakableText(text) {
  return String(text || "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^[-*•]\s+/gm, "")
    .replace(/^#+\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function pickFrenchVoice() {
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((voice) => voice.lang === "fr-FR" && voice.localService) ||
    voices.find((voice) => voice.lang?.toLowerCase().startsWith("fr")) ||
    null
  );
}

export function speak(text, { onEnd } = {}) {
  if (!isSpeechSynthesisSupported()) {
    return false;
  }

  window.speechSynthesis.cancel();
  const utterance = new window.SpeechSynthesisUtterance(toSpeakableText(text));
  utterance.lang = "fr-FR";
  const voice = pickFrenchVoice();
  if (voice) {
    utterance.voice = voice;
  }
  utterance.onend = () => onEnd?.();
  utterance.onerror = () => onEnd?.();
  window.speechSynthesis.speak(utterance);
  return true;
}

export function stopSpeaking() {
  if (isSpeechSynthesisSupported()) {
    window.speechSynthesis.cancel();
  }
}

/**
 * Demarre une dictee en francais. `onText(texteFinal, texteProvisoire)` est
 * appele a chaque resultat ; renvoie une fonction d'arret.
 */
export function startDictation({ onText, onEnd, onError }) {
  const Recognition = getRecognitionConstructor();
  if (!Recognition) {
    onError?.("La dictée vocale n'est pas disponible dans ce navigateur.");
    return () => {};
  }

  const recognition = new Recognition();
  recognition.lang = "fr-FR";
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  let finalText = "";
  recognition.onresult = (event) => {
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal) {
        finalText += result[0].transcript;
      } else {
        interim += result[0].transcript;
      }
    }
    onText?.(finalText, interim);
  };
  recognition.onerror = (event) => {
    const messages = {
      "not-allowed": "Accès au micro refusé. Autorisez-le dans les réglages du navigateur.",
      "service-not-allowed": "Accès au micro refusé. Autorisez-le dans les réglages du navigateur.",
      "no-speech": "Aucune parole détectée. Réessayez en parlant près du micro.",
      network: "La dictée nécessite une connexion au service de reconnaissance du navigateur."
    };
    onError?.(messages[event.error] || "La dictée vocale a échoué.");
  };
  recognition.onend = () => onEnd?.(finalText);

  try {
    recognition.start();
  } catch {
    onError?.("Impossible de démarrer la dictée vocale.");
    onEnd?.("");
  }

  return () => {
    try {
      recognition.stop();
    } catch {
      // Deja arretee.
    }
  };
}
