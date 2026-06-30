import { useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  FileText,
  Clock,
  Globe,
  CheckSquare,
  Bookmark,
  Copy,
  Check,
  Download,
  Cpu,
  CornerDownRight,
  GitCommit,
  Network,
  Activity,
  ListChecks,
} from "lucide-react";
import { MediaSummaryResult } from "../types";

interface SummaryResultProps {
  data: MediaSummaryResult;
}

export default function SummaryResult({ data }: SummaryResultProps) {
  // 移除 "transcript" 頁籤，只保留四個有實際內容的頁籤
  const [activeTab, setActiveTab] = useState<"summary" | "segments" | "translations" | "mindmap">("summary");
  const [activeLangTab, setActiveLangTab] = useState<string>("zh");
  const [copiedText, setCopiedText] = useState<string | null>(null);

  const availableLangs = Object.keys(data.translations).filter((l) => data.translations[l]);
  const defaultLang = availableLangs.includes("zh") ? "zh" : availableLangs[0] || "en";
  const currentLang = data.translations[activeLangTab] ? activeLangTab : defaultLang;

  const handleCopy = (text: string, type: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(type);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const getLanguageName = (code: string) => {
    switch (code) {
      case "zh": return "繁體中文 (ZH)";
      case "en": return "English (EN)";
      case "ja": return "日本語 (JA)";
      case "ko": return "한국어 (KO)";
      default: return code.toUpperCase();
    }
  };

  const handleDownloadMarkdown = () => {
    let mdContent = `# ${data.title}\n\n`;
    mdContent += `* **媒體來源類別**: ${data.mediaType === "file" ? "上傳檔案" : data.mediaType === "record" ? "現場錄音" : data.mediaType === "link" ? "網頁連結" : "字幕逐字稿"}\n`;
    mdContent += `* **偵測發音語系**: ${data.originalLanguage}\n`;
    mdContent += `* **整理日期**: ${new Date(data.createdAt).toLocaleString()}\n\n`;
    mdContent += `## 摘要大綱\n\n${data.summaryText}\n\n`;
    mdContent += `## 核心概念\n\n`;
    data.keyConcepts.forEach((c) => { mdContent += `- ${c}\n`; });
    mdContent += `\n## 行動方針與重點事項\n\n`;
    data.actionItems.forEach((item) => { mdContent += `- ${item}\n`; });
    mdContent += `\n## 主題分段紀要\n\n`;
    data.sections.forEach((seg) => {
      mdContent += `### ${seg.title}${seg.timeRange ? ` (${seg.timeRange})` : ""}\n\n${seg.summary}\n\n`;
    });
    mdContent += `## 多語系翻譯對照\n\n`;
    availableLangs.forEach((lang) => {
      mdContent += `### === ${getLanguageName(lang)} ===\n\n${data.translations[lang]}\n\n`;
    });

    const blob = new Blob([mdContent], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${data.title.replace(/\s+/g, "_")}_AI重點包.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-md p-6 space-y-6">

      {/* 頂部標題列 */}
      <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-slate-100 pb-5 gap-4">
        <div>
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-100">
            <Cpu className="h-3.5 w-3.5 text-indigo-500 animate-spin-slow" />
            <span>AI 分析模型：{data.usedModel || "gemini-2.5-flash-lite"}</span>
          </span>
          <h2 className="text-xl font-extrabold text-slate-900 mt-2">{data.title}</h2>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2 text-xs text-slate-500 font-medium">
            <span>影音原始語系: <strong className="text-slate-700">{data.originalLanguage}</strong></span>
            <span>•</span>
            <span>處理方式: <strong className="text-slate-700">
              {data.mediaType === "file" ? "檔案上傳" : data.mediaType === "record" ? "智慧錄音" : data.mediaType === "link" ? "網頁連結" : "手動字幕輸入"}
            </strong></span>
            <span>•</span>
            <span>整理時間: <strong className="text-slate-700">{new Date(data.createdAt).toLocaleDateString()}</strong></span>
          </div>
        </div>

        <div className="flex items-center space-x-2 shrink-0">
          <button
            onClick={() => handleCopy(JSON.stringify(data, null, 2), "data")}
            className="flex items-center space-x-1.5 border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50 rounded-lg p-2 text-xs font-semibold cursor-pointer transition-all"
            title="複製 JSON 格式"
          >
            {copiedText === "data" ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
            <span className="hidden sm:inline">複製數據</span>
          </button>
          <button
            onClick={handleDownloadMarkdown}
            className="flex items-center space-x-1.5 bg-indigo-600 text-white hover:bg-indigo-700 rounded-lg py-2 px-3.5 text-xs font-bold cursor-pointer transition-all shadow-xs"
          >
            <Download className="h-4 w-4" />
            <span>下載完整 Markdown 重點</span>
          </button>
        </div>
      </div>

      {/* 頁籤列（移除「聽寫明細逐字稿」） */}
      <div className="flex border-b border-slate-100 pb-px overflow-x-auto space-x-1 scrollbar-thin">
        {[
          { key: "summary", icon: <Bookmark className="h-4 w-4" />, label: "核心彙整大綱" },
          { key: "segments", icon: <Clock className="h-4 w-4" />, label: "時間軸/分段紀要" },
          { key: "translations", icon: <Globe className="h-4 w-4" />, label: "多語系對照翻譯" },
          { key: "mindmap", icon: <Network className="h-4 w-4" />, label: "結構關聯圖" },
        ].map(({ key, icon, label }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key as any)}
            className={`flex items-center space-x-1.5 pb-2.5 px-4 font-bold text-sm border-b-2 transition-all shrink-0 cursor-pointer ${
              activeTab === key
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-slate-400 hover:text-slate-600"
            }`}
          >
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* 頁籤內容 */}
      <div className="pt-2">

        {/* TAB 1: 核心彙整大綱 */}
        {activeTab === "summary" && (
          <div className="space-y-6">
            {/* Executive Summary */}
            <div className="p-5 rounded-xl bg-indigo-50/20 border border-indigo-100 flex items-start space-x-4">
              <div className="mt-0.5 p-2 bg-indigo-600 text-white rounded-lg shrink-0">
                <Bookmark className="h-4 w-4" />
              </div>
              <div>
                <h4 className="text-xs font-extrabold text-slate-400 tracking-wider uppercase mb-1">
                  高階核心概要 EXECUTIVE SUMMARY
                </h4>
                <p className="text-slate-800 text-sm leading-relaxed font-medium">
                  {data.summaryText}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* 核心關鍵詞 */}
              <div className="space-y-3">
                <div className="flex items-center space-x-2">
                  <Activity className="h-4 w-4 text-slate-700 animate-pulse" />
                  <h3 className="text-sm font-extrabold text-slate-800 uppercase tracking-wider">核心關鍵詞／概念精選</h3>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {data.keyConcepts.map((concept, index) => (
                    <div key={index} className="p-3 bg-white border border-slate-100 shadow-xs hover:border-slate-300 rounded-lg transition-all flex items-start space-x-2">
                      <span className="font-mono text-slate-300 text-xs mt-0.5 font-bold">#{(index + 1).toString().padStart(2, "0")}</span>
                      <span className="text-slate-700 text-xs font-bold leading-tight select-all">{concept}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* 行動方針 — 純文字清單，移除勾選框 */}
              <div className="space-y-3">
                <div className="flex items-center space-x-2">
                  <ListChecks className="h-4 w-4 text-slate-700" />
                  <h3 className="text-sm font-extrabold text-slate-800 uppercase tracking-wider">萃取行動方針與重點事項</h3>
                </div>
                <div className="border border-slate-100 p-4 rounded-xl bg-white space-y-2.5">
                  {data.actionItems.length === 0 ? (
                    <p className="text-xs text-slate-400 py-6 text-center">本媒體無提煉出具體行動方針</p>
                  ) : (
                    data.actionItems.map((item, index) => (
                      <div key={index} className="flex items-start space-x-3 text-slate-700">
                        {/* 純文字數字標記，不用勾選框 */}
                        <span className="shrink-0 mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 text-[10px] font-extrabold border border-indigo-100">
                          {index + 1}
                        </span>
                        <p className="text-xs font-semibold leading-relaxed">{item}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: 時間軸/分段紀要 */}
        {activeTab === "segments" && (
          <div className="space-y-6">
            <div className="relative border-l-2 border-slate-200 ml-4 pl-6 space-y-8 py-2">
              {data.sections.map((seg, index) => (
                <div key={index} className="relative group">
                  <div className="absolute -left-10 top-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600 text-white border-4 border-white shadow-md transition-all group-hover:scale-110">
                    <span className="text-[10px] font-bold font-mono">{index + 1}</span>
                  </div>
                  <div className="bg-slate-50/50 hover:bg-slate-50 border border-slate-100 hover:border-slate-200 rounded-xl p-5 transition-all shadow-xs">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 mb-2.5">
                      <h4 className="text-sm font-extrabold text-slate-900 select-all leading-tight">{seg.title}</h4>
                      {seg.timeRange && (
                        <div className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-md text-[11px] font-mono font-bold bg-slate-200 text-slate-700 w-fit">
                          <Clock className="h-3.5 w-3.5" />
                          <span>{seg.timeRange}</span>
                        </div>
                      )}
                    </div>
                    <p className="text-slate-700 text-xs leading-relaxed font-semibold whitespace-pre-line select-all">{seg.summary}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 3: 多語系對照翻譯 */}
        {activeTab === "translations" && (
          <div className="space-y-4">
            <div className="flex bg-slate-100 p-1 rounded-lg w-max">
              {availableLangs.map((langCode) => (
                <button
                  key={langCode}
                  onClick={() => setActiveLangTab(langCode)}
                  className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${
                    currentLang === langCode ? "bg-white text-indigo-700 shadow-xs" : "text-slate-500 hover:text-slate-900"
                  }`}
                >
                  {getLanguageName(langCode)}
                </button>
              ))}
            </div>

            <div className="relative border border-slate-100 rounded-xl bg-slate-50/30 p-6 shadow-2xs min-h-[250px]">
              <button
                onClick={() => handleCopy(data.translations[currentLang] || "", "translation")}
                className="absolute right-4 top-4 flex items-center space-x-1 border border-slate-200 text-slate-500 hover:text-slate-800 hover:bg-white rounded-lg p-1.5 text-xs font-bold bg-slate-50 cursor-pointer transition-all shadow-2xs"
              >
                {copiedText === "translation" ? (
                  <><Check className="h-3.5 w-3.5 text-emerald-500" /><span>已複製</span></>
                ) : (
                  <><Copy className="h-3.5 w-3.5" /><span>複製</span></>
                )}
              </button>
              <div className="prose prose-slate max-w-none text-slate-800 text-sm leading-relaxed prose-headings:text-slate-900 prose-strong:text-slate-900 prose-ul:list-disc prose-ul:pl-5 select-all">
                <ReactMarkdown>{data.translations[currentLang]}</ReactMarkdown>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: 結構關聯圖 */}
        {activeTab === "mindmap" && (
          <div className="space-y-4">
            <div className="flex items-center space-x-2 text-slate-500 text-xs mb-1">
              <CornerDownRight className="h-4 w-4 text-slate-400" />
              <span>以圖像化樹狀脈絡呈現本媒體中所涉及的重點主題、關鍵詞彙與對應行動方針：</span>
            </div>

            <div className="border border-slate-100 rounded-2xl bg-indigo-50/5 p-6 flex flex-col md:flex-row items-stretch gap-6 shadow-inner min-h-[300px]">
              {/* 根節點 */}
              <div className="flex md:w-1/4 items-center justify-center p-4 bg-indigo-900 text-white rounded-xl text-center shadow-md select-none">
                <div className="space-y-2">
                  <span className="text-[10px] font-extrabold text-indigo-300 tracking-widest uppercase">影音核心主軸</span>
                  <p className="text-xs font-bold leading-snug">{data.title}</p>
                </div>
              </div>

              <div className="hidden md:flex flex-col justify-center items-center pointer-events-none">
                <GitCommit className="h-8 w-8 text-slate-300 transform rotate-90" />
              </div>

              {/* 關鍵概念分支 */}
              <div className="flex-1 space-y-3 bg-white p-4 rounded-xl border border-slate-100">
                <div className="text-xs font-extrabold text-slate-400 tracking-wide uppercase flex items-center justify-between mb-1">
                  <span>💡 關鍵概念分支</span>
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-800"></span>
                </div>
                <div className="space-y-2">
                  {data.keyConcepts.slice(0, 5).map((concept, idx) => (
                    <div key={idx} className="p-2.5 bg-slate-50/50 rounded-lg border border-slate-100 text-xs text-slate-700 font-bold select-all hover:bg-slate-50 transition-all flex items-center justify-between">
                      <span>{concept}</span>
                      <span className="text-[10px] text-slate-300 font-mono">#{idx + 1}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="hidden md:flex flex-col justify-center items-center pointer-events-none">
                <GitCommit className="h-8 w-8 text-slate-300 transform rotate-90" />
              </div>

              {/* 行動方針分支 */}
              <div className="flex-1 space-y-3 bg-white p-4 rounded-xl border border-slate-100">
                <div className="text-xs font-extrabold text-emerald-600 tracking-wide uppercase flex items-center justify-between mb-1">
                  <span>✅ 行動方針分支</span>
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
                </div>
                <div className="space-y-2">
                  {data.actionItems.length === 0 ? (
                    <p className="text-xs text-slate-400 text-center py-6">此媒體無對應行動方針</p>
                  ) : (
                    data.actionItems.slice(0, 5).map((item, idx) => (
                      <div key={idx} className="p-2.5 bg-emerald-50/10 rounded-lg border border-emerald-100/50 text-xs text-slate-800 font-semibold select-all hover:bg-emerald-50/30 transition-all">
                        {item}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
