const video = document.querySelector("#lessonVideo");
const languageSelect = document.querySelector("#languageSelect");
const prepareButton = document.querySelector("#prepareButton");
const pauseToggle = document.querySelector("#pauseToggle");
const statusText = document.querySelector("#statusText");
const captionText = document.querySelector("#captionText");

const SCRIPT_URL = "/public/scripts/segmentation-script.json";
const TRANSLATE_ENDPOINT = "/.netlify/functions/translate-script";

const languageLabels = {
  en: "English",
  zu: "isiZulu",
  af: "Afrikaans",
};

const speechLangs = {
  en: "en-ZA",
  zu: "zu-ZA",
  af: "af-ZA",
};

let englishScript = [];
let activeScript = [];
let selectedLanguage = "en";
let currentSegmentId = null;
let isSpeaking = false;
let pauseUntilSpeechEnds = false;
let preparedLanguages = new Map();
let availableVoices = [];

init();

async function init() {
  setStatus("Loading English script...");
  try {
    englishScript = await fetchJson(SCRIPT_URL);
    activeScript = englishScript;
    preparedLanguages.set("en", englishScript);
    loadVoices();
    setStatus("English script loaded. Choose a language and prepare narration.");
  } catch (error) {
    console.error(error);
    setStatus("Could not load the script JSON. Check public/scripts/segmentation-script.json.");
  }
}

prepareButton.addEventListener("click", prepareSelectedLanguage);
languageSelect.addEventListener("change", () => {
  selectedLanguage = languageSelect.value;
  currentSegmentId = null;
  captionText.textContent = "Prepare the selected language, then play the video.";
  video.muted = selectedLanguage !== "en";
  window.speechSynthesis.cancel();
  isSpeaking = false;
  pauseUntilSpeechEnds = false;
});

video.addEventListener("play", () => {
  if (!activeScript.length) {
    setStatus("The script is not ready yet. Prepare a language first.");
    video.pause();
    return;
  }

  video.muted = selectedLanguage !== "en";
});

video.addEventListener("pause", () => {
  if (!pauseUntilSpeechEnds) {
    window.speechSynthesis.cancel();
    isSpeaking = false;
  }
});

video.addEventListener("seeked", () => {
  currentSegmentId = null;
  window.speechSynthesis.cancel();
  isSpeaking = false;
  pauseUntilSpeechEnds = false;
  updateCaptionForCurrentTime();
});

video.addEventListener("ended", () => {
  window.speechSynthesis.cancel();
  currentSegmentId = null;
  isSpeaking = false;
  pauseUntilSpeechEnds = false;
  captionText.textContent = "Video ended.";
});

video.addEventListener("timeupdate", () => {
  if (!activeScript.length) return;

  const segment = getCurrentSegment(video.currentTime);
  if (!segment) return;

  captionText.textContent = segment.text;

  if (segment.id !== currentSegmentId) {
    currentSegmentId = segment.id;

    if (selectedLanguage !== "en") {
      speakSegment(segment);
    }
  }

  const shouldPauseToCatchUp =
    selectedLanguage !== "en" &&
    pauseToggle.checked &&
    isSpeaking &&
    video.currentTime >= segment.end - 0.25;

  if (shouldPauseToCatchUp && !video.paused) {
    pauseUntilSpeechEnds = true;
    video.pause();
  }
});

