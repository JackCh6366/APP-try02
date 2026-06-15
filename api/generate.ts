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
    depth?: "quick" | "detailed";
    primaryGoal?: "takeaways" | "actions";
    targetLanguages?: string[];
  };
}
 
export const config = {
  maxDuration: 300, // Vercel Function 最長執行時間（秒）。免費方案上限 60s，Pro 方案可到 300s
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
 
// ─────────────────────────────────────────────────────────────────────────────
// 判斷是否為 YouTube 連結
// ─────────────────────────────────────────────────────────────────────────────
function isYoutubeUrl(url: string): boolean {
  return url.includes("youtube.com") || url.includes("youtu.be");
}
 
// ─────────────────────────────────────────────────────────────────────────────
// 非 YouTube 連結：抓網頁 meta + 字幕（原本邏輯保留給一般網址用）
// ─────────────────────────────────────────────────────────────────────────────
async function getNonYoutubeLinkContext(videoLink: string) {
  let pageText = "";
  let transcript = "";
 
  // 嘗試抓 YouTube transcript（僅在非 Gemini fileData 路徑使用）
  const isYoutube = isYoutubeUrl(videoLink);
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
      // metadata 為輔助資訊，失敗可忽略
    }
 
    try {
      const videoId = getYoutubeVideoId(videoLink);
      if (videoId) {
        const items = await YoutubeTranscript.fetchTranscript(videoId);
        transcript = items.map((item) => item.text).join(" ");
      }
    } catch {
      // 部分影片關閉字幕，fallback 至 metadata
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
    // 外部頁面可能封鎖伺服器端 fetch
  }
 
  return { pageText, transcript };
}
 
