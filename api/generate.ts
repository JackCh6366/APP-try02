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
 * 徹底修復並擷取 JSON 區塊。
 * 能處理以下問題：
 *   1. 前後夾帶 Markdown 標記 (如 ```json ... ```) 或其他無關文字。
 *   2. 字串欄位內夾帶未跳脫的原始雙引號 (如 "leapfrog and "snake crawling," which...")。
 *   3. 字串欄位內夾帶原始換行符號 (如 \n, \r, \t)。
 * 透過括號深度計數（brace count）與語意環境（Normal/Key/Value/Array）掃描，安全找出第一個完整 JSON 區塊。
 */
function repairAndExtractJson(raw: string): string {
  const start = raw.indexOf('{');
  if (start === -1) return raw;

  let result = "";
  let state: "NORMAL" | "STRING_KEY" | "STRING_VALUE" | "STRING_ARRAY_VALUE" = "NORMAL";
  let arrayDepth = 0;
  let objectDepth = 0;
  const contextStack: ("OBJECT" | "ARRAY")[] = [];
  
  let lastKeyStartIndex = -1;

  function peekNextNonWhitespace(str: string, startIndex: number) {
    for (let i = startIndex; i < str.length; i++) {
      if (!/\s/.test(str[i])) {
        return { char: str[i], index: i };
      }
    }
    return { char: null as string | null, index: -1 };
  }

  function isValidClosingQuote(str: string, index: number, currentContext: "OBJECT" | "ARRAY") {
    const next = peekNextNonWhitespace(str, index + 1);
    if (!next.char) return true; // 截斷在引號處，視為合法的結束引號

    if (currentContext === "OBJECT") {
      if (next.char === '}') return true;
      if (next.char === ',') {
        const afterComma = peekNextNonWhitespace(str, next.index + 1);
        return afterComma.char === null || afterComma.char === '"' || afterComma.char === '}';
      }
    } else if (currentContext === "ARRAY") {
      if (next.char === ']') return true;
      if (next.char === ',') {
        const afterComma = peekNextNonWhitespace(str, next.index + 1);
        return afterComma.char === null || afterComma.char === '"' || afterComma.char === '{' || afterComma.char === ']';
      }
    }
    return false;
  }

  let i = start;
  let expectValue = false;

  while (i < raw.length) {
    const char = raw[i];

    if (state === "NORMAL") {
      if (char === '{') {
        objectDepth++;
        contextStack.push("OBJECT");
        result += char;
        expectValue = false;
      } else if (char === '}') {
        objectDepth--;
        contextStack.pop();
        result += char;
        expectValue = false;
        if (objectDepth === 0 && arrayDepth === 0) {
          return result;
        }
      } else if (char === '[') {
        arrayDepth++;
        contextStack.push("ARRAY");
        result += char;
        expectValue = true;
      } else if (char === ']') {
        arrayDepth--;
        contextStack.pop();
        result += char;
        expectValue = false;
        if (objectDepth === 0 && arrayDepth === 0) {
          return result;
        }
      } else if (char === ':') {
        result += char;
        expectValue = true;
      } else if (char === ',') {
        result += char;
        if (contextStack[contextStack.length - 1] === "ARRAY") {
          expectValue = true;
        } else {
          expectValue = false;
        }
      } else if (char === '"') {
        const currentContext = contextStack[contextStack.length - 1];
        if (currentContext === "OBJECT" && !expectValue) {
          state = "STRING_KEY";
          lastKeyStartIndex = result.length;
          result += char;
        } else if (currentContext === "OBJECT" && expectValue) {
          state = "STRING_VALUE";
          result += char;
        } else if (currentContext === "ARRAY" && expectValue) {
          state = "STRING_ARRAY_VALUE";
          result += char;
        } else {
          state = "STRING_VALUE";
          result += char;
        }
      } else {
        result += char;
      }
    } else if (state === "STRING_KEY") {
      if (char === '"') {
        state = "NORMAL";
      }
      result += char;
    } else if (state === "STRING_VALUE" || state === "STRING_ARRAY_VALUE") {
      const currentContext = state === "STRING_VALUE" ? "OBJECT" : "ARRAY";

      if (char === '\\') {
        if (i + 1 >= raw.length) {
          // 截斷在反斜線處
          result += '\\\\';
          i++;
          continue;
        }
        result += char;
        result += raw[i + 1];
        i++;
      } else if (char === '"') {
        if (isValidClosingQuote(raw, i, currentContext)) {
          state = "NORMAL";
          expectValue = false;
          result += char;
        } else {
          result += '\\"';
        }
      } else if (char === '\n') {
        result += '\\n';
      } else if (char === '\r') {
        result += '\\r';
      } else if (char === '\t') {
        result += '\\t';
      } else {
        result += char;
      }
    }

    i++;
  }

  // ─── 處理截斷恢復 (Truncation Recovery) ───
  if (objectDepth > 0 || arrayDepth > 0) {
    console.warn(
      `[JSON 修復] 偵測到 JSON 被截斷。原始長度: ${raw.length}, ` +
      `當前狀態: ${state}, 物件深度: ${objectDepth}, 陣列深度: ${arrayDepth}`
    );

    if (state === "STRING_KEY") {
      // 截斷在鍵值名稱中，丟棄未完成的 Key
      if (lastKeyStartIndex >= 0) {
        result = result.slice(0, lastKeyStartIndex);
      }
      result = result.trim().replace(/,$/, "");
      state = "NORMAL";
    } else if (state === "STRING_VALUE" || state === "STRING_ARRAY_VALUE") {
      // 截斷在字串值中，補上閉合引號
      result += '"';
      state = "NORMAL";
    }

    // 移除尾隨逗號
    result = result.trim().replace(/,$/, "");

    // 依據 contextStack 逆向閉合所有未完成的括號
    while (contextStack.length > 0) {
      const ctx = contextStack.pop();
      if (ctx === "OBJECT") {
        result += '}';
      } else if (ctx === "ARRAY") {
        result += ']';
      }
    }
  }

  return result;
}

