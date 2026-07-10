// api/generate-video-async.ts
// ─────────────────────────────────────────────────────────────────────────────
// 非同步版影片分析（僅用於：Gemini + YouTube 連結 + 無字幕，需要完整多模態分析的情境）
//
// 為什麼需要這支獨立的新檔案：
//   舊做法（api/generate.ts）是把 YouTube 網址透過 fileData.fileUri 直接丟給
//   Gemini 的 generateContent，Google 會在「同一次呼叫」裡現場抓影片＋現場分析，
//   這個「抓＋分析」的時間完全包在單次請求裡，無法拆開，長影片很容易撞上
//   Vercel Function 的時間上限（目前 300 秒）。
//
//   這支檔案改用 Gemini 官方的 Files API（原本是給「使用者上傳檔案」用的機制）：
//     1. init     — 我們自己先把 YouTube 影片的「音訊」抓下來（只抓音訊、不抓畫面，
//                    檔案小很多、下載快很多），上傳給 Gemini，立刻回傳一個 fileName。
//     2. status   — 前端每隔幾秒呼叫一次，查詢 Google 那邊「處理好了嗎」
//                    （state: PROCESSING → ACTIVE），每次查詢都很快，不會逾時。
//     3. finalize — 確認 ACTIVE 後才真正呼叫 generateContent 做摘要生成，
//                    這時 Google 已經處理過音訊，通常會比整段流程塞在一次請求快很多。
//
//   前端不需要資料庫：每個步驟需要的「進度資訊」都直接回傳給前端保管，
//   下一步再由前端把這些資訊原封不動送回來即可（無狀態設計）。
//
// ⚠️ 已知風險：抓取 YouTube 音訊需要第三方套件（本檔案使用 @distube/ytdl-core），
//   YouTube 偶爾會調整防爬蟲機制，導致這類套件短暫失效，屬於外部依賴風險，
//   跟原本「直接讓 Google 抓網址」的做法相比多了一個可能故障點，請留意。
// ─────────────────────────────────────────────────────────────────────────────

export const config = {
  api: {
    bodyParser: { sizeLimit: "5mb" },
  },
  maxDuration: 150,
};

import ytdl from "@distube/ytdl-core";

interface SummaryOptions {
  depth: "quick" | "detailed";
  primaryGoal: "takeaways" | "actions";
  targetLanguages: string[];
}

// ── YouTube 網址處理（沿用 api/generate.ts 同樣的邏輯） ──
function extractYoutubeVideoId(url: string): string | null {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  return match ? match[1] : null;
}

// ── 修復並擷取 JSON（沿用 api/generate.ts 同樣的邏輯，避免模型輸出夾雜控制字元導致解析失敗） ──
function repairAndExtractJson(raw: string): string {
  const start = raw.indexOf("{");
  if (start === -1) return raw;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return raw.slice(start);
}