function buildSystemInstruction(body: GenerateBody) {
  const { depth = "detailed", primaryGoal = "takeaways", targetLanguages = ["zh", "en"] } = body.options || {};
 
  // 根據 depth 決定產出要求
  const depthInstruction =
    depth === "quick"
      ? "Produce a concise but complete summary. All text fields combined should be at least 3000 Traditional Chinese characters."
      : "Produce an EXTREMELY DETAILED and COMPREHENSIVE analysis. ALL text fields combined MUST reach at least 10000 Traditional Chinese characters. Every segment summary should be at least 300 characters. The summaryText should be at least 800 characters. Each translation should be at least 2000 characters. Do NOT truncate or summarize briefly — expand every point with full context, background, examples and reasoning.";
 
  // 根據 primaryGoal 決定重點方向
  const goalInstruction =
    primaryGoal === "actions"
      ? "Focus on extracting ALL actionable items, decisions, next steps, responsibilities and deadlines mentioned. Each actionItem should be a complete sentence with full context."
      : "Focus on extracting ALL key knowledge points, insights, concepts and takeaways. Each keyConcept should include a brief explanation of why it matters.";
 
  return `You are an elite multilingual media transcriptionist, content analyst, and translator with exceptional attention to detail.
 
!!CRITICAL LANGUAGE REQUIREMENT — MUST FOLLOW WITHOUT EXCEPTION!!
- ALL output fields including title, transcript, summaryText, every segment title and summary, every keyConcept, and every actionItem MUST be written EXCLUSIVELY in Traditional Chinese (繁體中文).
- Traditional Chinese uses characters such as: 這、來、國、時、說、們、體、語、為、與、個、會、對、後、發、現、開、過、從、裡
- STRICTLY FORBIDDEN: Do NOT use Simplified Chinese (简体字) characters anywhere. Simplified Chinese uses: 这、来、国、时、说、们、体、语、为、与、个、会、对、后、发、现、开、过、从、里
- Even if the source media is in Mandarin (Simplified Chinese), Cantonese, English, Japanese, or any other language — you MUST still write ALL non-translation fields in Traditional Chinese (繁體中文).
- The translations.zh field must also be written in Traditional Chinese (繁體中文), NOT Simplified Chinese.
- Double-check every character you output. If you are unsure whether a character is Traditional or Simplified, choose the Traditional form.
 
!!CRITICAL OUTPUT LENGTH REQUIREMENT!!
${depthInstruction}
- segments array MUST contain at least 8 items for detailed depth, each with a thorough summary.
- keyConcepts MUST contain at least 15 items, each being a complete phrase or short explanation (not just a single word).
- actionItems MUST contain at least 10 items if any are present in the content.
- translations for each selected language MUST be complete, polished Markdown with headers, bullet points, and full explanations — NOT a brief summary.
- NEVER cut content short. If you are running long, continue until all fields are complete and thorough.
 
!!CONTENT AVAILABILITY CHECK!!
- If the media content is inaccessible, private, region-locked, or has insufficient information to analyze:
  Set summaryText to exactly: "【內容無法順利取得】此影音連結目前無法正常存取或內容資訊不足，請確認連結是否為公開影片，或嘗試更換其他連結後重新分析。"
  Set transcript to the same error message.
  Set all segment summaries to the same error message.
  Set translations.zh to the same error message in Markdown format.
  Do NOT fabricate or guess content. Do NOT produce placeholder analysis.
 
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
- transcript → 繁體中文 Traditional Chinese only (translate/transcribe the source into Traditional Chinese; must be detailed and complete)
- summaryText → 繁體中文 Traditional Chinese only (comprehensive executive summary, minimum 800 characters)
- segments[].title → 繁體中文 Traditional Chinese only
- segments[].summary → 繁體中文 Traditional Chinese only (each segment minimum 300 characters, include full context)
- keyConcepts[] → 繁體中文 Traditional Chinese only (each item should be a concept name plus brief explanation, not just a word)
- actionItems[] → 繁體中文 Traditional Chinese only (each item should be a complete actionable sentence)
- translations.zh → 繁體中文 Traditional Chinese polished Markdown — full structured report with ## headers, bullet lists, and complete explanations (NOT Simplified Chinese, minimum 2000 characters)
- translations.en → English polished Markdown — full structured report (minimum 2000 characters)
- translations.ja → Japanese (日本語) polished Markdown — full structured report (minimum 2000 characters)
- translations.ko → Korean (한국어) polished Markdown — full structured report (minimum 2000 characters)
 
Output focus:
${goalInstruction}
- Depth level: ${depth}.
- Primary goal: ${primaryGoal}.
- Translate the result into these language codes: ${targetLanguages.join(", ")}.
- If timestamps are available, include them in timeRange. Otherwise use descriptive section labels like "開場介紹"、"核心論點"、"結論".
- Do not wrap the JSON in markdown fences.
- Start your response IMMEDIATELY with { and end with }. No preamble, no explanation, no markdown fences.
- Every field in the JSON shape above MUST be present. Never omit required fields.`;
}
 
