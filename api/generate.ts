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
    const attemptErrors: string[] = [];

    // 自訂 fetch 用於注入 Cookie 繞過 YouTube 同意頁面 / 機器人驗證，
    // 並帶入合適的 User-Agent 確保 /api/timedtext 不會回傳空回應。
    const customFetch = (fetchUrl: string, init?: any) => {
      return fetch(fetchUrl, {
        ...init,
        headers: {
          ...init?.headers,
          "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+417; GPS=1; YSC=1; VISITOR_INFO1_LIVE=1",
        },
      });
    };

    for (const lang of LANG_FALLBACKS) {
      try {
        segments = await YoutubeTranscript.fetchTranscript(cleanUrl, {
          lang,
          fetch: customFetch,
        });
        if (segments?.length) break;
      } catch (langErr: any) {
        // 該語言不存在，繼續嘗試下一個——但把原因記下來，不要靜默吞掉
        attemptErrors.push(`[${lang}] ${langErr?.message || langErr}`);
      }
    }

    if (!segments?.length) {
      try {
        segments = await YoutubeTranscript.fetchTranscript(cleanUrl, {
          fetch: customFetch,
        });
      } catch (defaultErr: any) {
        attemptErrors.push(`[default] ${defaultErr?.message || defaultErr}`);
      }
    }

    if (!segments?.length && attemptErrors.length) {
      // 這裡印出「真正」失敗原因：可能是套件被 YouTube 擋、影片本身無字幕、
      // 或是網路/驗證問題。之前這裡被靜默吞掉，導致完全無法診斷。
      console.warn(`[fetchYoutubeTranscript] All attempts failed for ${cleanUrl}: ${attemptErrors.join(" | ")}`);
    }

    return (segments ?? []).map((s: any) => s.text).join(" ");
  } catch (outerErr: any) {
    console.warn(`[fetchYoutubeTranscript] Unexpected error: ${outerErr?.message || outerErr}`);
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
  let title = "";
  let description = "";
  let channel = "";

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+417",
      },
    });
    if (res.ok) {
      const html = await res.text();

      const titleMatch =
        html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ||
        html.match(/<title>([^<]+)<\/title>/i);
      title = titleMatch
        ? titleMatch[1].replace(/ - YouTube$/, "").trim()
        : "";

      const descMatch =
        html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i) ||
        html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i);
      description = descMatch ? descMatch[1].trim() : "";

      const channelMatch =
        html.match(/"ownerChannelName":"([^"]+)"/) ||
        html.match(/"channelName":"([^"]+)"/);
      channel = channelMatch ? channelMatch[1].trim() : "";
    }
  } catch {
    // 忽略錯誤
  }

  // ── 如果被 YouTube 阻擋/重新導向至同意頁面（標題為 YouTube 或包含使用體驗） ──
  // 或者是頻道名稱為空時，使用官方的 oEmbed API 作為強健的 Fallback
  const isBlockedTitle = !title || title === "YouTube" || title.includes("平台使用體驗") || title.includes("Before you continue");
  if (isBlockedTitle || !channel) {
    try {
      const videoId = extractYoutubeVideoId(url);
      if (videoId) {
        const oembedRes = await fetch(
          `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (oembedRes.ok) {
          const data = await oembedRes.json() as any;
          if (data.title && isBlockedTitle) {
            title = data.title;
          }
          if (data.author_name && !channel) {
            channel = data.author_name;
          }
        }
      }
    } catch {
      // 忽略錯誤
    }
  }

  return { title, description, channel };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildGeminiContents
// link 模式分三條路：
//   1. YouTube URL + 已有官方字幕 → 改傳純文字逐字稿給 Gemini（2026/07 新增）
//      原因：後端已經用 youtube-transcript 抓到官方字幕時，
//      若還用 fileData.fileUri 讓 Gemini 重新「看」一次整支影片，
//      等於同一份內容被傳送兩次：
//        - 影片時間一長，多模態輸入 token 暴增，容易觸發
//          「input token count exceeds the maximum number of tokens allowed 1048576」
//        - 影片資料量大，Gemini 處理時間拉長，更容易撞到 Vercel Function 逾時
//      官方字幕本身就是最準確的逐字稿來源，改用純文字傳遞：
//        - Token 成本通常只有多模態影片串流的幾十分之一
//        - 分析品質不受影響（官方字幕通常比 AI 自動聽寫更準確）
//        - 完全不影響「沒有字幕的影片」——那種情況仍會 fallback 到原本的
//          fileData 多模態方式，功能不打折扣
//   2. YouTube URL + 無字幕 → 沿用官方 fileData.fileUri 結構化格式，讓 Gemini 直接讀取影片內容
//      （依據 Google 官方文件 ai.google.dev/gemini-api/docs/video-understanding）
//   3. 一般 URL → 維持原本抓 meta + 字幕的方式
// ─────────────────────────────────────────────────────────────────────────────
async function buildGeminiContents(body: GenerateBody, youtubeTranscript = "") {
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

    if (isYoutubeUrl(body.videoLink)) {
      const cleanUrl = cleanYoutubeUrl(body.videoLink.trim());

      // ── 已有官方字幕：改傳文字，不再重複傳送整支影片 ──
      if (youtubeTranscript.trim()) {
        return [
          {
            text:
              `以下是這支 YouTube 影片（${cleanUrl}）的官方逐字稿內容，請根據這份逐字稿進行完整、深入的分析。\n\n` +
              `【官方逐字稿開始】\n${youtubeTranscript.trim()}\n【官方逐字稿結束】\n\n` +
              `請專注於產出完整摘要、分段重點、關鍵概念與翻譯。` +
              `transcript 欄位請依系統提示輸出空字串（此欄位已由後端另行注入正確內容），不需要在此重新輸出逐字稿全文。`,
          },
        ];
      }

      // ── 無字幕：沿用官方 fileData.fileUri 多模態格式，讓 Gemini 直接讀影片 ──
      // ⚠️ 修正說明（沿用既有註記）：先前版本把 YouTube 網址當成純文字塞進 prompt 裡，
      //    這樣 Gemini 完全沒有機會存取影片內容，只會根據文字脈絡憑空生成內容（幻覺），
      //    導致回傳結果與影片實際內容完全不符。正確做法必須用 fileData 欄位傳遞。
      return [
        {
          fileData: {
            fileUri: cleanUrl,
            mimeType: "video/*",
          },
        },
        {
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

  // ── 2026/07/10 新增：偵測「Gemini + 無字幕（需完整影音多模態分析＋自行聽打逐字稿）」這條最慢的路徑 ──
  // 這條路徑本身已經比純文字分析慢很多（要即時聽整支影片＋自己產生逐字稿），
  // 若再疊加下面「detailed 模式強制 ≥10000 字」的巨量輸出要求，
  // 極容易撞上 callGemini() 裡的 280 秒總預算（TOTAL_BUDGET_MS）而逾時失敗。
  // 6/30 穩定版本原本沒有強制字數門檻，模型自行決定長短，因此當時能在時間內跑完。
  // 這裡的做法：只在「這條最慢的路徑」放寬字數要求，其餘路徑（有字幕/NVIDIA，本身就快）維持原本高品質要求不變。
  const isSlowGeminiMultimodal = provider === "gemini" && !hasFetchedTranscript;

  // ── 深度需求：量化字數要求 ──
  const depthInstruction =
    options.depth === "quick"
      ? "Produce a concise but complete summary. All text fields combined should be at least 3000 Traditional Chinese characters."
      : isSlowGeminiMultimodal
      ? "Produce a thorough but efficient analysis. All text fields combined should be at least 4000 Traditional Chinese characters. The summaryText should be at least 500 characters. Each translation should be at least 1000 characters. Prioritize covering all key content accurately and completing the FULL JSON response within the available time — do NOT pad with unnecessary repetition, but do not omit important information either."
      : "Produce an EXTREMELY DETAILED and COMPREHENSIVE analysis. ALL text fields combined MUST reach at least 10000 Traditional Chinese characters. Every segment summary should be at least 300 characters. The summaryText should be at least 800 characters. Each translation should be at least 2000 characters. Do NOT truncate or summarize briefly — expand every point with full context, background, examples and reasoning.";

  // ── 項目數量要求 ──
  const quantityInstruction =
    options.depth === "quick"
      ? `- segments array should contain at least 4 items, each with a clear summary.
- keyConcepts should contain at least 6 items.
- actionItems should contain at least 4 items if any are present in the content.`
      : isSlowGeminiMultimodal
      ? `- segments array should contain at least 5 items, each with a clear, focused summary.
- keyConcepts should contain at least 8 items, each being a complete phrase or short explanation.
- actionItems should contain at least 5 items if any are present in the content.`
      : `- segments array MUST contain at least 8 items for detailed depth, each with a thorough summary.
- keyConcepts MUST contain at least 15 items, each being a complete phrase or short explanation (not just a single word).
- actionItems MUST contain at least 10 items if any are present in the content.`;

  const goalInstruction =
    options.primaryGoal === "actions"
      ? "Focus on extracting ALL actionable items, decisions, next steps, responsibilities and deadlines mentioned. Each actionItem should be a complete sentence with full context."
      : "Focus on extracting ALL key knowledge points, insights, concepts and takeaways. Each keyConcept should include a brief explanation of why it matters.";

  // NVIDIA 或已在後端抓取字幕的情況：
  // 強制輸出空字串 ""，由後端自行填入已清洗的輸入字幕。
  // 原因：模型若輸出完整逐字稿，會耗費極多 Token 與生成時間（常導致 60s 超時），且易因特殊字元導致 JSON 結構損毀。
  // （此為後來版本新增的防呆架構，予以保留，不還原成舊版「模型自行輸出逐字稿」的做法。）
  const transcriptInstruction = (provider === "nvidia" || hasFetchedTranscript)
    ? `"transcript": "" (IMPORTANT: always output empty string for this field — transcript is injected separately)`
    : `"transcript": "string — accurate transcription of spoken content capturing all substantive points, MUST be written in Traditional Chinese (繁體中文) if source is Chinese, otherwise keep original language; be complete but avoid verbatim filler words/repetition to keep generation time reasonable"`;

  // NVIDIA 專屬的嚴格 JSON 格式規則（還原 6/30 穩定版設定，降低截斷/格式錯誤機率）
  const nvidiaJsonRules = provider === "nvidia"
    ? `

!!NVIDIA STRICT JSON RULES — MUST FOLLOW!!
- Output ONLY a single raw JSON object. No markdown fences. No \`\`\`json. No \`\`\`.
- ABSOLUTELY NO comments inside JSON. No // comments. No /* */ comments. JSON does not support comments.
- Do NOT add trailing commas after the last item in any array or object.
- Every string value must be properly escaped. Use \\n for newlines inside strings, never actual line breaks.
- Complete the ENTIRE JSON before stopping. Never truncate mid-string or mid-object.
- If content is very long, shorten individual field values slightly to fit, but ALWAYS close all brackets and braces properly.`
    : "";

  return `You are an elite multilingual media transcriptionist, content analyst, and translator with exceptional attention to detail.

!!CRITICAL LANGUAGE REQUIREMENT — MUST FOLLOW WITHOUT EXCEPTION!!
- ALL output fields including title, transcript (if applicable), summaryText, every segment title and summary, every keyConcept, and every actionItem MUST be written EXCLUSIVELY in Traditional Chinese (繁體中文).
- Traditional Chinese uses characters such as: 這、來、國、時、說、們、體、語、為、與、個、會、對、後、發、現、開、過、從、裡
- STRICTLY FORBIDDEN: Do NOT use Simplified Chinese (简体字) characters anywhere. Simplified Chinese uses: 这、来、国、时、说、们、体、语、为、与、个、会、对、后、发、现、开、过、从、里
- Even if the source media is in Mandarin (Simplified Chinese), Cantonese, English, Japanese, or any other language — you MUST still write ALL non-translation fields in Traditional Chinese (繁體中文).
- The translations.zh field (if requested) must also be written in Traditional Chinese (繁體中文), NOT Simplified Chinese.
- Double-check every character you output. If you are unsure whether a character is Traditional or Simplified, choose the Traditional form.

!!CRITICAL OUTPUT LENGTH REQUIREMENT!!
${depthInstruction}
${quantityInstruction}
- translations for each selected language MUST be complete, polished Markdown with headers, bullet points, and full explanations — NOT a brief summary.
- NEVER cut content short. If you are running long, continue until all fields are complete and thorough.

!!CONTENT AVAILABILITY CHECK!!
- If the media content is inaccessible, private, region-locked, or has insufficient information to analyze:
  Set summaryText to exactly: "【內容無法順利取得】此影音連結目前無法正常存取或內容資訊不足，請確認連結是否為公開影片，或嘗試更換其他連結後重新分析。"
  Set all segment summaries to the same error message.
  Set translations.zh (if requested) to the same error message in Markdown format.
  Do NOT fabricate or guess content. Do NOT produce placeholder analysis.

Analysis depth: ${options.depth === "quick" ? "Quick summary" : "Detailed analysis"}
${goalInstruction}

You MUST respond with ONLY valid JSON (no markdown fences, no prose), matching this exact schema:
{
  "title": "string — concise title for this content, in Traditional Chinese (繁體中文)",
  "originalLanguage": "string — 繁體中文 description of the detected source language (e.g. 英文、日文、韓文、普通話、粵語)",
  ${transcriptInstruction},
  "summaryText": "string — comprehensive executive summary in Traditional Chinese (繁體中文), minimum ${options.depth === "quick" ? "500" : "800"} characters",
  "segments": [
    {
      "title": "string — section heading in Traditional Chinese (繁體中文)",
      "timeRange": "string or null — e.g. '00:00 - 05:30', or descriptive labels like '開場介紹'、'核心論點'、'結論' if no timestamps are available",
      "summary": "string — paragraph summary of this segment in Traditional Chinese (繁體中文)"
    }
  ],
  "keyConcepts": ["string — Traditional Chinese (繁體中文), concept name plus brief explanation, not just a single word", "..."],
  "actionItems": ["string — Traditional Chinese (繁體中文), complete actionable sentence", "..."],
  "translations": {
    ${options.targetLanguages.filter((l) => l !== "zh").map((l) => `"${l}": "string — full formatted Markdown summary in ${langMap[l] || l}, minimum 2000 characters, with ## headers and bullet points"`).join(",\n    ")}
  }
}

Target translation languages: ${langList}
If translation for a language is not requested, omit that key from translations.
Always include the Traditional Chinese summary in "summaryText".
Do not wrap the JSON in markdown fences.
Start your response IMMEDIATELY with { and end with }. No preamble, no explanation, no markdown fences.
Every field in the JSON shape above MUST be present. Never omit required fields.${nvidiaJsonRules}`;
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
      // 影片/圖片解析度採用 LOW：每畫面僅消耗 66 tokens（預設為 258 tokens），
      // 大幅降低長影片的 token 用量（約可延伸 4 倍可處理時長），
      // 避免遇到 "input token count exceeds the maximum number of tokens allowed 1048576" 錯誤。
      // 本應用僅需聽懂語音內容做重點摘要，不需辨識畫面中的細小文字或畫面細節，
      // 故降低解析度對摘要品質影響極小。
      mediaResolution: "MEDIA_RESOLUTION_LOW",
    },
  };

  let res: any;
  let json: any;
  const maxRetries = 3;
  let delay = 2000; // 2 seconds initial delay

  // ── 總預算制（TOTAL_BUDGET_MS） ──
  // 修正過的 bug：先前每次重試都重新給 250 秒的獨立額度，完全沒考慮
  // 「這已經是第幾次重試、總共花了多少時間、離 vercel.json maxDuration(300s)
  //  這個平台大限還剩多少」。連續遇到 503 時，重試延遲（2s+5s+12.5s...）疊加
  // 多次嘗試，很容易在最後一次嘗試進行到一半時，被 Vercel 平台直接強制砍斷
  // （Vercel Runtime Timeout Error），導致我們自己的逾時偵測與友善錯誤訊息
  // 完全來不及執行。
  //
  // 修正做法：所有嘗試 + 重試延遲，共用同一個總預算（TOTAL_BUDGET_MS）。
  // 每次嘗試前，先檢查剩餘預算是否還足夠進行一次有意義的嘗試（>15 秒），
  // 不夠就立刻「快速失敗」，絕不啟動注定會被平台砍斷的最後一擊。
  //
  // ⚠️ 2026/07 對齊「27調整」成功版本：舊版單次呼叫給足 280 秒（無重試機制），
  // 曾經能成功分析的影片，代表 Gemini 本身處理起來需要 260~280 秒這個區間。
  // 先前為了同時預留 503 重試空間，誤把總預算縮到 260 秒，導致原本能成功的
  // 影片變成在 260 秒被提前判定逾時。這裡調回 280 秒，維持與成功版本相同的
  // 單次呼叫額度，同時仍保留本次新增的智慧預算管理（重試前檢查剩餘預算），
  // 兩全其美：常見情況給足 280 秒，真的連續 503 時仍能提前優雅失敗。
  const TOTAL_BUDGET_MS = 280_000;
  const MIN_USEFUL_ATTEMPT_MS = 15_000; // 少於這個時間不足以取得有意義的回應，直接判定逾時
  const callStart = Date.now();
  const remainingBudget = () => TOTAL_BUDGET_MS - (Date.now() - callStart);

  const throwBudgetExhausted = (reason: string): never => {
    console.error(`[callGemini] Budget exhausted (${reason}) after ${((Date.now() - callStart) / 1000).toFixed(1)}s`);
    const timeoutErr = new Error(
      `GEMINI_TIMEOUT: Gemini 分析總耗時已達 ${TOTAL_BUDGET_MS / 1000} 秒預算上限（${reason}），` +
      `影片內容量（時長/無字幕需完整多模態解析，或 API 當下負載過高）已超出可處理範圍。`
    );
    (timeoutErr as any).isGeminiTimeout = true;
    throw timeoutErr;
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptStart = Date.now();
    const budgetLeft = remainingBudget();

    if (budgetLeft < MIN_USEFUL_ATTEMPT_MS) {
      throwBudgetExhausted(`僅剩 ${(budgetLeft / 1000).toFixed(1)}s，不足以再嘗試一次`);
    }

    try {
      console.log(`[callGemini] attempt ${attempt + 1}/${maxRetries + 1} START (budgetLeft=${(budgetLeft / 1000).toFixed(1)}s)`);
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(budgetLeft), // 用剩餘總預算，而非重新給滿額
      });

      json = await res.json() as any;

      if (!res.ok) {
        // 高負載(503)或速率限制(429)才重試——這類錯誤通常是「瞬間」發生，重試合理。
        // 但重試前也要確認：扣掉本次退避延遲後，是否還有剩餘預算值得再試一次。
        if ((res.status === 503 || res.status === 429) && attempt < maxRetries) {
          const budgetAfterDelay = remainingBudget() - delay;
          if (budgetAfterDelay < MIN_USEFUL_ATTEMPT_MS) {
            throwBudgetExhausted(`HTTP ${res.status} 且退避延遲後預算不足`);
          }
          console.warn(
            `[callGemini] Got HTTP ${res.status} (${res.status === 503 ? "High demand" : "Rate limit"}). ` +
            `Retrying in ${delay}ms... (Attempt ${attempt + 1}/${maxRetries})`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 2.5; // exponential backoff
          continue;
        }
        throw new Error(
          `Gemini API error ${res.status}: ${json?.error?.message || JSON.stringify(json)}`
        );
      }
      console.log(`[callGemini] attempt ${attempt + 1} SUCCESS after ${((Date.now() - attemptStart) / 1000).toFixed(1)}s`);
      break; // Success
    } catch (err: any) {
      const attemptElapsed = ((Date.now() - attemptStart) / 1000).toFixed(1);
      // ── 逾時/中斷錯誤：絕不重試 ──
      // 本次嘗試已經吃掉剩餘預算（AbortSignal 用的就是 budgetLeft），代表影片內容量
      // 本身就超出 Gemini 在 Vercel Function 時限內能處理的範圍。重試只會再吃光剩餘
      // 預算，一定會撞上 vercel.json 的 maxDuration(300s) 而被平台強制砍斷連線，
      // 讓使用者只看到神秘的「signal timed out」而不是清楚的錯誤訊息。
      // 因此逾時/中斷一律「快速失敗」，把明確原因往外拋出，由呼叫端轉譯成友善提示。
      const isTimeoutOrAbort =
        err?.name === "TimeoutError" ||
        err?.name === "AbortError" ||
        /timeout|abort/i.test(String(err?.message || ""));

      if (isTimeoutOrAbort) {
        console.error(`[callGemini] attempt ${attempt + 1} TIMED OUT after ${attemptElapsed}s`);
        throwBudgetExhausted(`第 ${attempt + 1} 次嘗試逾時`);
      }

      console.warn(`[callGemini] attempt ${attempt + 1} FAILED after ${attemptElapsed}s: ${err?.message || err}`);

      // 非逾時的網路錯誤（例如瞬斷、socket hang up）才允許重試——同樣要檢查剩餘預算
      if (attempt < maxRetries) {
        const budgetAfterDelay = remainingBudget() - delay;
        if (budgetAfterDelay < MIN_USEFUL_ATTEMPT_MS) {
          throwBudgetExhausted(`網路錯誤且退避延遲後預算不足`);
        }
        console.warn(
          `[callGemini] Request failed: ${err.message || err}. ` +
          `Retrying in ${delay}ms... (Attempt ${attempt + 1}/${maxRetries})`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2.5;
        continue;
      }
      throw err;
    }
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

  let res: any;
  let json: any;
  const maxRetries = 3;
  let delay = 2000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      res = await fetch(url, {
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

      json = await res.json() as any;

      if (!res.ok) {
        // 503 (高負載) 或 429 (速率限制) 皆可重試
        if ((res.status === 503 || res.status === 429) && attempt < maxRetries) {
          console.warn(
            `[callNvidia] Got HTTP ${res.status}. ` +
            `Retrying in ${delay}ms... (Attempt ${attempt + 1}/${maxRetries})`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 2.5;
          continue;
        }
        throw new Error(
          `NVIDIA API error ${res.status}: ${json?.detail || json?.message || JSON.stringify(json)}`
        );
      }
      break; // Success
    } catch (err: any) {
      if (attempt < maxRetries) {
        console.warn(
          `[callNvidia] Request failed: ${err.message || err}. ` +
          `Retrying in ${delay}ms... (Attempt ${attempt + 1}/${maxRetries})`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2.5;
        continue;
      }
      throw err;
    }
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
    const handlerStart = Date.now();
    if (body.mediaType === "link" && body.videoLink && isYoutubeUrl(body.videoLink)) {
      const cleanUrl = cleanYoutubeUrl(body.videoLink.trim());
      console.log(`[generate] fetchYoutubeTranscript START url=${cleanUrl}`);
      youtubeTranscript = await fetchYoutubeTranscript(cleanUrl);
      console.log(
        `[generate] fetchYoutubeTranscript DONE found=${!!youtubeTranscript.trim()} ` +
        `len=${youtubeTranscript.length} elapsed=${((Date.now() - handlerStart) / 1000).toFixed(1)}s`
      );
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

    // ── 切換為 NDJSON 串流回應 ──
    // Gemini 的多模態影片分析耗時可能長達數分鐘，若讓前端單純 fetch() 苦等，
    // 容易被瀏覽器/代理層誤判斷線，使用者體驗上也只看到一個轉圈圈。
    // 改成串流後：
    //   1. 每隔幾秒寫一行 {"type":"progress",...}，前端可即時顯示「已等待 N 秒」
    //   2. 最終寫一行 {"type":"done",...} 帶正式結果或錯誤，前端讀到後結束串流
    // 注意：一旦呼叫 res.writeHead 開始串流，後面就不能再用 res.status().json()，
    // 所有這條路徑之後的錯誤都必須改成寫 ndjson 的 "done"（success:false）行結束。
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no", // 避免部分反向代理把輸出整批緩衝，延遲送達
    });

    const streamStart = Date.now();
    const elapsed = () => `${((Date.now() - streamStart) / 1000).toFixed(1)}s`;
    const heartbeat = setInterval(() => {
      res.write(
        JSON.stringify({
          type: "progress",
          elapsedSeconds: Math.round((Date.now() - streamStart) / 1000),
        }) + "\n"
      );
    }, 8000);

    try {
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

      console.log(
        `[generate][gemini] START mediaType=${body.mediaType} ` +
        `hasTranscript=${hasTranscriptToInject} transcriptLen=${geminiTranscriptToInject.length} ` +
        `videoLink=${body.videoLink || "(n/a)"} elapsed=${elapsed()}`
      );

      const geminiSystemPrompt = buildSystemPrompt(options, "gemini", hasTranscriptToInject);

      console.log(`[generate][gemini] buildGeminiContents START elapsed=${elapsed()}`);
      const contents = await buildGeminiContents(body, youtubeTranscript);
      console.log(`[generate][gemini] buildGeminiContents DONE elapsed=${elapsed()}`);

      console.log(`[generate][gemini] callGemini START elapsed=${elapsed()}`);
      const result = await callGemini(contents, geminiSystemPrompt, apiKey, options);
      console.log(`[generate][gemini] callGemini DONE elapsed=${elapsed()}`);

      // 注入預先取得或貼上的字幕（後端已清洗）
      if (hasTranscriptToInject && result && typeof result === "object") {
        result.transcript = geminiTranscriptToInject;
      }

      console.log(`[generate][gemini] SUCCESS totalElapsed=${elapsed()}`);
      clearInterval(heartbeat);
      res.write(
        JSON.stringify({
          type: "done",
          success: true,
          result,
          usedModel: "gemini-2.5-flash",
        }) + "\n"
      );
      res.end();
      return;
    } catch (geminiErr: any) {
      clearInterval(heartbeat);

      const hasTranscriptToInject = !!(
        (body.mediaType === "transcript_paste" && body.textTranscript) ||
        (body.mediaType === "link" && body.videoLink && isYoutubeUrl(body.videoLink) && youtubeTranscript)
      );

      console.error(
        `[generate][gemini] FAILED totalElapsed=${elapsed()} ` +
        `hasTranscript=${hasTranscriptToInject} isGeminiTimeout=${!!geminiErr?.isGeminiTimeout} ` +
        `errName=${geminiErr?.name} errMessage=${geminiErr?.message}`
      );

      const userMessage = geminiErr?.isGeminiTimeout
        ? `影片長度超過 Gemini 規則建議，改用 NVIDIA 模型進行分析。` +
          `（偵測狀態：${hasTranscriptToInject ? "本片有字幕，仍逾時，可能是 Gemini API 當下較忙碌" : "本片未偵測到字幕，已走完整影音多模態分析，耗時較長"}，已等待 ${elapsed()}）`
        : formatGenerateErrorMessage(geminiErr);

      res.write(
        JSON.stringify({
          type: "done",
          success: false,
          error: userMessage,
        }) + "\n"
      );
      res.end();
      return;
    }

  } catch (err: any) {
    console.error("[generate] Error:", err);

    // 此處只會接住「串流開始之前」發生的錯誤（例如逐字稿預抓、NVIDIA 路徑等），
    // 因此仍可安全使用 res.status().json()。
    return res.status(500).json({
      success: false,
      error: formatGenerateErrorMessage(err),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 將內部錯誤訊息轉譯成友善的中文提示（依錯誤類型給出具體建議）
// ─────────────────────────────────────────────────────────────────────────────
function formatGenerateErrorMessage(err: any): string {
  const raw: string = err?.message || "";

  if (err?.isGeminiTimeout) {
    return "影片長度超過 Gemini 規則建議，改用 NVIDIA 模型進行分析。";
  }
  if (/503|high demand|overloaded|Service Unavailable/i.test(raw)) {
    return (
      "目前 AI 服務需求量過高（503），系統已自動重試仍未成功。" +
      "請稍候 1～2 分鐘後再試，或切換至另一個 AI 模型（如 Google Gemini ↔ NVIDIA）。"
    );
  }
  if (/429|rate.?limit|quota/i.test(raw)) {
    return "API 請求頻率已達上限（429 Rate Limit）。請稍候片刻後重試，或切換至其他 AI 模型。";
  }
  if (/timeout|abort|ETIMEDOUT|ECONNRESET|socket hang/i.test(raw)) {
    return "影片長度超過 Gemini 規則建議，改用 NVIDIA 模型進行分析。";
  }
  if (/private|age.?restrict|region.?lock/i.test(raw)) {
    return "此影片為私人影片、年齡限制影片或地區封鎖，無法取得內容，請嘗試其他影片。";
  }
  return raw || "發生未知錯誤，請稍後重試。";
}