async function prepareSelectedLanguage() {
  selectedLanguage = languageSelect.value;
  prepareButton.disabled = true;
  window.speechSynthesis.cancel();
  isSpeaking = false;
  pauseUntilSpeechEnds = false;
  currentSegmentId = null;

  try {
    if (selectedLanguage === "en") {
      activeScript = englishScript;
      video.muted = false;
      setStatus("English ready. Original video audio will play.");
      updateCaptionForCurrentTime();
      return;
    }

    video.muted = true;

    if (preparedLanguages.has(selectedLanguage)) {
      activeScript = preparedLanguages.get(selectedLanguage);
      setStatus(`${languageLabels[selectedLanguage]} loaded from this browser session. Video audio is muted.`);
      updateCaptionForCurrentTime();
      warnIfVoiceMissing(selectedLanguage);
      return;
    }

    setStatus(`Translating script into ${languageLabels[selectedLanguage]}...`);

    const translatedScript = await fetchJson(TRANSLATE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        language: selectedLanguage,
        languageLabel: languageLabels[selectedLanguage],
        segments: englishScript,
      }),
    });

    validateTranslatedScript(translatedScript);
    preparedLanguages.set(selectedLanguage, translatedScript);
    activeScript = translatedScript;
    setStatus(`${languageLabels[selectedLanguage]} ready. Video audio is muted and translated narration will play.`);
    updateCaptionForCurrentTime();
    warnIfVoiceMissing(selectedLanguage);
  } catch (error) {
    console.error(error);
    activeScript = englishScript;
    setStatus(`Translation failed: ${error.message}. Falling back to English captions.`);
  } finally {
    prepareButton.disabled = false;
  }
}

function speakSegment(segment) {
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(segment.text);
  utterance.lang = speechLangs[selectedLanguage] || "en-ZA";

  const voice = findBestVoice(selectedLanguage);
  if (voice) {
    utterance.voice = voice;
  }

  utterance.rate = 0.95;
  utterance.pitch = 1;

  isSpeaking = true;

  utterance.onend = () => {
    isSpeaking = false;

    if (pauseUntilSpeechEnds) {
      pauseUntilSpeechEnds = false;
      video.play().catch(() => {
        setStatus("Narration finished. Press play to continue.");
      });
    }
  };

  utterance.onerror = event => {
    console.warn("Speech synthesis error", event);
    isSpeaking = false;
    pauseUntilSpeechEnds = false;
    setStatus("Could not play narration on this browser. Captions are still available.");
  };

  window.speechSynthesis.speak(utterance);
}

function getCurrentSegment(currentTime) {
  return activeScript.find(segment => currentTime >= segment.start && currentTime < segment.end);
}

function updateCaptionForCurrentTime() {
  const segment = getCurrentSegment(video.currentTime);
  captionText.textContent = segment ? segment.text : "Captions will appear here while the video plays.";
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with status ${response.status}`);
  }

  return response.json();
}

function validateTranslatedScript(script) {
  if (!Array.isArray(script)) {
    throw new Error("Translation response was not an array.");
  }

  if (script.length !== englishScript.length) {
    throw new Error("Translation did not return the same number of segments.");
  }

  script.forEach((segment, index) => {
    const original = englishScript[index];
    const isValid =
      segment.id === original.id &&
      segment.start === original.start &&
      segment.end === original.end &&
      typeof segment.text === "string" &&
      segment.text.trim().length > 0;

    if (!isValid) {
      throw new Error(`Translation segment ${index + 1} did not preserve the required structure.`);
    }
  });
}

function setStatus(message) {
  statusText.textContent = message;
}

function loadVoices() {
  availableVoices = window.speechSynthesis.getVoices();

  window.speechSynthesis.onvoiceschanged = () => {
    availableVoices = window.speechSynthesis.getVoices();
  };
}

function findBestVoice(languageCode) {
  const targetLang = speechLangs[languageCode];
  if (!targetLang) return null;

  return (
    availableVoices.find(voice => voice.lang === targetLang) ||
    availableVoices.find(voice => voice.lang?.toLowerCase().startsWith(languageCode)) ||
    null
  );
}

function warnIfVoiceMissing(languageCode) {
  const voice = findBestVoice(languageCode);
  if (!voice) {
    setStatus(
      `${languageLabels[languageCode]} translation is ready. No matching ${languageLabels[languageCode]} browser voice was found on this device, so narration may use a fallback voice. Captions will still work.`
    );
  }
}
