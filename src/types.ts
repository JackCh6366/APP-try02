export type SummaryDepth = "quick" | "detailed" | "mindmap";
export type PrimaryGoal = "takeaways" | "actions" | "full-transcript";
export type AIProvider = "gemini" | "nvidia";

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
