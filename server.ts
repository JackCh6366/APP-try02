import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";

dotenv.config();

const app = express();
const PORT = 3000;

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
      try {
        // Simple fetch to get HTML title/meta description to ground Gemini
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
          
          if (titleMatch && titleMatch[1]) {
            pageText += `\n[擷取網頁標題]: ${titleMatch[1].trim()}`;
          }
          if (metaDescMatch && metaDescMatch[1]) {
            pageText += `\n[擷取網頁簡介/描述]: ${metaDescMatch[1].trim()}`;
          }
        }
      } catch (e) {
        console.log("網頁資訊擷取失敗 (採用純連結模式給 Gemini):", e);
      }

      contents.push({
        text: `以下是用戶提供的影音連結/YouTube 網址。請分析該影片之主題、頻道資訊與代表性內容。進一步精雕細琢出繁體中文的大綱、主題細部分段、核心專門概念、與行動方針。
影音網址連結：${videoLink}
${pageText ? `\n系統自動為您擷取到該連結的部分網頁資訊如下，可供摘要與理解參考：\n${pageText}\n` : ""}
請重組、聽寫聽寫或撰寫出完美的影音內容故事線（在 transcript 欄位中寫出此影片主要內容的逐字稿大綱或其詳盡的口語陳述，不少於 500 字，確保內容豐富真實）。`
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

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: contents,
      config: {
        systemInstruction: systemInstruction,
        responseMimeType: "application/json",
        responseSchema: responseSchema,
        temperature: 0.2, // Low temperature for factual transcription, structuring and translation
      },
    });

    const outputText = response.text;
    if (!outputText) {
      throw new Error("Gemini 回傳了空的分析內容。請確定檔案並未損毀且內容有清晰人聲。");
    }

    const structuredResult = JSON.parse(outputText.trim());
    return res.json({ success: true, result: structuredResult });

  } catch (error: any) {
    console.error("Transcription & Summarization Error: ", error);
    return res.status(500).json({
      success: false,
      error: error.message || "伺服器處理影音時發生未知錯誤，請重試或更換檔案。",
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
