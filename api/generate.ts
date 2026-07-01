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

/**
 * 安全解析 AI 回傳的 JSON。
 * 採用五道漸進式修復策略：
 *   1. 直接解析（最佳情況）
 *   2. 清洗控制字元後解析
 *   3. 去除 Markdown 圍欄 + 清洗控制字元
 *   4. 移除尾隨逗號 + 清洗控制字元
 *   5. 擷取第一個 {...} 區塊後再次嘗試以上所有策略
 */
function safeParseJson(raw: string): any {
  // 移除 Markdown 圍欄（```json ... ```）
  const stripFences = (s: string) =>
    s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

  // 移除 JSON 中的尾隨逗號（,} 或 ,]）
  const stripTrailingCommas = (s: string) =>
    s.replace(/,(?:\s*)([\/}\]])/g, "$1");

  const prepare = (s: string) =>
    stripTrailingCommas(sanitizeJsonControlChars(stripFences(s)));

  const candidates = [
    raw,
    sanitizeJsonControlChars(raw),
    prepare(raw),
  ];

  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* 繼續下一個策略 */ }
  }

  // 最後手段：擷取最外層的 {...} 區塊
  const base = prepare(raw);
  const start = base.indexOf("{");
  const end   = base.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = base.slice(start, end + 1);
    try { return JSON.parse(slice); } catch { /* 放棄 */ }
  }

  // 所有策略均失敗，拋出最原始的錯誤以供除錯
  throw new SyntaxError(
    `Failed to parse AI JSON response. Length=${raw.length}. ` +
    `Preview: ${raw.slice(0, 200)}`
  );
}

/**
 * 清洗字幕內容以供 NVIDIA 純文字模型使用。
 * 圖 YouTube 字幕 API 回傳的 SRT 時間第記與序號行，
 * 若不清除會讓模型從 SRT 格式隻返透字逗底，導致回傳 JSON 被截斷。
 * 輸出最多 10,000 字元，避免推理上下文太長導致回傳 JSON 截斷。
 */
