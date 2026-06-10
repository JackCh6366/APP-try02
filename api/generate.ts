import { GoogleGenAI, Type } from "@google/genai";
import { YoutubeTranscript } from "youtube-transcript";
 
type AIProvider = "gemini" | "nvidia";
type MediaType = "file" | "record" | "transcript_paste" | "link";
 
interface GenerateBody {
  provider?: AIProvider;
  mediaType?: MediaType;
  fileData?: string;
  fileName?: string;
  mimeType?: string;
  textTranscript?: string;
  videoLink?: string;
  options?: {
    depth?: "quick" | "detailed" | "mindmap";
    primaryGoal?: "takeaways" | "actions" | "full-transcript";
    targetLanguages?: string[];
  };
}
 
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "25mb",
    },
  },
};
 
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const NVIDIA_MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1.5";
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
 
function sendJson(res: any, statusCode: number, payload: unknown) {
  res.status(statusCode).json(payload);
}
 
function getYoutubeVideoId(url: string): string | null {
  const match = url.match(
    /^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/|shorts\/)|(?:(?:watch)?\?v(?:i)?=|&v(?:i)?=))([^#&?]*).*/
  );
  return match?.[1]?.length === 11 ? match[1] : null;
}
 
async function getLinkContext(videoLink: string) {
  let pageText = "";
  let transcript = "";
 
  const isYoutube = videoLink.includes("youtube.com") || videoLink.includes("youtu.be");
  if (isYoutube) {
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoLink)}&format=json`;
      const oembedResponse = await fetch(oembedUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (oembedResponse.ok) {
        const data = (await oembedResponse.json()) as { title?: string; author_name?: string };
        pageText += data.title ? `Title: ${data.title}\n` : "";
        pageText += data.author_name ? `Channel: ${data.author_name}\n` : "";
      }
    } catch {
      // Metadata is helpful but optional.
    }
 
    try {
      const videoId = getYoutubeVideoId(videoLink);
      if (videoId) {
        const items = await YoutubeTranscript.fetchTranscript(videoId);
        transcript = items.map((item) => item.text).join(" ");
      }
    } catch {
      // Some videos disable captions; fall back to page metadata.
    }
  }
 
  try {
    const response = await fetch(videoLink, {
      signal: AbortSignal.timeout(6000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
      },
    });
 
    if (response.ok) {
      const html = await response.text();
      const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
      const description =
        html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1]?.trim() ||
        html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1]?.trim();
 
      pageText += title ? `Page title: ${title}\n` : "";
      pageText += description ? `Description: ${description}\n` : "";
    }
  } catch {
    // External pages can block server-side fetches; keep going with what we have.
  }
 
  return { pageText, transcript };
}
 
function buildSystemInstruction(body: GenerateBody) {
  const { depth = "detailed", primaryGoal = "takeaways", targetLanguages = ["zh", "en"] } = body.options || {};
 
  return `You are an elite multilingual media transcriptionist, content analyst, and translator.
 
!!CRITICAL LANGUAGE REQUIREMENT — MUST FOLLOW WITHOUT EXCEPTION!!
- ALL output fields including title, transcript, summaryText, every segment title and summary, every keyConcept, and every actionItem MUST be written EXCLUSIVELY in Traditional Chinese (繁體中文).
- Traditional Chinese uses characters such as: 這、來、國、時、說、們、體、語、為、與、個、會、對、後、發、現、開、過、從、裡
- STRICTLY FORBIDDEN: Do NOT use Simplified Chinese (简体字) characters anywhere. Simplified Chinese uses: 这、来、国、时、说、们、体、语、为、与、个、会、对、后、发、现、开、过、从、里
- Even if the source media is in Mandarin (Simplified Chinese), Cantonese, English, Japanese, or any other language — you MUST still write ALL non-translation fields in Traditional Chinese (繁體中文).
- The translations.zh field must also be written in Traditional Chinese (繁體中文), NOT Simplified Chinese.
- Double-check every character you output. If you are unsure whether a character is Traditional or Simplified, choose the Traditional form.
 
Return only valid JSON that matches this shape:
{
  "title": string,
  "originalLanguage": string,
  "transcript": string,
  "summaryText": string,
  "segments": [{"title": string, "timeRange"?: string, "summary": string}],
  "keyConcepts": string[],
  "actionItems": string[],
  "translations": {"zh"?: string, "en"?: string, "ja"?: string, "ko"?: string}
}
 
Field-by-field language rules (STRICTLY FOLLOW EACH ONE):
- title → 繁體中文 Traditional Chinese only
- originalLanguage → 繁體中文 description of the detected source language (e.g. 英文、日文、韓文、普通話、粵語)
- transcript → 繁體中文 Traditional Chinese only (translate/transcribe the source into Traditional Chinese)
- summaryText → 繁體中文 Traditional Chinese only
- segments[].title → 繁體中文 Traditional Chinese only
- segments[].summary → 繁體中文 Traditional Chinese only
- keyConcepts[] → 繁體中文 Traditional Chinese only
- actionItems[] → 繁體中文 Traditional Chinese only
- translations.zh → 繁體中文 Traditional Chinese polished Markdown (NOT Simplified Chinese)
- translations.en → English polished Markdown
- translations.ja → Japanese (日本語) polished Markdown
- translations.ko → Korean (한국어) polished Markdown
 
