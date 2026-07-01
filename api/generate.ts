// api/generate.ts
// Vercel Serverless Function: AI media analysis handler
// Supports: Google Gemini (direct audio/video), NVIDIA NIM (text)

export const config = {
  api: {
    bodyParser: { sizeLimit: "25mb" },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface SummaryOptions {
  depth: "quick" | "detailed";
  primaryGoal: "takeaways" | "actions";
  targetLanguages: string[];
}

interface GenerateBody {
  provider: "gemini" | "nvidia";
  mediaType: "file" | "record" | "transcript_paste" | "link";
  fileData?: string;       // base64
  fileName?: string;
  mimeType?: string;
  textTranscript?: string;
  videoLink?: string;
  options: SummaryOptions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function isYoutubeUrl(url: string): boolean {
  return /(?:youtube\.com\/(?:watch|shorts|embed)|youtu\.be\/)/.test(url);
}

/**
 * 從任何形式的 YouTube 網址中抽出乾淨的 11 碼影片 ID。
 * 使用者貼上的連結常帶有播放清單（list=、start_radio=）、時間戳記（t=）、
 * 分享追蹤碼（si=）等雜訊參數，這些複合網址會導致：
 *   - Gemini fileData.fileUri 解析失敗 → 400 Invalid Argument
 *   - youtube-transcript 套件抓錯影片或直接抓取失敗
 * 因此一律先正規化成最單純的 https://www.youtube.com/watch?v=VIDEO_ID 格式再使用。
 */
function extractYoutubeVideoId(url: string): string | null {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  return match ? match[1] : null;
}

function cleanYoutubeUrl(url: string): string {
  const id = extractYoutubeVideoId(url);
  return id ? `https://www.youtube.com/watch?v=${id}` : url;
}

/**
 * 修正 AI 模型回應中常見的「JSON 字串欄位內夾帶原始控制字元（如真正換行）」問題。
 * JSON 規範要求字串內的換行/Tab 等控制字元必須跳脫為 \n / \t，但 LLM 常常直接輸出原始字元，
 * 導致 JSON.parse 丟出 "Bad control character in string literal" 錯誤。
 * 這裡用簡單的狀態機掃描：只在「目前位於字串內」時，才把控制字元轉成合法跳脫序列，
 * 字串外的空白/換行（本來就合法）不受影響。
 */
function sanitizeJsonControlChars(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);

    if (inString) {
      if (escaped) {
        result += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        result += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        result += ch;
        continue;
      }
      if (code < 0x20) {
        switch (ch) {
          case "\n": result += "\\n"; break;
          case "\r": result += "\\r"; break;
          case "\t": result += "\\t"; break;
          default: result += "\\u" + code.toString(16).padStart(4, "0");
        }
        continue;
      }
      result += ch;
    } else {
      if (ch === '"') inString = true;
      result += ch;
    }
  }
  return result;
}

/** 安全解析 AI 回傳的 JSON：先清洗控制字元，失敗時再嘗試擷取 {...} 區間重試一次 */
function safeParseJson(raw: string): any {
  const cleaned = sanitizeJsonControlChars(raw);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw err;
  }
}