function cleanTranscriptForNvidia(raw: string, maxChars = 10_000): string {
  return raw
    // 移除 SRT 時間第記（如 00:00:00,000 --> 00:02:50,000）
    .replace(/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/g, "")
    // 移除純數字的序號行
    .replace(/^\d+\s*$/gm, "")
    // 收縮多餘空行
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    // 切除超長內容
    .slice(0, maxChars);
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

/**
 * 從 YouTube 頁面的 og: meta 標籤擷取影片標題、描述與頻道名稱。
 * 在字幕不可用時提供給純文字模型（NVIDIA）作為基礎分析素材。
 */
async function getYoutubePageMetadata(
  url: string
): Promise<{ title: string; description: string; channel: string }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      },
    });
    if (!res.ok) return { title: "", description: "", channel: "" };

    const html = await res.text();

    const titleMatch =
      html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ||
      html.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch
      ? titleMatch[1].replace(/ - YouTube$/, "").trim()
      : "";

    const descMatch =
      html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i) ||
      html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i);
    const description = descMatch ? descMatch[1].trim() : "";

    const channelMatch =
      html.match(/"ownerChannelName":"([^"]+)"/) ||
      html.match(/"channelName":"([^"]+)"/);
    const channel = channelMatch ? channelMatch[1].trim() : "";

    return { title, description, channel };
  } catch {
    return { title: "", description: "", channel: "" };
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
// System prompt builders
// Gemini 版：要求完整逐字稿（Gemini 能直接讀影音，輸出不受 token 限制影音）
// NVIDIA 版：要求簡潔整理版逐字稿（純文字模型內容已給定，輸出必須控制在 token 限制內）
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt(options: SummaryOptions, provider: "gemini" | "nvidia" = "gemini"): string {
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

  // NVIDIA 限制：transcript 欄位只需輸出整理後的乾淨版本，不可原樣複製輸入的字幕文字
  // 原因：輸入的字幕可能長達數萬字，若原樣複製到 transcript 欄位，加上其他欄位，
  //       整個 JSON 回應會超過 max_tokens，導致 JSON 被截斷而無法解析。
  const transcriptInstruction = provider === "nvidia"
    ? `"transcript": "string — 整理後的乾淨逐字稿（去除時間戳記、合併成自然段落、最多 800 字）"`
    : `"transcript": "string — full verbatim transcription of spoken content (Traditional Chinese preferred if originally in Chinese; otherwise keep original language)"`;

  return `You are an expert multilingual media analyst and transcription specialist.
Your task is to analyze the provided audio/video/transcript content and return a structured JSON response.

Analysis depth: ${options.depth === "quick" ? "Quick summary" : "Detailed analysis"}
${depthInstruction}
${goalInstruction}

You MUST respond with ONLY valid JSON (no markdown fences, no prose), matching this exact schema:
{
  "title": "string — concise title for this content",
  "originalLanguage": "string — detected primary spoken/written language",
  ${transcriptInstruction},
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
  apiKey: string,
  options: SummaryOptions
): Promise<any> {
  const MODEL = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  // ── 結構化輸出 Schema（強制 Gemini 產生合法 JSON，根本解決解析錯誤）──
  // 動態組建 translations 的 properties，避免空物件導致 API 拒絕
  const nonZhLangs = (options.targetLanguages ?? []).filter(l => l !== "zh");
  const translationProps: Record<string, { type: string }> = {};
  for (const lang of nonZhLangs) translationProps[lang] = { type: "STRING" };

  const responseSchema = {
    type: "OBJECT",
    properties: {
      title:            { type: "STRING" },
      originalLanguage: { type: "STRING" },
      transcript:       { type: "STRING" },
      summaryText:      { type: "STRING" },
      segments: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            title:     { type: "STRING" },
            timeRange: { type: "STRING" },
            summary:   { type: "STRING" },
          },
        },
      },
      keyConcepts: { type: "ARRAY", items: { type: "STRING" } },
      actionItems:  { type: "ARRAY", items: { type: "STRING" } },
      translations: {
        type: "OBJECT",
        properties: Object.keys(translationProps).length > 0
          ? translationProps
          : { _placeholder: { type: "STRING" } },
      },
    },
    required: ["title", "originalLanguage", "transcript", "summaryText", "segments", "keyConcepts", "actionItems", "translations"],
  };

  const body = {
    contents: [{ role: "user", parts: contents }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema,
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
      max_tokens: 32768,
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
      const nvidiaSystemPrompt = buildSystemPrompt(options, "nvidia");
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
          // ── YouTube 連結：優先抓官方字幕，失敗時降級使用頁面 metadata ──
          const cleanUrl = cleanYoutubeUrl(body.videoLink.trim());
          let transcriptText = "";

          try {
            const { YoutubeTranscript } = await import("youtube-transcript");
            const segments = await YoutubeTranscript.fetchTranscript(cleanUrl, { lang: "zh-TW" })
              .catch(() => YoutubeTranscript.fetchTranscript(cleanUrl));
            const rawTranscript = segments.map((s: any) => s.text).join(" ");
            if (rawTranscript.trim()) transcriptText = cleanTranscriptForNvidia(rawTranscript);
          } catch {
            // 字幕不可用，將降級使用頁面 metadata
          }

          if (transcriptText) {
            // ── 有字幕：品質最佳路徑，直接送 NVIDIA 分析 ──
            textContent = `YouTube URL: ${cleanUrl}\n\n字幕內容（逐字稿）：\n${transcriptText}`;
          } else {
            // ── 無字幕：NVIDIA 純文字模型無法讀取影音，自動切換 Gemini 分析 ──
            // 讓純文字模型僅憑標題/描述猜測內容，會產生與影片實際內容不符的錯誤資訊。
            // 正確做法：自動 fallback 到 Gemini（能直接讀取 YouTube 音訊），確保結果準確。
            const geminiKey = process.env.GEMINI_API_KEY;
            if (!geminiKey) {
              return res.status(422).json({
                success: false,
                error:
                  "此 YouTube 影片沒有可用字幕，NVIDIA 無法讀取音訊；自動切換 Gemini 時亦發現 GEMINI_API_KEY 未設定。" +
                  "請設定 GEMINI_API_KEY 環境變數，或手動貼上字幕後再使用 NVIDIA 分析。",
              });
            }

            // 直接以 Gemini 分析影片，回傳時標示實際使用的模型
            const geminiContents = await buildGeminiContents({
              ...body,
              videoLink: cleanUrl,
            });
            const geminiResult = await callGemini(geminiContents, systemPrompt, geminiKey, options);
            return res.status(200).json({
              success: true,
              result: geminiResult,
              usedModel: "gemini-2.5-flash (auto-fallback: no transcript available for NVIDIA)",
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

      const result = await callNvidia(textContent, nvidiaSystemPrompt, apiKey);
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
    const result = await callGemini(contents, systemPrompt, apiKey, options);

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