/**
 * 安全解析 AI 回傳的 JSON。
 * 採用六道漸進式修復策略：
 *   1. 執行 repairAndExtractJson 進行深層括號與字串修復後解析（最佳、最穩健路徑）
 *   2. 直接解析原始字串
 *   3. 清洗控制字元後解析
 *   4. 去除 Markdown 圍欄 + 清洗控制字元
 *   5. 移除尾隨逗號 + 清洗控制字元
 *   6. 擷取第一個 {...} 區塊後再次嘗試以上所有策略
 */
function safeParseJson(raw: string): any {
  // 優先嘗試最先進的 repairAndExtractJson 進行修復
  try {
    const repaired = repairAndExtractJson(raw);
    return JSON.parse(repaired);
  } catch {
    /* 繼續傳統 fallback 策略 */
  }

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
function cleanTranscriptForNvidia(raw: string, maxChars = 6_000): string {
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

/**
 * 在 JSON.parse 之前，從 NVIDIA 原始回應字串中把 "transcript" 欄位的值挖空。
 * 此函式使用字元層級掃描（非 regex），不依賴 JSON 是否合法，因此能處理：
 *   - transcript 含未跳脫的雙引號（法文/英文對話引用，如 "ouais" il dit...）
 *   - transcript 過長導致 JSON 被截斷（266K 字元等極端情況）
 *   - NVIDIA 忽略系統指示仍輸出完整逐字稿的所有情況
 *
 * 策略：
 *   1. 找到 "transcript": " 的位置（開頭引號之後）
 *   2. 找到最近的已知後繼欄位（summaryText / segments / ...）
 *   3. 在後繼欄位之前往回找最後一個 " 作為 transcript 的關閉引號
 *   4. 把中間的所有內容替換成空字串，保留 JSON 結構
 */
function stripTranscriptFromRawJson(raw: string): string {
  const transcriptKeyPos = raw.search(/"transcript"\s*:\s*"/);
  if (transcriptKeyPos < 0) return raw;

  const colonPos     = raw.indexOf(":", transcriptKeyPos);
  if (colonPos < 0) return raw;
  const openQuotePos = raw.indexOf('"', colonPos + 1);
  if (openQuotePos < 0) return raw;

  // ── 字元掃描法找真正的關閉引號 ──
  // 舊版用 lastIndexOf('"', nextFieldPos) 在逐字稿含未跳脫 " 時會找錯位置，
  // 導致 81588 字元的逐字稿原封不動送入 JSON.parse 而失敗。
  // 正確做法：逐字掃描，遇 \ 跳過下一字元，遇 " 即為真正結尾。
  let i = openQuotePos + 1;
  let closeQuotePos = -1;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\\") { i += 2; continue; }  // 跳脫序列 \n \t \" \\ 等
    if (ch === '"')  { closeQuotePos = i; break; }
    i++;
  }

  if (closeQuotePos > openQuotePos) {
    // 找到真正的關閉引號：把 transcript 值清空為 ""
    return raw.slice(0, openQuotePos + 1) + raw.slice(closeQuotePos);
  }

  // ── 找不到關閉引號：JSON 在 transcript 中途被截斷 ──
  const fallbackTail =
    '", ' +
    '"summaryText": "⚠️ NVIDIA 回應被截斷（逐字稿過長），摘要無法產生。' +
    '建議改用 Gemini，或手動貼上字幕後重試。", ' +
    '"segments": [], ' +
    '"keyConcepts": [], ' +
    '"actionItems": [], ' +
    '"translations": {}}';
  return raw.slice(0, openQuotePos + 1) + fallbackTail;
}

/**
 * 從原始 JSON 字串中以字元掃描法「提取並清除」transcript 欄位值。
 * 用於 Gemini 逐字稿含未跳脫雙引號（如對話引用 "是嗎"）導致 JSON.parse 全面失敗時：
 *   1. 用與 stripTranscriptFromRawJson 相同的掃描法找到真正的關閉引號
 *   2. 取出原始值並解碼 JSON 跳脫序列（\n → 換行、\" → 雙引號 等）
 *   3. 回傳清空 transcript 後的 stripped 字串（可被 safeParseJson 正常解析）
 *   4. 呼叫端把提取的 transcript 重新注入到 parsed 物件
 *
 * 注意：此函式只在 safeParseJson 失敗後作為後備路徑執行，不影響正常情況。
 */
function extractTranscriptAndStrip(
  raw: string
): { transcript: string; stripped: string } {
  const transcriptKeyPos = raw.search(/"transcript"\s*:\s*"/);
  if (transcriptKeyPos < 0) return { transcript: "", stripped: raw };

  const colonPos = raw.indexOf(":", transcriptKeyPos);
  if (colonPos < 0) return { transcript: "", stripped: raw };
  const openQuotePos = raw.indexOf('"', colonPos + 1);
  if (openQuotePos < 0) return { transcript: "", stripped: raw };

  // 字元掃描找真正的關閉引號（遇 \ 跳過下一字元，遇 " 即結尾）
  let i = openQuotePos + 1;
  let closeQuotePos = -1;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === '"')  { closeQuotePos = i; break; }
    i++;
  }

  if (closeQuotePos > openQuotePos) {
    // 取出原始 transcript 值並解碼 JSON 跳脫序列
    const transcriptRaw = raw.slice(openQuotePos + 1, closeQuotePos);
    const transcript = transcriptRaw
      .replace(/\\n/g,  "\n")
      .replace(/\\r/g,  "\r")
      .replace(/\\t/g,  "\t")
      .replace(/\\"/g,  '"')
      .replace(/\\\\/g, "\\");
    const stripped = raw.slice(0, openQuotePos + 1) + raw.slice(closeQuotePos);
    return { transcript, stripped };
  }

  return { transcript: "", stripped: raw };
}

/**
 * 從 YouTube 影片中抓取字幕，支援多語言 Fallback。
 * 依序嘗試 zh-TW → zh → en → 不指定語言。
 */
async function fetchYoutubeTranscript(url: string): Promise<string> {
  try {
    const { YoutubeTranscript } = await import("youtube-transcript");
    const cleanUrl = cleanYoutubeUrl(url.trim());
    const LANG_FALLBACKS = ["zh-TW", "zh", "en"];
    let segments: any[] | null = null;

    for (const lang of LANG_FALLBACKS) {
      try {
        segments = await YoutubeTranscript.fetchTranscript(cleanUrl, { lang });
        if (segments?.length) break;
      } catch {
        // 該語言不存在，繼續嘗試下一個
      }
    }

    if (!segments?.length) {
      try {
        segments = await YoutubeTranscript.fetchTranscript(cleanUrl);
      } catch {
        // 忽略錯誤
      }
    }

    return (segments ?? []).map((s: any) => s.text).join(" ");
  } catch {
    return "";
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
          // ⚠️ 重要：transcript 欄位由後端注入（已從 YouTube API 取得字幕），
          // 此處要求 Gemini 完全略過逐字稿輸出，只專注於摘要分析。
          // 這是防止 Gemini 輸出大量逐字稿導致 JSON 解析失敗的關鍵機制。
          text: `Please analyze this YouTube video in full detail. Focus ONLY on producing a thorough summary, segments, key concepts, and translations. Do NOT attempt to transcribe the spoken content — set transcript to empty string as instructed in the system prompt.`,
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
function buildSystemPrompt(
  options: SummaryOptions,
  provider: "gemini" | "nvidia" = "gemini",
  hasFetchedTranscript = false
): string {
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

  // NVIDIA 或已在後端抓取字幕的情況：
  // 強制輸出空字串 ""，由後端自行填入已清洗的輸入字幕。
  // 原因：模型若輸出完整逐字稿，會耗費極多 Token 與生成時間（常導致 60s 超時），且易因特殊字元導致 JSON 結構損毀。
  const transcriptInstruction = (provider === "nvidia" || hasFetchedTranscript)
    ? `"transcript": "" (IMPORTANT: always output empty string for this field — transcript is injected separately)`
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

  // ── 主要解析路徑 ──
  try {
    return safeParseJson(rawText);
  } catch (primaryErr) {
    // ── 後備路徑：transcript 含未跳脫雙引號導致所有策略失敗 ──
    // （老高等中文頻道逐字稿常含 "他說\"是嗎\"" 形式的對話引用，
    //   Gemini 有時輸出原始 " 而非跳脫的 \\"，破壞 JSON 結構）
    // 用字元掃描把 transcript 值單獨提取出來，剩餘 JSON 清空該欄位後重新解析，
    // 最後把真實逐字稿注入回 parsed 物件。
    console.warn(
      "[callGemini] safeParseJson failed, trying extractTranscriptAndStrip fallback.",
      `Length=${rawText.length}`
    );
    const { transcript, stripped } = extractTranscriptAndStrip(rawText);
    const parsed = safeParseJson(stripped); // 若仍失敗則讓錯誤向上拋出
    if (transcript && parsed && typeof parsed === "object") {
      parsed.transcript = transcript;
    }
    return parsed;
  }
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
      top_p: 0.95,
      max_tokens: 65000,   // 恢復舊版設定；32768 對長字幕影片不夠用，會導致輸出截斷
      stream: false,
      frequency_penalty: 0,
      presence_penalty: 0,
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

  // Step 1：移除 <think>...</think> 思考區塊。
  // Nemotron 模型在未收到 /no_think 時（或忽略指令時）會在回應前輸出思考過程，
  // 這些內容不是合法 JSON，必須先清除才能繼續解析。
  const withoutThink = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();

  // Step 2：去除 Markdown 圍欄
  const withoutFences = withoutThink
    .replace(/^```(?:json)?\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();

  // Step 3：在 JSON.parse 之前，先把 transcript 欄位的值挖空。
  // NVIDIA 常忽略「輸出空字串」的指示，直接把完整逐字稿寫入 transcript，
  // 法文/英文內容含大量未跳脫雙引號，導致解析失敗。
  // stripTranscriptFromRawJson 以字元掃描法直接剷除該欄位值，
  // 不依賴 JSON 是否合法，之後再由後端注入正確的 transcript。
  const stripped = stripTranscriptFromRawJson(withoutFences);

  return safeParseJson(stripped);
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
    // ── 預先獲取 YouTube 字幕（NVIDIA 與 Gemini 共用） ──
    // 這能讓我們在 Gemini 模式中同樣實施「後端注入逐字稿」策略，
    // 大幅縮短 LLM 的 JSON 生成時間，避免 Vercel 60 秒的超時限制。
    let youtubeTranscript = "";
    if (body.mediaType === "link" && body.videoLink && isYoutubeUrl(body.videoLink)) {
      const cleanUrl = cleanYoutubeUrl(body.videoLink.trim());
      youtubeTranscript = await fetchYoutubeTranscript(cleanUrl);
    }

    // ── NVIDIA path (text-only) ──
    if (provider === "nvidia") {
      // /no_think：關閉 Nemotron 模型的思考模式，避免輸出 <think>...</think> 區塊導致 JSON 解析失敗
      const nvidiaSystemPrompt = "/no_think\n\n" + buildSystemPrompt(options, "nvidia");
      const apiKey = process.env.NVIDIA_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ success: false, error: "NVIDIA_API_KEY not configured." });
      }

      // Collapse content to plain text for NVIDIA
      let textContent = "";
      let finalTranscriptForNvidia = "";

      if (body.mediaType === "transcript_paste") {
        textContent = body.textTranscript || "";
        finalTranscriptForNvidia = body.textTranscript || "";
      } else if (body.mediaType === "link") {
        if (!body.videoLink?.trim()) throw new Error("Please provide a valid media URL.");
        if (isYoutubeUrl(body.videoLink)) {
          const cleanUrl = cleanYoutubeUrl(body.videoLink.trim());
          if (youtubeTranscript.trim()) {
            const transcriptText = cleanTranscriptForNvidia(youtubeTranscript);
            textContent = `YouTube URL: ${cleanUrl}\n\n字幕內容（逐字稿）：\n${transcriptText}`;
            finalTranscriptForNvidia = youtubeTranscript;
          } else {
            // ── 無字幕：直接抓取影片中繼資料 (Metadata)，送 NVIDIA 分析，絕不 fallback 到 Gemini ──
            const meta = await getYoutubePageMetadata(cleanUrl);
            textContent = `YouTube URL: ${cleanUrl}\n影片標題: ${meta.title || "(無標題)"}\n頻道: ${meta.channel || "(未知)"}\n描述:\n${meta.description || "(無描述)"}\n\n注意：此影片沒有可用字幕/逐字稿，請完全依據影片中繼資料進行主題與概念分析。`;
            finalTranscriptForNvidia = "（此影片沒有可用字幕，已改用影片中繼資料進行概念分析）";
          }
        } else {
          const ctx = await getNonYoutubeLinkContext(body.videoLink);
          textContent = `URL: ${body.videoLink}\n\nPage context:\n${ctx.pageText}\n\nTranscript:\n${ctx.transcript || "(none)"}`;
          finalTranscriptForNvidia = ctx.transcript || "";
        }
      } else {
        return res.status(400).json({
          success: false,
          error: "NVIDIA provider only supports transcript paste or non-YouTube links. For audio/video files, please use Gemini.",
        });
      }

      const result = await callNvidia(textContent, nvidiaSystemPrompt, apiKey);

      // NVIDIA 被指示輸出空的 transcript 欄位。
      // 在此注入已清洗的輸入字幕或說明，讓前端能正常顯示。
      if (result && typeof result === "object") {
        result.transcript = finalTranscriptForNvidia;
      }

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

    // 判斷是否能預先注入字幕，避免 Gemini 輸出長字串導致超時
    // ─────────────────────────────────────────────────────────────
    // Gemini + YouTube 路徑：
    //   youtubeTranscript 在前面（約 L729）已預先抓好。
    //   若字幕非空，告知 Gemini 略過逐字稿（hasFetchedTranscript=true），
    //   後端再把乾淨字幕注入到 result.transcript。
    //   若字幕為空（無字幕影片），仍讓 Gemini 從影音自行轉錄。
    // ─────────────────────────────────────────────────────────────
    let geminiTranscriptToInject = "";
    if (body.mediaType === "transcript_paste") {
      geminiTranscriptToInject = body.textTranscript || "";
    } else if (body.mediaType === "link" && body.videoLink && isYoutubeUrl(body.videoLink)) {
      geminiTranscriptToInject = youtubeTranscript; // 可能為空（無字幕影片）
    }

    // 僅在有字幕時才告知 Gemini 略過逐字稿輸出
    const hasTranscriptToInject = !!geminiTranscriptToInject.trim();
    const geminiSystemPrompt = buildSystemPrompt(options, "gemini", hasTranscriptToInject);
    const contents = await buildGeminiContents(body);
    const result = await callGemini(contents, geminiSystemPrompt, apiKey, options);

    // 注入預先取得或貼上的字幕（後端已清洗）
    if (hasTranscriptToInject && result && typeof result === "object") {
      result.transcript = geminiTranscriptToInject;
    }

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