/** Fetch page text + any caption/transcript hints from a non-YouTube URL */
async function getNonYoutubeLinkContext(
  url: string
): Promise<{ pageText: string; transcript: string }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      },
    });
    if (!res.ok) return { pageText: "", transcript: "" };

    const html = await res.text();

    // Strip tags and collapse whitespace for plain text summary
    const pageText = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3000);

    // Look for embedded transcript blocks (common in podcast / video sites)
    const transcriptMatch =
      html.match(/class="[^"]*transcript[^"]*"[^>]*>([\s\S]{100,5000}?)<\//) ||
      html.match(/"transcript"\s*:\s*"([\s\S]{100,5000}?)"/);
    const transcript = transcriptMatch
      ? transcriptMatch[1]
          .replace(/<[^>]+>/g, " ")
          .replace(/\\n/g, "\n")
          .replace(/\s+/g, " ")
          .trim()
      : "";

    return { pageText, transcript };
  } catch {
    return { pageText: "", transcript: "" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// buildGeminiContents
// link 模式分兩條路：
//   1. YouTube URL → 使用官方 fileData.fileUri 結構化格式，讓 Gemini 真正讀取影片內容
//      （2026/07 修正：先前誤用純文字嵌入 URL，導致模型完全沒有存取影片、憑空生成內容）
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

    // ── YouTube：改用官方正確的 fileData.fileUri 結構化格式 ──
    // 依據 Google 官方文件（ai.google.dev/gemini-api/docs/video-understanding），
    // 這是唯一能讓 Gemini「真正讀取」YouTube 影片內容的方式。
    // ⚠️ 修正說明：先前版本把 YouTube 網址當成純文字塞進 prompt 裡，
    //    這樣 Gemini 完全沒有機會存取影片內容，只會根據文字脈絡憑空生成內容（幻覺），
    //    導致回傳結果與影片實際內容完全不符。正確做法必須用 fileData 欄位傳遞。
    //    最佳實踐：文字提示應放在影片 part 之後（見官方文件 best practices）。
    if (isYoutubeUrl(body.videoLink)) {
      const cleanUrl = cleanYoutubeUrl(body.videoLink.trim());
      return [
        {
          fileData: {
            fileUri: cleanUrl,
            mimeType: "video/*",
          },
        },
        {
          text: `Please analyze this YouTube video in full detail. Transcribe and summarize the audio/spoken content as thoroughly as possible, based on what is actually said and shown in the video.`,
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
// System prompt builder
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt(options: SummaryOptions): string {
  const langMap: Record<string, string> = {
    zh: "Traditional Chinese (繁體中文)",
    en: "English",
    ja: "Japanese (日本語)",
    ko: "Korean (한국어)",
  };
  const langList = options.targetLanguages.map((l) => langMap[l] || l).join(", ");

  const depthInstruction =
    options.depth === "quick"
      ? "Keep sections concise — 2-4 bullet points max per section."
      : "Be thorough and comprehensive — include all important details, context, and nuance.";

  const goalInstruction =
    options.primaryGoal === "actions"
      ? "Pay special attention to action items, decisions, tasks, and commitments mentioned."
      : "Focus on key takeaways, insights, and the most important concepts.";

  return `You are an expert multilingual media analyst and transcription specialist.
Your task is to analyze the provided audio/video/transcript content and return a structured JSON response.

Analysis depth: ${options.depth === "quick" ? "Quick summary" : "Detailed analysis"}
${depthInstruction}
${goalInstruction}

You MUST respond with ONLY valid JSON (no markdown fences, no prose), matching this exact schema:
{
  "title": "string — concise title for this content",
  "originalLanguage": "string — detected primary spoken/written language",
  "transcript": "string — full verbatim transcription of spoken content (Traditional Chinese preferred if originally in Chinese; otherwise keep original language)",
  "summaryText": "string — comprehensive summary in Traditional Chinese (繁體中文)",
  "segments": [
    {
      "title": "string — section heading",
      "timeRange": "string or null — e.g. '00:00 - 05:30'",
      "summary": "string — paragraph summary of this segment"
    }
  ],
  "keyConcepts": ["string", "..."],
  "actionItems": ["string", "..."],
  "translations": {
    ${options.targetLanguages.filter((l) => l !== "zh").map((l) => `"${l}": "string — full formatted Markdown summary in ${langMap[l] || l}"`).join(",\n    ")}
  }
}

Target translation languages: ${langList}
If translation for a language is not requested, omit that key from translations.
Always include the Traditional Chinese summary in "summaryText".`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini API call (native fetch, no SDK — Vercel-safe)
// ─────────────────────────────────────────────────────────────────────────────
async function callGemini(
  contents: any[],
  systemPrompt: string,
  apiKey: string
): Promise<any> {
  const MODEL = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ role: "user", parts: contents }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(280_000),
  });

  const json = await res.json() as any;

  if (!res.ok) {
    throw new Error(
      `Gemini API error ${res.status}: ${json?.error?.message || JSON.stringify(json)}`
    );
  }

  const rawText: string =
    json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  if (!rawText) {
    const finishReason = json?.candidates?.[0]?.finishReason;
    throw new Error(
      `Gemini returned an empty response (finishReason: ${finishReason ?? "unknown"}). The video may be private, age-restricted, or the content could not be processed.`
    );
  }

  return safeParseJson(rawText);
}

// ─────────────────────────────────────────────────────────────────────────────
// NVIDIA NIM call (text-only; audio/video not supported)
// ─────────────────────────────────────────────────────────────────────────────
async function callNvidia(
  textContent: string,
  systemPrompt: string,
  apiKey: string
): Promise<any> {
  const MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1.5";
  const url = "https://integrate.api.nvidia.com/v1/chat/completions";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: textContent },
      ],
      temperature: 0.2,
      max_tokens: 8192,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const json = await res.json() as any;

  if (!res.ok) {
    throw new Error(
      `NVIDIA API error ${res.status}: ${json?.detail || json?.message || JSON.stringify(json)}`
    );
  }

  const rawText: string = json?.choices?.[0]?.message?.content ?? "";

  // Strip possible markdown fences
  const cleaned = rawText.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "").trim();
  return safeParseJson(cleaned);
}