// ── 精簡版系統提示（沿用 api/generate.ts 的規格，字數要求比照「無字幕多模態」放寬版本） ──
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
      ? "Produce a concise but complete summary. All text fields combined should be at least 3000 Traditional Chinese characters."
      : "Produce a thorough but efficient analysis. All text fields combined should be at least 4000 Traditional Chinese characters.";

  return `You are an elite multilingual media transcriptionist, content analyst, and translator.

!!CRITICAL LANGUAGE REQUIREMENT!!
ALL output fields MUST be written in Traditional Chinese (繁體中文), never Simplified Chinese.

${depthInstruction}

Respond with ONLY a single raw JSON object (no markdown fences), matching this schema:
{
  "title": "string",
  "originalLanguage": "string",
  "transcript": "string — accurate transcription capturing all substantive points, avoid verbatim filler/repetition",
  "summaryText": "string — Traditional Chinese summary",
  "segments": [ { "title": "string", "timeRange": "string or null", "summary": "string" } ],
  "keyConcepts": ["string", "..."],
  "actionItems": ["string", "..."],
  "translations": {
    ${options.targetLanguages.filter((l) => l !== "zh").map((l) => `"${l}": "string — full Markdown summary in ${langMap[l] || l}"`).join(",\n    ")}
  }
}

Target translation languages: ${langList}
If a language is not requested, omit that key from translations.
Start your response IMMEDIATELY with { and end with }. No preamble, no markdown fences.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// action = "init"：抓 YouTube 音訊 → 上傳給 Gemini Files API
// ─────────────────────────────────────────────────────────────────────────────
async function handleInit(body: any, apiKey: string) {
  const videoId = extractYoutubeVideoId(body.videoLink || "");
  if (!videoId) throw new Error("無法辨識這個 YouTube 網址。");

  const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`[async][init] fetching audio-only stream url=${cleanUrl}`);

  // ── 只抓音訊，不抓畫面：檔案小很多、下載快很多，且對「聽打摘要」需求已經足夠 ──
  const info = await ytdl.getInfo(cleanUrl);
  const audioFormats = ytdl.filterFormats(info.formats, "audioonly");
  if (!audioFormats.length) throw new Error("這支影片找不到可用的音訊串流，可能是私人或受地區限制的影片。");

  // 選擇位元率最低的音訊格式，加快下載＋上傳速度（語音辨識不需要高音質）
  const chosenFormat = audioFormats.sort(
    (a, b) => (a.audioBitrate || 0) - (b.audioBitrate || 0)
  )[0];

  const audioStream = ytdl.downloadFromInfo(info, { format: chosenFormat });
  const chunks: Buffer[] = [];
  for await (const chunk of audioStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const audioBuffer = Buffer.concat(chunks);
  console.log(`[async][init] audio downloaded sizeMB=${(audioBuffer.length / 1024 / 1024).toFixed(1)}`);

  const mimeType = chosenFormat.mimeType?.split(";")[0] || "audio/webm";

  // ── 上傳到 Gemini Files API（resumable upload：先開session，再上傳位元組） ──
  const startRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(audioBuffer.length),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: `yt-${videoId}` } }),
    }
  );
  const uploadUrl = startRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    const errText = await startRes.text();
    throw new Error(`Gemini Files API 啟動上傳失敗: ${errText}`);
  }

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(audioBuffer.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: audioBuffer,
  });
  const uploadJson: any = await uploadRes.json();
  if (!uploadRes.ok || !uploadJson?.file) {
    throw new Error(`Gemini Files API 上傳失敗: ${JSON.stringify(uploadJson)}`);
  }

  console.log(`[async][init] uploaded fileName=${uploadJson.file.name} state=${uploadJson.file.state}`);

  return {
    success: true,
    fileName: uploadJson.file.name, // 例如 "files/abc123"
    fileUri: uploadJson.file.uri,
    mimeType: uploadJson.file.mimeType,
    state: uploadJson.file.state, // 通常一開始是 PROCESSING
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// action = "status"：查詢 Gemini 那邊檔案處理進度（很快，供前端輪詢用）
// ─────────────────────────────────────────────────────────────────────────────
async function handleStatus(body: any, apiKey: string) {
  if (!body.fileName) throw new Error("缺少 fileName。");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${body.fileName}?key=${apiKey}`
  );
  const json: any = await res.json();
  if (!res.ok) throw new Error(`查詢檔案狀態失敗: ${JSON.stringify(json)}`);
  return { success: true, state: json.state, fileUri: json.uri, mimeType: json.mimeType };
}

// ─────────────────────────────────────────────────────────────────────────────
// action = "finalize"：檔案 ACTIVE 後才真正呼叫 generateContent 產出摘要
// ─────────────────────────────────────────────────────────────────────────────
async function handleFinalize(body: any, apiKey: string) {
  if (!body.fileUri || !body.mimeType) throw new Error("缺少 fileUri 或 mimeType。");
  const options: SummaryOptions = body.options;

  const MODEL = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const geminiBody = {
    contents: [
      {
        role: "user",
        parts: [
          { fileData: { fileUri: body.fileUri, mimeType: body.mimeType } },
          { text: "Please analyze this audio in full detail and produce the requested JSON summary." },
        ],
      },
    ],
    systemInstruction: { parts: [{ text: buildSystemPrompt(options) }] },
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  };

  console.log(`[async][finalize] calling generateContent fileUri=${body.fileUri}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(geminiBody),
    signal: AbortSignal.timeout(140_000), // 這條路徑已預先處理過音訊，給 140 秒應已足夠；仍在 maxDuration(150s) 內留有緩衝
  });
  const json: any = await res.json();
  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${json?.error?.message || JSON.stringify(json)}`);
  }

  const rawText: string = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const result = JSON.parse(repairAndExtractJson(rawText));

  console.log(`[async][finalize] SUCCESS`);
  return { success: true, result, usedModel: "gemini-2.5-flash" };
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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ success: false, error: "GEMINI_API_KEY not configured." });
  }

  let body: any;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ success: false, error: "Invalid JSON body." });
  }

  try {
    switch (body.action) {
      case "init":
        return res.status(200).json(await handleInit(body, apiKey));
      case "status":
        return res.status(200).json(await handleStatus(body, apiKey));
      case "finalize":
        return res.status(200).json(await handleFinalize(body, apiKey));
      default:
        return res.status(400).json({ success: false, error: "action 必須是 init / status / finalize 其中之一。" });
    }
  } catch (err: any) {
    console.error(`[async] action=${body?.action} FAILED:`, err);
    return res.status(500).json({ success: false, error: err?.message || "發生未知錯誤，請稍後重試。" });
  }
}