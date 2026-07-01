// src/lib/localProvider.ts
//
// 直接從瀏覽器呼叫使用者「自己電腦」上的 Ollama / LM Studio。
// 這支模組完全在前端執行，不經過 Vercel 後端，
// 因為雲端伺服器無法連到使用者的 localhost。
//
// 使用前提：
// 1. 使用者已在本機安裝並啟動 Ollama 或 LM Studio
// 2. Ollama 需要設定環境變數 OLLAMA_ORIGINS=* 才允許網頁跨域呼叫
//    （Windows: setx OLLAMA_ORIGINS "*"，Mac/Linux: export OLLAMA_ORIGINS=*，之後重啟 Ollama）
// 3. LM Studio 需在「Local Server」分頁啟動伺服器並允許 CORS（內建大多預設允許）

import { LocalModelConfig, LOCAL_ENGINE_PRESETS } from "../types";

export interface LocalGenerateResult {
  title: string;
  originalLanguage: string;
  transcript: string;
  summaryText: string;
  segments: { title: string; timeRange?: string; summary: string }[];
  keyConcepts: string[];
  actionItems: string[];
  translations: Record<string, string>;
}

interface LocalGenerateParams {
  config: LocalModelConfig;
  textTranscript: string; // 本地模型只走純文字路徑（文字稿 / YouTube 字幕）
  options: {
    depth: "quick" | "detailed";
    primaryGoal: "takeaways" | "actions";
    targetLanguages: string[];
  };
}

// ── 連線測試：確認使用者的本地伺服器是否可連線 ──────────────────────────
export async function testLocalConnection(config: LocalModelConfig): Promise<{ ok: boolean; message: string; models?: string[] }> {
  try {
    if (config.engineType === "ollama") {
      const res = await fetch(`${config.baseUrl}/api/tags`, { method: "GET" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const models = (data.models || []).map((m: any) => m.name);
      return { ok: true, message: `連線成功，偵測到 ${models.length} 個本地模型`, models };
    } else {
      // LM Studio / 自訂端點皆走 OpenAI 相容 /v1/models
      const res = await fetch(`${config.baseUrl}/v1/models`, { method: "GET" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const models = (data.data || []).map((m: any) => m.id);
      return { ok: true, message: `連線成功，偵測到 ${models.length} 個已載入模型`, models };
    }
  } catch (err: any) {
    return {
      ok: false,
      message: `無法連線到 ${config.baseUrl}。請確認：1) 服務已啟動 2) 已設定允許跨域(CORS) 3) 網址正確。錯誤：${err.message}`,
    };
  }
}

// ── 組裝與 Gemini/NVIDIA 一致的 Prompt ──────────────────────────────────
function buildPrompt(textTranscript: string, options: LocalGenerateParams["options"]): string {
  const langMap: Record<string, string> = { zh: "繁體中文", en: "英文", ja: "日文", ko: "韓文" };
  const targetLangText = options.targetLanguages.map((l) => langMap[l] || l).join("、");
  const depthText = options.depth === "detailed" ? "請提供深度章節解析，內容須完整、詳盡（盡量超過 3000 字），保留重要脈絡與細節。" : "請提供簡短精華大綱，只提煉最核心重點（約 500-800 字）。";
  const goalText = options.primaryGoal === "actions" ? "請特別著重萃取『待辦事項』與『行動項目』。" : "請特別著重整理『重點結論』與『關鍵要點』。";

  return `你是一位專業的內容分析助手。請分析以下逐字稿內容，並嚴格以 JSON 格式回覆，不要包含任何 Markdown 程式碼框或其他說明文字。

${depthText}
${goalText}
請將內容翻譯為以下語言並放入 translations 欄位：${targetLangText}

JSON 結構必須符合：
{
  "title": "內容標題",
  "originalLanguage": "偵測到的原始語言",
  "transcript": "原始逐字稿（可截斷重複內容但保留完整意義）",
  "summaryText": "完整摘要內容",
  "segments": [{ "title": "段落標題", "timeRange": "", "summary": "段落摘要" }],
  "keyConcepts": ["關鍵概念1", "關鍵概念2"],
  "actionItems": ["待辦事項1"],
  "translations": { "zh": "繁中版本", "en": "英文版本" }
}

逐字稿內容如下：
---
${textTranscript.slice(0, 30000)}
---

請直接輸出 JSON，不要有任何前後綴文字。`;
}

// ── 修正 AI 回應中常見的「JSON 字串內夾帶原始控制字元」問題（與後端邏輯一致）──
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

// ── 嘗試從可能包含雜訊的回應中解析出 JSON ──────────────────────────────
function extractJSON(text: string): any {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) throw new Error("回應中找不到有效的 JSON 結構");
  cleaned = sanitizeJsonControlChars(cleaned.slice(firstBrace, lastBrace + 1));
  try {
    return JSON.parse(cleaned);
  } catch {
    // 嘗試修補常見的截斷問題：補齊括號
    let repaired = cleaned;
    const openBraces = (repaired.match(/\{/g) || []).length;
    const closeBraces = (repaired.match(/\}/g) || []).length;
    repaired += "}".repeat(Math.max(0, openBraces - closeBraces));
    return JSON.parse(repaired);
  }
}

// ── 主要呼叫函式：依引擎類型分流呼叫 ────────────────────────────────────
export async function generateWithLocalModel(params: LocalGenerateParams): Promise<LocalGenerateResult> {
  const { config, textTranscript, options } = params;
  const prompt = buildPrompt(textTranscript, options);
  const preset = LOCAL_ENGINE_PRESETS[config.engineType];

  let rawText: string;

  if (config.engineType === "ollama") {
    const res = await fetch(`${config.baseUrl}${preset.chatPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.modelName,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        options: { temperature: 0.4 },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama 回應錯誤 (${res.status}): ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    rawText = data?.message?.content;
    if (!rawText) throw new Error("Ollama 回應為空，請確認模型名稱是否正確（例如 llama3.1, qwen2.5:14b）");
  } else {
    // LM Studio / 自訂端點：OpenAI 相容格式
    const res = await fetch(`${config.baseUrl}${preset.chatPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.modelName || "local-model",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
        stream: false,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`本地伺服器回應錯誤 (${res.status}): ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    rawText = data?.choices?.[0]?.message?.content;
    if (!rawText) throw new Error("本地模型回應為空，請確認 LM Studio 已載入模型並啟動伺服器");
  }

  const parsed = extractJSON(rawText);

  return {
    title: parsed.title || "本地模型分析結果",
    originalLanguage: parsed.originalLanguage || "未知",
    transcript: parsed.transcript || textTranscript.slice(0, 5000),
    summaryText: parsed.summaryText || "",
    segments: Array.isArray(parsed.segments) ? parsed.segments : [],
    keyConcepts: Array.isArray(parsed.keyConcepts) ? parsed.keyConcepts : [],
    actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
    translations: parsed.translations || {},
  };
}