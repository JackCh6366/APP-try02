// 移除 "mindmap"（前端無對應完整輸出）
export type SummaryDepth = "quick" | "detailed";
 
// 移除 "full-transcript"（前端無對應完整輸出）
export type PrimaryGoal = "takeaways" | "actions";
 
export type AIProvider = "gemini" | "nvidia" | "local";

// 本地模型連線設定（Ollama / LM Studio）
export type LocalEngineType = "ollama" | "lmstudio" | "custom";

export interface LocalModelConfig {
  engineType: LocalEngineType;
  baseUrl: string;     // 例：http://localhost:11434 (Ollama) 或 http://localhost:1234 (LM Studio)
  modelName: string;   // 例：llama3.1, qwen2.5:14b 等使用者本機已安裝的模型
}

export const LOCAL_ENGINE_PRESETS: Record<LocalEngineType, { label: string; defaultUrl: string; chatPath: string }> = {
  ollama:   { label: "Ollama",    defaultUrl: "http://localhost:11434", chatPath: "/api/chat" },
  lmstudio: { label: "LM Studio", defaultUrl: "http://localhost:1234",  chatPath: "/v1/chat/completions" },
  custom:   { label: "自訂端點",   defaultUrl: "http://localhost:8080",  chatPath: "/v1/chat/completions" },
};
 
export interface SummaryOptions {
  depth: SummaryDepth;
  primaryGoal: PrimaryGoal;
  targetLanguages: string[]; // 'zh' (Traditional Chinese), 'en' (English), 'ja' (Japanese), 'ko' (Korean)
}
 
export interface TopicSection {
  title: string;
  timeRange?: string; // Optional timestamp/range
  summary: string;
}
 
export interface MediaSummaryResult {
  id: string;
  title: string;
  mediaType: "file" | "record" | "transcript_paste" | "link";
  fileName?: string;
  originalLanguage: string;
  transcript: string; // Original input transcript or generated transcription
  summaryText: string; // Comprehensive summary in main language
  sections: TopicSection[]; // Broken down segments
  keyConcepts: string[]; // Important terms / concepts
  actionItems: string[]; // To do items extracted
  translations: Record<string, string>; // Language Code -> Translated formatted content (Markdown)
  createdAt: string;
  usedModel?: string;
}
 
export interface SummaryHistoryItem {
  id: string;
  title: string;
  mediaType: "file" | "record" | "transcript_paste" | "link";
  createdAt: string;
}

// ── 結果討論功能 ─────────────────────────────────────────────────────────────
export interface DiscussChatTurn {
  role: "user" | "assistant";
  content: string;
  hasRevision?: boolean; // 此則 AI 回覆是否附帶修正建議
  revisedResult?: DiscussRevisedResult; // 修正建議內容
  revisionStatus?: "pending" | "adopted" | "discarded"; // 使用者對此修正建議的處理狀態
}

export interface DiscussRevisedResult {
  title: string;
  summaryText: string;
  sections: TopicSection[];
  keyConcepts: string[];
  actionItems: string[];
  translations: Record<string, string>;
}