function buildNvidiaSystemInstruction(body: GenerateBody) {
  return `/no_think
 
${buildSystemInstruction(body)}
 
!!NVIDIA STRICT JSON RULES — MUST FOLLOW!!
- Output ONLY a single raw JSON object. No markdown fences. No \`\`\`json. No \`\`\`.
- ABSOLUTELY NO comments inside JSON. No // comments. No /* */ comments. JSON does not support comments.
- Do NOT add trailing commas after the last item in any array or object.
- Every string value must be properly escaped. Use \\n for newlines inside strings, never actual line breaks.
- Complete the ENTIRE JSON before stopping. Never truncate mid-string or mid-object.
- If content is very long, shorten individual field values slightly to fit, but ALWAYS close all brackets and braces properly.`;
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
 
// ─────────────────────────────────────────────────────────────────────────────
// buildGeminiContents
// 【主要修改】link 模式分兩條路：
//   1. YouTube URL → 直接用 fileData.fileUri 讓 Gemini 原生讀取影片音訊
//   2. 一般 URL    → 維持原本抓 meta + 字幕的方式
// ─────────────────────────────────────────────────────────────────────────────
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
 
    // ── YouTube：讓 Gemini 直接聽音訊，不靠字幕 ──
    if (isYoutubeUrl(body.videoLink)) {
      return [
        {
          fileData: {
            fileUri: body.videoLink,   // Gemini 原生支援 YouTube URL
            mimeType: "video/mp4",     // YouTube 連結填 video/mp4 即可觸發影音分析
          },
        },
        {
          text: "Please fully transcribe and analyze this video's audio content in detail.",
        },
      ];
    }
 
    // ── 非 YouTube：保留原本 meta + 字幕邏輯 ──
    const context = await getNonYoutubeLinkContext(body.videoLink);
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
 
// ─────────────────────────────────────────────────────────────────────────────
// buildNvidiaPrompt（NVIDIA 不支援 fileData，YouTube 連結改抓字幕 fallback）
// ─────────────────────────────────────────────────────────────────────────────
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
    // NVIDIA 為純文字模型，YouTube 連結也走 meta + 字幕路徑
    const context = await getNonYoutubeLinkContext(body.videoLink);
    return `Analyze this media link: ${body.videoLink}\n\nPage context:\n${context.pageText || "(none)"}\n\nTranscript or captions:\n${
      context.transcript || "(no captions found; summarize only from available page context)"
    }`;
  }
 
  throw new Error("Please choose an input type.");
}
 
// flash-lite 超出範圍時自動升級用此模型
const GEMINI_FALLBACK_MODEL = "gemini-2.5-flash";
 
// 等待 ms 毫秒
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
 
// 判斷是否為 503 / 429 過載錯誤
function isOverloadError(err: any): boolean {
  const msg = JSON.stringify(err?.message ?? err ?? "").toLowerCase();
  return (
    msg.includes("503") ||
    msg.includes("unavailable") ||
    msg.includes("429") ||
    msg.includes("quota") ||
    msg.includes("high demand") ||
    msg.includes("rate limit") ||
    msg.includes("resource_exhausted")
  );
}
 
