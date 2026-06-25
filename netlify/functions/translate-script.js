const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const languageInstructions = {
  zu: "isiZulu",
  af: "Afrikaans",
};

exports.handler = async event => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed. Use POST." });
  }

  if (!GEMINI_API_KEY) {
    return jsonResponse(500, {
      error: "Missing GEMINI_API_KEY environment variable in Netlify.",
    });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { language, segments } = body;

    if (!languageInstructions[language]) {
      return jsonResponse(400, {
        error: "Unsupported language. Use 'zu' for isiZulu or 'af' for Afrikaans.",
      });
    }

    if (!Array.isArray(segments) || segments.length === 0) {
      return jsonResponse(400, {
        error: "Request must include a non-empty segments array.",
      });
    }

    const safeSegments = segments.map(segment => ({
      id: segment.id,
      start: segment.start,
      end: segment.end,
      text: segment.text,
    }));

    const translated = await translateSegments(languageInstructions[language], safeSegments);
    validateTranslatedSegments(safeSegments, translated);

    return jsonResponse(200, translated);
  } catch (error) {
    console.error("Translation function error:", error);
    return jsonResponse(500, {
      error: error.message || "Translation failed.",
    });
  }
};

async function translateSegments(targetLanguage, segments) {
  const prompt = `Translate the following timestamped educational video script into ${targetLanguage}.

Rules:
- Return valid JSON only.
- Return an array only, with no markdown fences and no explanation.
- Keep the exact same number of items.
- Preserve id, start and end exactly.
- Translate only the text field.
- Keep the tone clear, educational and suitable for learners.
- Do not add extra commentary.
- Do not merge, split or reorder segments.

Script JSON:
${JSON.stringify(segments, null, 2)}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini request failed: ${text}`);
  }

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!rawText) {
    throw new Error("Gemini returned an empty response.");
  }

  return parseJsonResponse(rawText);
}

function parseJsonResponse(rawText) {
  const cleaned = rawText
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) {
    throw new Error("Translation response was not a JSON array.");
  }

  return parsed;
}

function validateTranslatedSegments(original, translated) {
  if (!Array.isArray(translated) || translated.length !== original.length) {
    throw new Error("Translated script did not match the original segment count.");
  }

  translated.forEach((segment, index) => {
    const source = original[index];
    const valid =
      segment.id === source.id &&
      segment.start === source.start &&
      segment.end === source.end &&
      typeof segment.text === "string" &&
      segment.text.trim().length > 0;

    if (!valid) {
      throw new Error(`Translated segment ${index + 1} did not preserve id/start/end/text.`);
    }
  });
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}
