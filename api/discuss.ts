// api/discuss.ts
// 針對已產生的分析結果進行 AI 對話討論，支援追問與修正後重新產出

export const config = {
  api: { bodyParser: { sizeLimit: "2mb" } },
};

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
  provider: "gemini" | "nvidia" | "local";
  usedModel?: string;
  currentResult: CurrentResult;
  chatHistory: ChatTurn[];
  userMessage: string;
}

function buildContext(result: CurrentResult): string {
  const sections = (result.sections || [])
    .map((s) => `- ${s.title}${s.timeRange ? `（${s.timeRange}）` : ""}：${s.summary}`)
    .join("\n");
  const langs = Object.keys(result.translations || {}).filter((l) => result.translations[l]);
  return `標題：${result.title}
摘要：${result.summaryText}
分段：\n${sections || "（無）"}
關鍵概念：${(result.keyConcepts || []).join("、") || "（無）"}
待辦事項：${(result.actionItems || []).join("、") || "（無）"}
已翻譯語言：${langs.join("、") || "（無）"}`;
}

const SYSTEM_PROMPT = `你是協助使用者理解與調整「影音分析摘要結果」的助手。
使用者可能單純提問，也可能要求修改內容。

嚴格以以下 JSON 格式回覆（不含 Markdown 框線、不含任何說明文字）：
{
  "reply": "繁體中文回覆內容",
  "hasRevision": false,
  "revisedResult": null
}

若使用者要求修改內容，則 hasRevision 設為 true，revisedResult 提供修改後的完整結果：
{
  "reply": "說明本次修改的內容",
  "hasRevision": true,
  "revisedResult": {
    "title": "標題",
    "summaryText": "完整摘要",
    "sections": [{"title": "段落", "timeRange": "", "summary": "內容"}],
    "keyConcepts": ["概念"],
    "actionItems": ["待辦"],
    "translations": {"zh": "...", "en": "..."}
  }
}

規則：
- revisedResult 未修改的欄位必須完整保留原本內容
- 直接輸出 JSON，不加任何前後綴`;

function buildPrompt(body: DiscussBody): string {
  const history = (body.chatHistory || [])
    .map((t) => `${t.role === "user" ? "使用者" : "AI"}：${t.content}`)
    .join("\n");
  return `【目前分析結果】\n${buildContext(body.currentResult)}\n\n【對話記錄】\n${history || "（第一次討論）"}\n\n【使用者訊息】\n${body.userMessage}`;
}

/**
 * 修正 AI 模型回應中常見的「JSON 字串欄位內夾帶原始控制字元（如真正換行）」問題。
 * 與 api/generate.ts 中的同名邏輯一致：只在字串內部才把控制字元轉成合法跳脫序列。
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

function parseJson(raw: string): any {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  text = sanitizeJsonControlChars(text);
  try { return JSON.parse(text); } catch {
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s < 0 || e <= s) throw new Error("AI 回應中找不到有效 JSON。");
    return JSON.parse(text.slice(s, e + 1));
  }
}

// ── Gemini（與 generate.ts 完全相同的 native fetch 風格）──
async function withGemini(body: DiscussBody, apiKey: string) {
  const MODEL = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: buildPrompt(body) }] }],
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: { responseMimeType: "application/json" },
    }),
    signal: AbortSignal.timeout(55_000),
  });
  const json = await res.json() as any;
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${json?.error?.message || JSON.stringify(json)}`);
  const raw: string = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!raw) throw new Error("Gemini 回應為空。");
  return { ...parseJson(raw), usedModel: MODEL };
}

// ── NVIDIA（與 generate.ts 的 callNvidia 完全相同風格）──
async function withNvidia(body: DiscussBody, apiKey: string) {
  const MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1.5";
  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPrompt(body) },
      ],
      temperature: 0.2,
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(55_000),
  });
  const json = await res.json() as any;
  if (!res.ok) throw new Error(`NVIDIA API error ${res.status}: ${json?.detail || json?.message || JSON.stringify(json)}`);
  const raw: string = json?.choices?.[0]?.message?.content ?? "";
  if (!raw) throw new Error("NVIDIA 回應為空。");
  const cleaned = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "").trim();
  return { ...parseJson(cleaned), usedModel: MODEL };
}

export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed." });

  let body: DiscussBody;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ success: false, error: "Invalid JSON body." });
  }

  if (!body.userMessage?.trim()) return res.status(400).json({ success: false, error: "請輸入訊息。" });
  if (!body.currentResult) return res.status(400).json({ success: false, error: "缺少分析結果內容。" });

  const provider = body.provider === "nvidia" ? "nvidia" : "gemini";

  try {
    const output = provider === "nvidia"
      ? await withNvidia(body, process.env.NVIDIA_API_KEY || "")
      : await withGemini(body, process.env.GEMINI_API_KEY || "");

    if (!process.env[provider === "nvidia" ? "NVIDIA_API_KEY" : "GEMINI_API_KEY"]) {
      return res.status(500).json({ success: false, error: `${provider.toUpperCase()}_API_KEY not configured.` });
    }

    return res.status(200).json({ success: true, ...output });
  } catch (err: any) {
    console.error("[discuss]", err);
    return res.status(500).json({ success: false, error: err.message || "討論發生錯誤，請稍後重試。" });
  }
}