// 帶自動重試的 Gemini 呼叫（503/429 時最多重試 3 次，間隔 5s / 10s / 20s）
async function callGeminiWithRetry(
  ai: GoogleGenAI,
  model: string,
  body: GenerateBody,
  maxRetries = 3
) {
  const delays = [5000, 10000, 20000];
  let lastErr: any;
 
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callGeminiModel(ai, model, body);
    } catch (err: any) {
      lastErr = err;
      if (isOverloadError(err) && attempt < maxRetries) {
        const wait = delays[attempt] ?? 20000;
        console.warn(
          `[Gemini] API 過載（第 ${attempt + 1} 次），${wait / 1000} 秒後重試...`
        );
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
 
async function callGeminiModel(ai: GoogleGenAI, model: string, body: GenerateBody) {
  const contents = await buildGeminiContents(body);
 
  // fileData（YouTube URL）模式：不使用 responseSchema
  // responseSchema 搭配 fileData 在部分模型版本會導致空回應或格式錯誤
  // 改為在 prompt 內要求 JSON 格式，由 parseJsonFromModel 處理解析
  const isFileDataMode =
    body.mediaType === "link" &&
    body.videoLink &&
    (body.videoLink.includes("youtube.com") || body.videoLink.includes("youtu.be"));
 
  const config = isFileDataMode
    ? {
        systemInstruction: buildSystemInstruction(body),
        // 不設 responseMimeType 和 responseSchema，讓模型自由輸出 JSON
        temperature: 0.2,
        maxOutputTokens: 65536,
      }
    : {
        systemInstruction: buildSystemInstruction(body),
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0.2,
        maxOutputTokens: 65536,
      };
 
  return await ai.models.generateContent({ model, contents, config });
}
 
async function generateWithGemini(body: GenerateBody) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }
 
  const ai = new GoogleGenAI({ apiKey });
 
  // 第一次：用 flash-lite（較快較省）
  let usedModel = GEMINI_MODEL;
  let response = await callGeminiWithRetry(ai, GEMINI_MODEL, body);
 
  // 回應為空：可能是 flash-lite 對 fileData 支援不穩定 → 直接升級重試
  if (!response.text || response.text.trim().length < 10) {
    console.warn(`[Gemini] ${GEMINI_MODEL} 回應為空或過短，自動升級至 ${GEMINI_FALLBACK_MODEL} 重試...`);
    usedModel = GEMINI_FALLBACK_MODEL;
    response = await callGeminiWithRetry(ai, GEMINI_FALLBACK_MODEL, body);
 
    if (!response.text || response.text.trim().length < 10) {
      throw new Error(
        `Gemini 兩個模型都回傳了空回應。可能原因：
` +
        `1. 影片為私人或地區限制
` +
        `2. Gemini API 暫時無法存取此影片
` +
        `3. 請稍後重試，或改用「貼上字幕逐字稿」模式`
      );
    }
  }
 
  // 嘗試解析
  let parsed: any;
  try {
    parsed = JSON.parse(response.text.trim());
  } catch (firstErr: any) {
    const errMsg = firstErr?.message?.toLowerCase() ?? "";
    const isTruncation =
      errMsg.includes("unterminated") ||
      errMsg.includes("unexpected end") ||
      (errMsg.includes("position") && errMsg.includes("json"));
 
    if (isTruncation) {
      // 截斷：若還沒升級過，升級後重試
      if (usedModel !== GEMINI_FALLBACK_MODEL) {
        console.warn(`[Gemini] ${GEMINI_MODEL} 輸出被截斷，自動升級至 ${GEMINI_FALLBACK_MODEL} 重試...`);
        usedModel = GEMINI_FALLBACK_MODEL;
        response = await callGeminiWithRetry(ai, GEMINI_FALLBACK_MODEL, body);
 
        if (!response.text) {
          throw new Error("Gemini fallback model returned an empty response.");
        }
 
        try {
          parsed = JSON.parse(response.text.trim());
        } catch {
          // fallback 也截斷，嘗試自動修復
          parsed = parseJsonFromModel(response.text);
        }
      } else {
        // 已經是 fallback 還截斷，嘗試修復
        parsed = parseJsonFromModel(response.text);
      }
    } else {
      // 非截斷的解析錯誤：印出實際內容幫助診斷，然後嘗試修復
      const preview = response.text.trim().slice(0, 300);
      console.error(`[Gemini] JSON 解析失敗，回應前 300 字：${preview}`);
 
      // 若內容看起來完全不是 JSON（沒有 { 開頭）→ 直接給出明確錯誤
      if (!response.text.trim().startsWith("{") && !response.text.trim().includes("{")) {
        throw new Error(
          `Gemini 回傳了非 JSON 格式的內容（模型：${usedModel}）。` +
          `可能是影片無法存取或內容受限。` +
          `回應開頭：${preview.slice(0, 100)}`
        );
      }
 
      try {
        parsed = parseJsonFromModel(response.text);
      } catch (repairErr: any) {
        throw new Error(
          `AI 回應格式異常，自動修復失敗（模型：${usedModel}）。` +
          `請重試一次，或改用「貼上字幕逐字稿」模式。` +
          `原始錯誤：${firstErr?.message}`
        );
      }
    }
  }
 
  return { result: parsed, usedModel };
}
 
