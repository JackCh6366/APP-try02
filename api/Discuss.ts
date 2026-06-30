// api/discuss.ts
// Vercel Serverless Function: 針對已產生的分析結果進行 AI 對話討論
// 風格與 api/generate.ts 一致：原生 fetch，不依賴 @google/genai SDK

export const config = {
  api: {
    bodyParser: { sizeLimit: "5mb" },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

interface CurrentResult {
  title: string;
  summaryText: string;
  sections: { title: string; timeRange?: string; summary: string }[];
  keyConcepts: string[];
  actionItems: string[];
  translations: Record<string, string>;
}

interface DiscussBody {
  provider: "gemini" | "nvidia";
  usedModel?: string;
  currentResult: CurrentResult;
  chatHistory: ChatTurn[];
  userMessage: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function summarizeCurrentResult(result: CurrentResult): string {
  const sectionsText = result.sections
    .map((s) => `- ${s.title}${s.timeRange ? `（${s.timeRange}）` : ""}：${s.summary}`)
    .join("\n");
  const langs = Object.keys(result.translations || {}).filter((l) => result.translations[l]);

  return `標題：${result.title}

摘要：
${result.summaryText}

分段重點：
${sectionsText || "（無）"}

關鍵概念：${(result.keyConcepts || []).join("、") || "（無）"}
待辦事項：${(result.actionItems || []).join("、") || "（無）"}

已產生的翻譯語言：${langs.join("、") || "（無）"}`;
}

const DISCUSS_SYSTEM_PROMPT = `你是協助使用者理解與調整一份「影音分析摘要結果」的助手。使用者可能會：
1. 單純針對內容提問（例如「這段在說什麼」「能不能解釋第二點」）→ 此時你只需要用繁體中文清楚回答，不需要修改結果。
2. 要求調整內容（例如「請把摘要寫得更詳細」「重點少了某個概念，請補上」「翻譯語氣請更正式」）→ 此時除了文字回覆外，你必須額外提供一份「修正後的完整結果」。

請務必嚴格以下列 JSON 格式回覆，不要包含任何 Markdown 代碼框或其他說明文字：
{
  "reply": "給使用者看的對話回覆內容（繁體中文，自然口語）",
  "hasRevision": true 或 false,
  "revisedResult": null 或 完整的修正後結果物件（僅在 hasRevision 為 true 時提供）
}

revisedResult 若提供，必須包含完整欄位（不可只給修改的部分，需包含原本沒被改動的內容）：
{
  "title": "標題",
  "summaryText": "完整摘要",
  "sections": [{ "title": "段落標題", "timeRange": "", "summary": "段落內容" }],
  "keyConcepts": ["概念1", "概念2"],
  "actionItems": ["待辦1"],
  "translations": { "zh": "...", "en": "..." }
}

規則：
- 若使用者只是發問、聊天、確認資訊，hasRevision 設為 false，revisedResult 設為 null。
- 若使用者明確要求修改/補充/調整/重寫任何部分，hasRevision 設為 true，並提供完整的 revisedResult。
- revisedResult 中沒有要求修改的欄位，請完整保留原本內容，不要遺漏或清空。
- 直接輸出純 JSON，不要有任何前後綴文字或 Markdown 框線，不要使用註解。`;

function buildUserPrompt(body: DiscussBody): string {
  const contextText = summarizeCurrentResult(body.currentResult);
  const historyText = (body.chatHistory || [])
    .map((t) => `${t.role === "user" ? "使用者" : "AI"}：${t.content}`)
    .join("\n");

  return `【目前的分析結果】
${contextText}

【先前討論紀錄】
${historyText || "（尚無，這是第一次討論）"}

【使用者本次訊息】
${body.userMessage}`;
}

// 解析可能含雜訊（markdown 框、think 標籤等）的模型回應
function parseDiscussJson(rawText: string): any {
  let trimmed = rawText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  trimmed = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("AI 回應中找不到有效的 JSON 結構。");
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini 討論呼叫（與 generate.ts 的 callGemini 同樣使用原生 fetch REST API）
// ─────────────────────────────────────────────────────────────────────────────
async function discussWithGemini(body: DiscussBody, apiKey: string): Promise<any> {
  const MODEL = "gemini-2.5-flash"; // 與 generate.ts 保持一致，暫時改回穩定版本
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const prompt = buildUserPrompt(body);

  const requestBody = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: DISCUSS_SYSTEM_PROMPT }] },
    generationConfig: {
      responseMimeType: "application/json",
      // Gemini 3.x 系列官方建議維持預設 temperature，避免觸發 400 錯誤
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(55_000),
  });

  const json = (await res.json()) as any;

  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${json?.error?.message || JSON.stringify(json)}`);
  }

  const rawText: string = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!rawText) throw new Error("Gemini 討論回應為空。");

  return { ...parseDiscussJson(rawText), usedModel: MODEL };
}

// ─────────────────────────────────────────────────────────────────────────────
// NVIDIA 討論呼叫（純文字，與 generate.ts 的 callNvidia 同樣使用原生 fetch）
// ─────────────────────────────────────────────────────────────────────────────
async function discussWithNvidia(body: DiscussBody, apiKey: string): Promise<any> {
  const MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1"; // 與 generate.ts 現行 NVIDIA 模型保持一致
  const url = "https://integrate.api.nvidia.com/v1/chat/completions";

  const prompt = buildUserPrompt(body);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: DISCUSS_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(55_000),
  });

  const json = (await res.json()) as any;

  if (!res.ok) {
    throw new Error(`NVIDIA API error ${res.status}: ${json?.detail || json?.message || JSON.stringify(json)}`);
  }

  const rawText: string = json?.choices?.[0]?.message?.content ?? "";
  if (!rawText) throw new Error("NVIDIA 討論回應為空。");

  return { ...parseDiscussJson(rawText), usedModel: MODEL };
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

  let body: DiscussBody;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ success: false, error: "Invalid JSON body." });
  }

  if (!body.userMessage?.trim()) {
    return res.status(400).json({ success: false, error: "請輸入討論內容。" });
  }
  if (!body.currentResult) {
    return res.status(400).json({ success: false, error: "缺少目前的分析結果內容。" });
  }

  const provider = body.provider || "gemini";

  try {
    let output: any;

    if (provider === "nvidia") {
      const apiKey = process.env.NVIDIA_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ success: false, error: "NVIDIA_API_KEY not configured." });
      }
      output = await discussWithNvidia(body, apiKey);
    } else {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ success: false, error: "GEMINI_API_KEY not configured." });
      }
      output = await discussWithGemini(body, apiKey);
    }

    return res.status(200).json({ success: true, ...output });
  } catch (err: any) {
    console.error("[discuss] Error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "討論發生錯誤，請稍後重試。",
    });
  }
}