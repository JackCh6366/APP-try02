import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import { YoutubeTranscript } from "youtube-transcript";

dotenv.config();

const app = express();
const PORT = 3000;

// Helper to extract YouTube 11-char Video ID
function getYoutubeVideoId(url: string): string | null {
  const regExp = /^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/|shorts\/)|(?:(?:watch)?\?v(?:i)?=|\&v(?:i)?=))([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[1] && match[1].length === 11) ? match[1] : null;
}

// Set request payload limit to 100MB to support media uploads like audio/video files
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));

// Lazy initializer for Gemini client to prevent crashes if key is initially absent
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error(
        "系統尚未設定 GEMINI_API_KEY 密鑰！請至 [Settings > Secrets] 面板中新增並貼上您的金鑰後重試。"
      );
    }
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// Resilient wrapper to handle models overload (503), retrying with exponential backoff and falling back to alternative models if necessary
async function generateContentWithRetryAndFallback(
  ai: GoogleGenAI,
  params: {
    contents: any[];
    systemInstruction: string;
    responseSchema: any;
    tools?: any[];
  }
) {
  const modelsToTry = [
    "gemini-3.5-flash",
    "gemini-flash-latest",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
    "gemini-3.1-pro-preview"
  ];
  let lastError: any = null;

  for (const modelName of modelsToTry) {
    let attempts = 3; // Try up to 3 times per model
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        console.log(`[Gemini API] 正在嘗試呼召模型: ${modelName} (次數: ${attempt}/${attempts})...`);
        const response = await ai.models.generateContent({
          model: modelName,
          contents: params.contents,
          config: {
            systemInstruction: params.systemInstruction,
            responseMimeType: "application/json",
            responseSchema: params.responseSchema,
            temperature: 0.2,
            ...(params.tools ? { tools: params.tools } : {}),
          },
        });
        console.log(`[Gemini API] 模型 ${modelName} 呼叫成功！`);
        return { response, usedModel: modelName };
      } catch (err: any) {
        lastError = err;
        const errStr = String(err.message || err);
        console.warn(
          `[Gemini API Warning] 模型 ${modelName} 在第 ${attempt} 次嘗試時發生錯誤: ${errStr}`
        );

        if (errStr.includes("GEMINI_API_KEY") || errStr.includes("key not valid") || errStr.includes("API_KEY_INVALID")) {
          throw err;
        }

        // 偵測是否為每日配額上限
        const errStrLower = errStr.toLowerCase();
        const isDailyQuotaExceeded = errStrLower.includes("exceeded your current quota") ||
          errStrLower.includes("quota exceeded for metric") ||
          errStrLower.includes("free_tier_requests") ||
          errStrLower.includes("resource_exhausted") ||
          errStrLower.includes("perday") ||
          errStrLower.includes("per_day") ||
          errStrLower.includes("daily") ||
          errStrLower.includes("billing details") ||
          errStrLower.includes("plan and billing");

        if (isDailyQuotaExceeded) {
          console.warn(`[Gemini API] 檢測到模型 ${modelName} 已達今日免費配額上限 (Daily Quota Exceeded)，將立即跳過此模型的後續重試，加速切換至備選模型...`);
          break; // 立即跳出租重試 loop，嘗試下一個模型
        }

        // 當帶有 tools (例如 googleSearch) 呼叫遭遇配額、格式或任何權限錯誤時，立刻拔掉 tools
        // 免費金鑰 / 部分 key 引用的 googleSearch 機制通常有極端苛刻的配額。
        // 去除 tools 改為純粹的模型推理，幾乎能立即避開該配額限制。
        if (params.tools) {
          console.warn(`[Gemini API] 檢測到工具呼叫錯誤 (可能是 Google Search Grounding 配額受限)。正在自動移除 tools 進行無工具推理降級重試...`);
          params.tools = undefined;
          attempt--; // 重置本次嘗試計數，原地以不帶 tools 方式重試
          continue;
        }

        if (attempt < attempts) {
          const waitMs = attempt * 1500;
          console.log(`[Gemini API] 遭遇短暫流量干擾，正在等待 ${waitMs}ms 後重新嘗試...`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
    }
    console.log(`[Gemini API] 模型 ${modelName} 試探未能完工，準備切換至下一個備選模型...`);
  }

  throw lastError || new Error("所有影音智慧模型在多次嘗試與備用調用後皆未能作出回應，請稍後重試。");
}

// REST API Health Check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Primary Endpoint for processing media transcription and summarization
app.post("/api/summarize", async (req, res) => {
  try {
    const { mediaType, fileData, fileName, mimeType, textTranscript, videoLink, options } = req.body;

    if (!mediaType) {
      return res.status(400).json({ error: "缺少的必填參數: mediaType" });
    }

    const { depth = "detailed", primaryGoal = "takeaways", targetLanguages = ["zh", "en"] } = options || {};

    const ai = getGeminiClient();

    // Prepare contents array for Gemini
    const contents: any[] = [];

    // Formulate a robust visual and linguistic summary structure request
    let systemInstruction = `You are an elite multilingual media transcriptionist, content analyst, and translator. 
Your goal is to parse the input media (which may be raw audio, video, a pasted text transcript, or a video/audio URL link) and produce a high-fidelity summary and translation structure.

Follow these strict output guidelines:
1. TITLE: Craft an engaging and professional title in Traditional Chinese (or target language if requested).
2. INTENT MATCH: 
   - Depth level: '${depth}' (quick = short summary; detailed = step-by-step paragraphs; mindmap = concept structured tree).
   - Primary Focus: '${primaryGoal}' (takeaways = core insights; actions = checklist action items; full-transcript = deep listening and detailed narrative).
3. MULTILINGUAL TRANSLATION:
   - For EACH language code selected in [${targetLanguages.join(", ")}], translate and format the entire summary results into that language.
   - Language options map:
     * 'zh': Traditional Chinese (台灣繁體中文). Use elegant local phrases (e.g., '影音整理', '摘要', '行動方針').
     * 'en': English. Sophisticated business styling.
     * 'ja': Japanese (日本語). Polite Business/Keigo syntax.
     * 'ko': Korean (한국어). Formal Polite (하십시오體) syntax.
   - Place this translated content inside the corresponding 'translations' fields as a nicely formatted markdown body. Include subsections like '## 主題核心', '## 重點紀要', and '## 行動要點' (suitably translated for each language).
4. If parts of the text are hard to hear, extrapolate intelligently based on context. Have confidence and format output strictly as valid JSON.
`;

    if (mediaType === "transcript_paste") {
      if (!textTranscript || textTranscript.trim() === "") {
        return res.status(400).json({ error: "請提供影片/音訊的字幕或逐字稿文字內容！" });
      }
      contents.push({
        text: `以下是用戶貼上的影音逐字稿或字幕內容，請根據系統指令進行彙整、分段解析與翻譯：\n\n${textTranscript}`,
      });
    } else if (mediaType === "link") {
      if (!videoLink || videoLink.trim() === "") {
        return res.status(400).json({ error: "請提供有效的影片或音訊連結！" });
      }
      
      let pageText = "";
      let retrievedSubtitles = "";
      let youtubeTitle = "";
      let youtubeChannel = "";
      const isYoutube = videoLink.includes("youtube.com") || videoLink.includes("youtu.be");
      
      // 1. Fetch YouTube oEmbed metadata if it's a YouTube link
      if (isYoutube) {
        try {
          console.log(`[YouTube Link Parser] Attempting to fetch oEmbed metadata for: ${videoLink}`);
          const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoLink)}&format=json`;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          const oRes = await fetch(oembedUrl, { signal: controller.signal });
          clearTimeout(timeoutId);
          if (oRes.ok) {
            const data = await oRes.json() as any;
            if (data && data.title) {
              youtubeTitle = data.title;
              youtubeChannel = data.author_name || "";
              pageText += `\n[影片標題]: ${youtubeTitle}\n[影音頻道]: ${youtubeChannel}\n`;
              console.log(`[YouTube Link Parser] Successfully retrieved Video Title: "${youtubeTitle}" via oEmbed.`);
            }
          }
        } catch (oe) {
          console.warn("[YouTube Link Parser] Failed to fetch oEmbed details:", oe);
        }
      }

      // 2. Attempt to fetch YouTube transcript if it's a YouTube link
      if (isYoutube) {
        try {
          const videoId = getYoutubeVideoId(videoLink);
          if (videoId) {
            console.log(`[YouTube Link Parser] Recognized Video ID: ${videoId}. Fetching transcript...`);
            const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
            if (transcriptItems && transcriptItems.length > 0) {
              retrievedSubtitles = transcriptItems.map(item => item.text).join(" ");
              console.log(`[YouTube Link Parser] Subtitles fetched successfully! Total length: ${retrievedSubtitles.length} chars.`);
            }
          }
        } catch (e: any) {
          console.warn(`[YouTube Link Parser] Failed to fetch automatic captions/subtitles (Transcript might be disabled on this video):`, e.message || e);
        }
      }

      // 3. Simple HTML title/meta description extraction as fallback or additional info
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        const fetchRes = await fetch(videoLink, { 
          signal: controller.signal,
          headers: { 
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36" 
          }
        });
        clearTimeout(timeoutId);
        
        if (fetchRes.ok) {
          const html = await fetchRes.text();
          const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
          const metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) || 
                               html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i) ||
                               html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
          
          if (titleMatch && titleMatch[1] && !youtubeTitle) {
            pageText += `\n[網頁標題]: ${titleMatch[1].trim()}`;
          }
          if (metaDescMatch && metaDescMatch[1]) {
            pageText += `\n[預設說明的內容大綱/網頁摘要]: ${metaDescMatch[1].trim()}`;
          }
        }
      } catch (e) {
        console.log("網頁標題網址資訊擷取失敗:", e);
      }

      contents.push({
        text: `以下是用戶提供的影音連結/YouTube 網址資訊。請分析該影片之主題、頻道資訊與代表性內容。進一步精雕細琢出繁體中文的大綱、主題細部分段、核心專門概念、與行動方針。
影音網址連結：${videoLink}

${pageText ? `\n系統已偵測並讀取到該連結的標題或網頁簡介如下，可供摘要與理解參考：\n${pageText}\n` : ""}
${retrievedSubtitles ? `\n【關鍵資訊】系統已成功探測並提取影片的真實原始字幕/逐字稿內容如下（此為影片中真實說話的內容，請以此進行高精度的繁體中文摘要、大分段與精簡大綱製作）：\n${retrievedSubtitles}\n` : `\n【提示】未能在線上直接檢索到該連結的語音字幕（此影片可能由創作者關閉了字幕或尚未生成語法自動聽寫）。請根據影片標題：${youtubeTitle || "未取得"}（來自頻道：${youtubeChannel || "未取得"}), 以及網頁預設描述。請結合您的廣博世界知識庫與對此一標題/學科主題領域的深度理解，撰寫富有邏輯的大綱、分段講義、代表性的核心概念、與行動方案。切勿返回空內容，必須為觀看此主題的用戶產出極具啟發性、高精準度的專題筆記！`}

請重組、聽寫或撰寫出完美的影音內容故事線（在 transcript 欄位中寫出此影片主要內容的逐字稿大綱或其詳盡的口語陳述，不少於 500 字，確保內容豐富真實，如果是 YouTube 連結，請盡量推演或復原其真實說話細節）。`
      });
    } else {
      // It's a file or recorded audio
      if (!fileData) {
        return res.status(400).json({ error: "未上傳有效的音訊或影片檔案數據！" });
      }
      contents.push({
        inlineData: {
          mimeType: mimeType || "audio/mp3",
          data: fileData, // This is the base64 encoded media string
        },
      });
      contents.push({
        text: `請仔細聆聽並分析上傳的影音檔案（原檔名: ${fileName || "未命名影音"}），為其進行精確的聽寫、重點整理，並依據選項進行目標語系翻譯。`,
      });
    }

    // Define response JSON schema
    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        title: {
          type: Type.STRING,
          description: "影片或音訊內容的專業標題 (應使用繁體中文)",
        },
        originalLanguage: {
          type: Type.STRING,
          description: "偵測到的原始影音發音語系 (例如: 繁體中文, English, 日本語, 한국어, 混合型)",
        },
        transcript: {
          type: Type.STRING,
          description: "原始影音的完整逐字稿、聽寫結果、或精確的時間軸敘事摘要 (字數應充足且語意通順)",
        },
        summaryText: {
          type: Type.STRING,
          description: "適合高階決策或快速閱讀的核心內容概要（2-3個段落）",
        },
        segments: {
          type: Type.ARRAY,
          description: "分章節、時間標記或主題模組的細部整理",
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING, description: "此主題片段的標題" },
              timeRange: { type: Type.STRING, description: "時間區間，如 '01:10 - 03:45'，如無法精確估算則用 '主題 1', '主題 2'" },
              summary: { type: Type.STRING, description: "此主題片段的重點要點，可多行或包含項目條列" },
            },
            required: ["title", "summary"],
          },
        },
        keyConcepts: {
          type: Type.ARRAY,
          description: "從影音中提取的 5-8 個核心技術名詞、人物、專有名詞、或是核心思維",
          items: { type: Type.STRING },
        },
        actionItems: {
          type: Type.ARRAY,
          description: "從影音內容萃取的行動清單、決議事項或下一步待辦步驟",
          items: { type: Type.STRING },
        },
        translations: {
          type: Type.OBJECT,
          description: "各目標語言的完整高質感 summary 排版結果 (內含 markdown 格式)",
          properties: {
            zh: { type: Type.STRING, description: "傳統繁體中文 (台灣) 高質感 Markdown 整理與延伸結論" },
            en: { type: Type.STRING, description: "Professional English Markdown Summary/Takeaways" },
            ja: { type: Type.STRING, description: "Japanese Business Professional Markdown Summary" },
            ko: { type: Type.STRING, description: "Korean Formal Presentation Business Markdown Summary" },
          },
        },
      },
      required: [
        "title",
        "originalLanguage",
        "transcript",
        "summaryText",
        "segments",
        "keyConcepts",
        "actionItems",
        "translations",
      ],
    };

    const tools = (mediaType === "link") ? [{ googleSearch: {} }] : undefined;

    const { response, usedModel } = await generateContentWithRetryAndFallback(ai, {
      contents: contents,
      systemInstruction: systemInstruction,
      responseSchema: responseSchema,
      tools: tools,
    });

    const outputText = response.text;
    if (!outputText) {
      throw new Error("Gemini 回傳了空的分析內容。請確定檔案並未損毀且內容有清晰人聲。");
    }

    const structuredResult = JSON.parse(outputText.trim());
    return res.json({ success: true, result: structuredResult, usedModel: usedModel });

  } catch (error: any) {
    console.error("Transcription & Summarization Error: ", error);
    let errMsg = error.message || "伺服器處理影音時發生未知錯誤，請重試或更換檔案。";
    const errStr = String(errMsg).toLowerCase();
    
    if (errStr.includes("resource_exhausted") || errStr.includes("quota") || errStr.includes("429")) {
      errMsg = "【API 額度上限提示】此錯誤代表目前所使用的 Gemini API 金鑰已達到最高每分鐘請求限制 (RPM) 或可用的免費總配額上限。您可以選擇「稍等一分鐘後再試」；或者強烈建議點選右上角的【⚙️ 設定與金鑰 (Settings)】，新增並設定您的個人 GEMINI_API_KEY，即可享有極速、穩定且更充足的分析容量！";
    }

    return res.status(500).json({
      success: false,
      error: errMsg,
    });
  }
});

// Vite & Static file handler registration
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("Vite development server mounted as middleware.");
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
    console.log(`Serving static files from ${distPath}`);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running at http://localhost:${PORT}`);
  });
}

startServer();