function parseJsonFromModel(content: string) {
  // Step 1: 移除 markdown 代碼塊包裝
  let trimmed = content.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
 
  // Step 2: 移除 NVIDIA 常插入的單行註解 (// ...)
  // 只移除不在字串值內的註解（簡化處理：移除行首或逗號後的 // 註解）
  trimmed = trimmed.replace(/,?\s*\/\/[^\n"]*/g, "");
 
  // Step 3: 嘗試直接解析
  try {
    return JSON.parse(trimmed);
  } catch {
    // Step 4: 找到最外層的 { } 範圍
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
 
    if (start < 0) {
      throw new Error("AI 回應中找不到有效的 JSON 結構，請重試。");
    }
 
    // Step 5: 如果找不到結尾 }，代表被截斷 → 嘗試自動補齊
    if (end <= start) {
      const partial = trimmed.slice(start);
      const repaired = repairTruncatedJson(partial);
      try {
        return JSON.parse(repaired);
      } catch {
        throw new Error("AI 回應內容過長被截斷，且自動修復失敗。請改用「簡短精華大綱」模式，或減少選取的翻譯語系後重試。");
      }
    }
 
    // Step 6: 有頭有尾但還是解析失敗 → 嘗試修復後解析
    const candidate = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      const repaired = repairTruncatedJson(candidate);
      try {
        return JSON.parse(repaired);
      } catch {
        throw new Error("AI 回應格式異常，無法解析為有效 JSON。請重試一次。");
      }
    }
  }
}
 
/**
 * 嘗試修復被截斷的 JSON 字串：
 * - 補上未關閉的字串引號
 * - 補上未關閉的陣列 ]
 * - 補上未關閉的物件 }
 */
function repairTruncatedJson(partial: string): string {
  let s = partial;
 
  // 移除尾端的逗號（trailing comma）
  s = s.replace(/,\s*$/, "");
 
  // 計算未關閉的引號（奇數個 " 代表字串沒關閉）
  const quoteCount = (s.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    s += '"'; // 補上關閉引號
  }
 
  // 計算未關閉的括號層數
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
 
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const prev = i > 0 ? s[i - 1] : "";
    if (ch === '"' && prev !== "\\") inString = !inString;
    if (!inString) {
      if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
      else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth--;
    }
  }
 
  // 補上缺少的關閉括號
  s += "]".repeat(Math.max(0, bracketDepth));
  s += "}".repeat(Math.max(0, braceDepth));
 
  return s;
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
      max_tokens: 100000,  // NVIDIA 模型實際穩定上限，超過易截斷或亂格式
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
    // 將 503 / 429 過載錯誤轉為使用者看得懂的中文提示
    let errorMsg: string = error?.message || "AI 分析失敗，請稍後重試。";
 
    try {
      // 嘗試解析 JSON 格式的錯誤訊息
      const maybeJson = JSON.parse(errorMsg);
      const code = maybeJson?.error?.code ?? maybeJson?.code;
      const status = maybeJson?.error?.status ?? maybeJson?.status ?? "";
      const apiMsg = maybeJson?.error?.message ?? maybeJson?.message ?? "";
 
      if (code === 503 || status === "UNAVAILABLE" || apiMsg.toLowerCase().includes("high demand")) {
        errorMsg =
          "⚠️ Gemini API 目前需求量過高（503 UNAVAILABLE）。" +
          "這是 Google 伺服器端的暫時性問題，與你的連結或影片無關。" +
          "建議：等待 30 秒後重新點擊分析，或切換至 NVIDIA 模型（貼上字幕模式）。";
      } else if (code === 429 || status === "RESOURCE_EXHAUSTED") {
        errorMsg =
          "⚠️ Gemini API 配額已達上限（429 RESOURCE_EXHAUSTED）。" +
          "請稍候幾分鐘後重試，或切換至 NVIDIA 模型。";
      } else if (apiMsg) {
        errorMsg = `Gemini API 錯誤（${code ?? status}）：${apiMsg}`;
      }
    } catch {
      // errorMsg 不是 JSON，維持原始訊息
    }
 
    return sendJson(res, 500, {
      success: false,
      error: errorMsg,
    });
  }
}