// ─────────────────────────────────────────────────────────────────────────────
// Vercel handler
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  let body: GenerateBody;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ success: false, error: "Invalid JSON body." });
  }

  const { provider = "gemini", options } = body;

  try {
    const systemPrompt = buildSystemPrompt(options);

    // ── NVIDIA path (text-only) ──
    if (provider === "nvidia") {
      const apiKey = process.env.NVIDIA_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ success: false, error: "NVIDIA_API_KEY not configured." });
      }

      // Collapse content to plain text for NVIDIA
      let textContent = "";
      if (body.mediaType === "transcript_paste") {
        textContent = body.textTranscript || "";
      } else if (body.mediaType === "link") {
        if (!body.videoLink?.trim()) throw new Error("Please provide a valid media URL.");
        if (isYoutubeUrl(body.videoLink)) {
          // ── YouTube 連結：先清洗網址，抓字幕後轉純文字送給 NVIDIA LLM 分析 ──
          const cleanUrl = cleanYoutubeUrl(body.videoLink.trim());
          try {
            const { YoutubeTranscript } = await import("youtube-transcript");
            const segments = await YoutubeTranscript.fetchTranscript(cleanUrl, { lang: "zh-TW" })
              .catch(() => YoutubeTranscript.fetchTranscript(cleanUrl));
            const rawTranscript = segments.map((s: any) => s.text).join(" ");
            if (!rawTranscript.trim()) {
              throw new Error("empty transcript");
            }
            textContent = `YouTube URL: ${cleanUrl}\n\n字幕內容（逐字稿）：\n${rawTranscript}`;
          } catch {
            // ⚠️ 修正說明：先前版本在抓不到字幕時，會讓純文字模型「只憑網址瞎猜內容」，
            //    這樣產生的結果與影片實際內容毫無關聯（幻覺）。現在改為明確報錯，
            //    誠實告知使用者這支影片無法用 NVIDIA 分析，請改用 Gemini（可直接讀取影音）。
            return res.status(422).json({
              success: false,
              error:
                "此 YouTube 影片沒有可用的官方字幕（或字幕擷取失敗），NVIDIA 為純文字模型、無法直接讀取音訊，因此無法分析此影片。請改用 Google Gemini 直接分析影音內容。",
            });
          }
        } else {
          const ctx = await getNonYoutubeLinkContext(body.videoLink);
          textContent = `URL: ${body.videoLink}\n\nPage context:\n${ctx.pageText}\n\nTranscript:\n${ctx.transcript || "(none)"}`;
        }
      } else {
        return res.status(400).json({
          success: false,
          error: "NVIDIA provider only supports transcript paste or non-YouTube links. For audio/video files, please use Gemini.",
        });
      }

      const result = await callNvidia(textContent, systemPrompt, apiKey);
      return res.status(200).json({
        success: true,
        result,
        usedModel: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
      });
    }

    // ── Gemini path (audio, video, YouTube, transcript) ──
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, error: "GEMINI_API_KEY not configured." });
    }

    const contents = await buildGeminiContents(body);
    const result = await callGemini(contents, systemPrompt, apiKey);

    return res.status(200).json({
      success: true,
      result,
      usedModel: "gemini-2.5-flash",
    });

  } catch (err: any) {
    console.error("[generate] Error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Internal server error.",
    });
  }
}