Other requirements:
- Depth level: ${depth}.
- Primary goal: ${primaryGoal}.
- Translate the result into these language codes: ${targetLanguages.join(", ")}.
- If timestamps are unavailable, omit timeRange or use logical section labels.
- Do not wrap the JSON in markdown fences.`;
}
 
function buildNvidiaSystemInstruction(body: GenerateBody) {
  return `/no_think
 
${buildSystemInstruction(body)}`;
}
 
const responseSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    originalLanguage: { type: Type.STRING },
    transcript: { type: Type.STRING },
    summaryText: { type: Type.STRING },
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          timeRange: { type: Type.STRING },
          summary: { type: Type.STRING },
        },
        required: ["title", "summary"],
      },
    },
    keyConcepts: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    actionItems: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    translations: {
      type: Type.OBJECT,
      properties: {
        zh: { type: Type.STRING },
        en: { type: Type.STRING },
        ja: { type: Type.STRING },
        ko: { type: Type.STRING },
      },
    },
  },
  required: ["title", "originalLanguage", "transcript", "summaryText", "segments", "keyConcepts", "actionItems", "translations"],
};
 
async function buildGeminiContents(body: GenerateBody) {
  if (body.mediaType === "transcript_paste") {
    if (!body.textTranscript?.trim()) {
      throw new Error("Please provide transcript text.");
    }
    return [{ text: `Analyze this transcript:\n\n${body.textTranscript}` }];
  }
 
  if (body.mediaType === "link") {
    if (!body.videoLink?.trim()) {
      throw new Error("Please provide a valid media URL.");
    }
    const context = await getLinkContext(body.videoLink);
    return [
      {
        text: `Analyze this media link: ${body.videoLink}\n\nPage context:\n${context.pageText || "(none)"}\n\nTranscript or captions:\n${
          context.transcript || "(no captions found; infer cautiously from available page context)"
        }`,
      },
    ];
  }
 
  if (!body.fileData) {
    throw new Error("Please provide media file data.");
  }
 
  return [
    {
      inlineData: {
        mimeType: body.mimeType || "audio/webm",
        data: body.fileData,
      },
    },
    {
      text: `Analyze this uploaded media file. File name: ${body.fileName || "untitled"}.`,
    },
  ];
}
 
async function buildNvidiaPrompt(body: GenerateBody) {
  if (body.mediaType === "file" || body.mediaType === "record") {
    throw new Error("The selected NVIDIA model is a text model. Please use Google Gemini for audio/video uploads, or paste a transcript before selecting NVIDIA.");
  }
 
  if (body.mediaType === "transcript_paste") {
    if (!body.textTranscript?.trim()) {
      throw new Error("Please provide transcript text.");
    }
    return `Analyze this transcript:\n\n${body.textTranscript}`;
  }
 
  if (body.mediaType === "link") {
    if (!body.videoLink?.trim()) {
      throw new Error("Please provide a valid media URL.");
    }
    const context = await getLinkContext(body.videoLink);
    return `Analyze this media link: ${body.videoLink}\n\nPage context:\n${context.pageText || "(none)"}\n\nTranscript or captions:\n${
      context.transcript || "(no captions found; summarize only from available page context)"
    }`;
  }
 
  throw new Error("Please choose an input type.");
}
 
async function generateWithGemini(body: GenerateBody) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }
 
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: await buildGeminiContents(body),
    config: {
      systemInstruction: buildSystemInstruction(body),
      responseMimeType: "application/json",
      responseSchema,
      temperature: 0.2,
    },
  });
 
  if (!response.text) {
    throw new Error("Gemini returned an empty response.");
  }
 
  return {
    result: JSON.parse(response.text.trim()),
    usedModel: GEMINI_MODEL,
  };
}
 
function parseJsonFromModel(content: string) {
  const trimmed = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("The AI response was not valid JSON.");
  }
}
 
async function generateWithNvidia(body: GenerateBody) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error("NVIDIA_API_KEY is not configured.");
  }
 
  const userPrompt = await buildNvidiaPrompt(body);
  const response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages: [
        { role: "system", content: buildNvidiaSystemInstruction(body) },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: 4096,
      stream: false,
      frequency_penalty: 0,
      presence_penalty: 0,
    }),
  });
 
  const responseText = await response.text();
  let data: any = {};
 
  if (responseText.trim()) {
    try {
      data = JSON.parse(responseText);
    } catch {
      data = { raw: responseText };
    }
  }
 
  if (!response.ok) {
    const detail =
      data?.error?.message ||
      data?.message ||
      data?.detail ||
      data?.raw ||
      JSON.stringify(data);
    throw new Error(`NVIDIA API request failed (${response.status} ${response.statusText}): ${detail || "No response body."}`);
  }
 
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("NVIDIA returned an empty response.");
  }
 
  return {
    result: parseJsonFromModel(content),
    usedModel: NVIDIA_MODEL,
  };
}
 
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { success: false, error: "Method not allowed." });
  }
 
  try {
    const body: GenerateBody = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const provider = body.provider || "gemini";
 
    if (provider !== "gemini" && provider !== "nvidia") {
      return sendJson(res, 400, { success: false, error: "Unsupported AI provider." });
    }
 
    const output = provider === "gemini" ? await generateWithGemini(body) : await generateWithNvidia(body);
    return sendJson(res, 200, { success: true, ...output });
  } catch (error: any) {
    return sendJson(res, 500, {
      success: false,
      error: error?.message || "AI generation failed.",
    });
  }
}
 