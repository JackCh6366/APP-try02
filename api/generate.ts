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
//   1. YouTube URL → 以純文字把 URL 嵌入 prompt，Gemini 原生識別並分析影音
//      ⚠️ 不可用 fileData.fileUri 傳 YouTube 連結，那是 File API 上傳路徑，
//         直接傳 YouTube URL 會導致 Gemini API 400 INVALID_ARGUMENT 錯誤。
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

    // ── YouTube：以純文字 URL 嵌入 prompt，Gemini 模型原生支援 YouTube 連結理解 ──
    // NOTE: fileData.fileUri 僅適用於 Gemini File API 已上傳的檔案或公開二進位 URL，
    //       不可用於 YouTube 連結，否則 API 回傳 400 Invalid Argument。
    if (isYoutubeUrl(body.videoLink)) {
      return [
        {
          text: `Please analyze the following YouTube video in full detail.\nYouTube URL: ${body.videoLink}\n\nTranscribe and summarize the audio/spoken content as thoroughly as possible.`,
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

  return JSON.parse(rawText);
}

// ─────────────────────────────────────────────────────────────────────────────
// NVIDIA NIM call (text-only; audio/video not supported)
// ─────────────────────────────────────────────────────────────────────────────
async function callNvidia(
  textContent: string,
  systemPrompt: string,
  apiKey: string
): Promise<any> {
  const MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1";
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
  return JSON.parse(cleaned);
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
          return res.status(400).json({
            success: false,
            error: "NVIDIA provider does not support direct YouTube audio. Please use Gemini for YouTube links, or paste the transcript manually.",
          });
        }
        const ctx = await getNonYoutubeLinkContext(body.videoLink);
        textContent = `URL: ${body.videoLink}\n\nPage context:\n${ctx.pageText}\n\nTranscript:\n${ctx.transcript || "(none)"}`;
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
        usedModel: "nvidia/llama-3.3-nemotron-super-49b-v1",
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