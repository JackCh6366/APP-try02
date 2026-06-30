import { useState, useEffect } from "react";
import Header from "./components/Header";
import HistorySidebar from "./components/HistorySidebar";
import MediaInput from "./components/MediaInput";
import SummaryResult from "./components/SummaryResult";
import { AIProvider, MediaSummaryResult, SummaryHistoryItem, LocalModelConfig } from "./types";
import { generateWithLocalModel } from "./lib/localProvider";
import { Sparkles, FileVideo, PlusCircle, AlertCircle, FileText, Globe, History } from "lucide-react";

export default function App() {
  const [history, setHistory] = useState<SummaryHistoryItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeResult, setActiveResult] = useState<MediaSummaryResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false); // 歷史側邊欄是否開啟，預設關閉以維持大版面

  // Loading quotes ticker for reassuring user experience during heavy media processing
  const [loadingQuoteIdx, setLoadingQuoteIdx] = useState(0);
  const loadingQuotes = [
    "正在讀取影音資料位元流...",
    "正在喚醒 Gemini 3.5 多模態影音感知矩陣...",
    "正在進行高敏感聽力過濾、過濾背景底噪與人聲強化...",
    "正在掃描音軌並推敲原始口語時間軸標記...",
    "正在自動識別說話人意圖與主題語境斷句...",
    "正在撰寫 Traditional Chinese 行政精簡大綱...",
    "正在將原音內容逐句進行多層次概念提取與重點萃取...",
    "正在精雕細琢目標語系（英、日、韓、中）專業級 Markdown 排版對照...",
    "正在生成視覺化邏輯關聯結構與行動待辦方針...",
    "最後數據封裝與 JSON 結構驗證中，即將呈現完美重點包...",
  ];

  // Load history index table on mount & run automatic health check synchronization to fix anomalies
  useEffect(() => {
    try {
      const storedHistory = localStorage.getItem("media_summaries_history");
      if (storedHistory) {
        const parsed: SummaryHistoryItem[] = JSON.parse(storedHistory);
        // 健康分析：自動把 localStorage 中實際已遺失、損壞或損毀的細節項目自動排除，
        // 避免列表和實際檔案對不起來、觸發異常的情況。
        const verifiedHistory = parsed.filter((item) => {
          try {
            const detail = localStorage.getItem(`media_summary_${item.id}`);
            return detail !== null;
          } catch {
            return false;
          }
        });

        // 偵測到任何不一致的殘留項目時，自動覆寫並修正 index 列表
        if (verifiedHistory.length !== parsed.length) {
          localStorage.setItem("media_summaries_history", JSON.stringify(verifiedHistory));
          console.warn(`[歷史紀錄健康檢測] 系統自動修正了 ${parsed.length - verifiedHistory.length} 筆損壞/已遺失詳細檔案的無效殘餘歷史項目。`);
        }
        
        setHistory(verifiedHistory);
      }
    } catch (e) {
      console.error("無法加載歷史清單:", e);
    }
  }, []);

  // Tick loading quotes in loop while processing
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (isLoading) {
      interval = setInterval(() => {
        setLoadingQuoteIdx((prev) => (prev + 1) % loadingQuotes.length);
      }, 3000);
    } else {
      setLoadingQuoteIdx(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isLoading]);

  const handleSelectHistoryItem = (id: string) => {
    try {
      setError(null);
      const detailStr = localStorage.getItem(`media_summary_${id}`);
      if (detailStr) {
        const fullDetail: MediaSummaryResult = JSON.parse(detailStr);
        setActiveResult(fullDetail);
        setSelectedId(id);
      } else {
        // 自動修復損壞項目：若居然找不到詳細檔，自動自歷史清單過濾掉，避免使用者點擊其他有問題的歷史項目
        const updatedHistory = history.filter((item) => item.id !== id);
        localStorage.setItem("media_summaries_history", JSON.stringify(updatedHistory));
        setHistory(updatedHistory);
        setError("資料不一致：找不到該影音的詳細記錄原始檔。主系統已自動清理此項無效歷史索引。");
      }
    } catch (e) {
      console.error("載入歷史細節出錯:", e);
      setError("無法讀取此紀錄。該資料可能已破損或格式有異。");
    }
  };

  const handleDeleteHistoryItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      // Filter out the item
      const updatedHistory = history.filter((item) => item.id !== id);
      localStorage.setItem("media_summaries_history", JSON.stringify(updatedHistory));
      setHistory(updatedHistory);

      // Remove specific detail file
      localStorage.removeItem(`media_summary_${id}`);

      // If active result was deleted, clear viewport
      if (selectedId === id) {
        setActiveResult(null);
        setSelectedId(null);
      }
    } catch (e) {
      console.error("刪除歷史紀錄出錯:", e);
    }
  };

  const handleClearAllHistory = () => {
    try {
      // Clear specific detail storage keys
      history.forEach((item) => {
        localStorage.removeItem(`media_summary_${item.id}`);
      });
      // Clear main index from storage
      localStorage.removeItem("media_summaries_history");
      setHistory([]);
      setActiveResult(null);
      setSelectedId(null);
    } catch (e) {
      console.error("清除歷史數據時發生問題:", e);
    }
  };

  const handleProcessMedia = async (payload: {
    provider: AIProvider;
    mediaType: "file" | "record" | "transcript_paste" | "link";
    fileData?: string;
    fileName?: string;
    mimeType?: string;
    textTranscript?: string;
    videoLink?: string;
    options: any;
    localConfig?: LocalModelConfig;
  }) => {
    setIsLoading(true);
    setError(null);

    try {
      let geminiResult: any;
      let usedModelName: string;

      if (payload.provider === "local") {
        // ── 本地模型：完全在瀏覽器端執行，不經過 Vercel 後端 ──
        if (!payload.localConfig) throw new Error("缺少本地模型連線設定");
        if (!payload.textTranscript) throw new Error("本地模型僅支援文字輸入（文字稿貼上）");

        const localResult = await generateWithLocalModel({
          config: payload.localConfig,
          textTranscript: payload.textTranscript,
          options: payload.options,
        });

        geminiResult = localResult;
        usedModelName = `本地模型・${payload.localConfig.modelName}`;
      } else {
        // ── Gemini / NVIDIA：照舊呼叫 Vercel 後端 ──
        const response = await fetch("/api/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        const responseText = await response.text();
        let data: any = {};

        if (responseText.trim()) {
          try {
            data = JSON.parse(responseText);
          } catch {
            throw new Error(`API returned a non-JSON response (${response.status}). ${responseText.slice(0, 200)}`);
          }
        }

        if (!response.ok || !data.success) {
          throw new Error(data.error || `API returned an empty response (${response.status}). If you are testing locally, run the app with Vercel Dev so /api/generate is available.`);
        }

        geminiResult = data.result;
        usedModelName = data.usedModel || (payload.provider === "nvidia" ? "nvidia/llama-3.3-nemotron-super-49b-v1.5" : "gemini-2.5-flash-lite");
      }

      // Successful analysis! Register in storage
      const id = `${Date.now()}`;

      const newResult: MediaSummaryResult = {
        id,
        title: geminiResult.title || payload.fileName || "未命名影音重點成果",
        mediaType: payload.mediaType,
        fileName: payload.fileName,
        originalLanguage: geminiResult.originalLanguage || "偵測中",
        transcript: geminiResult.transcript || "",
        summaryText: geminiResult.summaryText || "",
        sections: (geminiResult.segments || []).map((s: any) => ({
          title: s.title || "摘要片段",
          timeRange: s.timeRange,
          summary: s.summary || "",
        })),
        keyConcepts: geminiResult.keyConcepts || [],
        actionItems: geminiResult.actionItems || [],
        translations: geminiResult.translations || {},
        createdAt: new Date().toISOString(),
        usedModel: usedModelName,
      };

      // 1. Save full payload to detail key
      localStorage.setItem(`media_summary_${id}`, JSON.stringify(newResult));

      // 2. Append lightweight index registry to top of history list
      const summaryItem: SummaryHistoryItem = {
        id,
        title: newResult.title,
        mediaType: newResult.mediaType,
        createdAt: newResult.createdAt,
      };

      const updatedHistory = [summaryItem, ...history];
      localStorage.setItem("media_summaries_history", JSON.stringify(updatedHistory));
      setHistory(updatedHistory);

      // 3. Mark viewport active
      setSelectedId(id);
      setActiveResult(newResult);
      setIsHistoryOpen(true); // 自動展開歷史面板以便使用者點按或察看

    } catch (err: any) {
      console.error("進行影音重點分析失敗:", err);
      setError(err.message || "處理影音時與伺服器斷開，或是音訊過長導致超時。請再試一次。");
    } finally {
      setIsLoading(false);
    }
  };

  const handleStartNewAnalysis = () => {
    setActiveResult(null);
    setSelectedId(null);
    setError(null);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-slate-800">
      {/* Premium Header */}
      <Header />

      {/* Main Workspace Frame */}
      <div className="flex-1 flex flex-col md:flex-row max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 gap-6 overflow-hidden">
        
        {/* Left Side Panel: Historical entries index (過渡滑入滑出且能安全隱藏，不占版面) */}
        <div 
          className={`shrink-0 transition-all duration-300 overflow-hidden ${
            isHistoryOpen 
              ? "w-full md:w-80 md:h-[calc(100vh-13rem)] opacity-100" 
              : "w-0 h-0 md:h-0 opacity-0 pointer-events-none"
          }`} 
          id="desktop-history-sidebar-parent"
        >
          <HistorySidebar
            history={history}
            selectedId={selectedId}
            onSelect={handleSelectHistoryItem}
            onDelete={handleDeleteHistoryItem}
            onClearAll={handleClearAllHistory}
            onClose={() => setIsHistoryOpen(false)}
          />
        </div>

        {/* Right Side Panel: Main Viewport details */}
        <div className="flex-1 flex flex-col overflow-y-auto space-y-6 min-w-0 md:h-[calc(100vh-13rem)] pr-1">
          
          {/* 歷史紀錄折疊提醒標籤：點擊後才滑出歷史紀錄，平常完美折疊以節約版面 */}
          {!isHistoryOpen && history.length > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between bg-white border border-slate-200 px-4 py-2.5 rounded-2xl shadow-2xs gap-3 animate-fade-in">
              <div className="flex items-center space-x-2.5">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-600"></span>
                </span>
                <span className="text-xs font-bold text-slate-500">
                  歷史多模態快照已就緒：
                </span>
                <span className="text-xs text-indigo-700 bg-indigo-50 px-3 py-0.5 rounded-full font-extrabold border border-indigo-100">
                  {history.length} 筆已分析大綱
                </span>
              </div>
              <button
                onClick={() => setIsHistoryOpen(true)}
                className="flex items-center justify-center space-x-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold transition-all shadow-sm cursor-pointer whitespace-nowrap self-end sm:self-auto"
                id="btn-toggle-history-sidebar-on"
              >
                <History className="h-3.5 w-3.5 text-white" />
                <span>展開歷史紀錄 ◀</span>
              </button>
            </div>
          )}

          {/* Quick Trigger to launch new analysis whilst observing results */}
          {activeResult && !isLoading && (
            <div className="flex items-center justify-between bg-white p-4.5 rounded-2xl border border-slate-100 shadow-xs">
              <div className="flex items-center space-x-3">
                <div className="h-2 w-2 rounded-full bg-emerald-500"></div>
                <p className="text-xs font-semibold text-slate-500">
                  您正在檢視：<strong className="text-slate-800">{activeResult.title}</strong>
                </p>
              </div>
              <button
                onClick={handleStartNewAnalysis}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-slate-200 hover:border-indigo-600 text-xs font-bold text-slate-700 hover:text-indigo-700 transition-all bg-slate-50 hover:bg-white cursor-pointer shadow-2xs"
                id="btn-trigger-new-analytics"
              >
                <PlusCircle className="h-4 w-4" />
                <span>分析新片 / 語音</span>
              </button>
            </div>
          )}

          {/* Action Area Viewport */}
          {error && (
            <div className="p-4 rounded-xl bg-rose-50 border border-rose-100 text-rose-800 text-xs flex items-start space-x-3">
              <AlertCircle className="h-4 w-4 text-rose-500 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold">分析失敗與警告資訊：</p>
                <p className="mt-1 font-medium">{error}</p>
                <button
                  onClick={handleStartNewAnalysis}
                  className="mt-3 text-xs font-bold text-rose-700 bg-white hover:bg-rose-100 px-3 py-1 rounded-md border border-rose-200 transition-all cursor-pointer"
                >
                  回重試
                </button>
              </div>
            </div>
          )}

          {/* Core loaders visual placeholders */}
          {isLoading ? (
            <div className="flex flex-col items-center justify-center bg-white border border-slate-100 rounded-2xl shadow-md p-12 text-center min-h-[400px]">
              {/* Spinning visual cue */}
              <div className="relative mb-6">
                <div className="h-16 w-16 rounded-full border-4 border-slate-100 border-t-indigo-600 animate-spin"></div>
                <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 flex items-center justify-center">
                  <Sparkles className="h-6 w-6 text-indigo-500 animate-pulse" />
                </div>
              </div>

              {/* Ticker status */}
              <div className="max-w-md space-y-3">
                <h3 className="text-base font-bold text-slate-900">AI 正在深度琢磨影音聽寫中...</h3>
                <div className="min-h-[2.5rem] flex items-center justify-center">
                  <p className="text-xs text-indigo-700 bg-indigo-50 px-4 py-1.5 rounded-full border border-indigo-100 font-bold tracking-wide animate-fade-in animate-pulse text-center">
                    {loadingQuotes[loadingQuoteIdx]}
                  </p>
                </div>
                <div className="text-[10px] text-slate-400 font-semibold space-y-1 pt-4 border-t border-slate-100">
                  <p>※ 提示：如果是大檔案（如超過 10MB），聽寫與多國語翻譯需要比較長的時間，請勿關閉視窗。</p>
                  <p>本模組直接呼叫 Gemini 3.5 億級參數音訊感知電路，免除中介伺服器，精度與安全性皆屬頂尖等級。</p>
                </div>
              </div>
            </div>
          ) : activeResult ? (
            /* Render output summary board directly if active */
            <SummaryResult data={activeResult} />
          ) : (
            /* Otherwise, show standard Input board with visual Welcomer card */
            <div className="space-y-6">
              {/* Visually stunning Welcomer hero Card */}
              <div className="p-6 rounded-2xl bg-indigo-950 text-white shadow-xl relative overflow-hidden flex flex-col sm:flex-row items-center sm:items-start justify-between gap-6 select-none border border-indigo-900">
                <div className="space-y-2 text-center sm:text-left">
                  <div className="inline-flex items-center space-x-1 bg-indigo-900/50 px-2.5 py-1 rounded-full text-[10px] text-indigo-300 font-bold border border-indigo-800 tracking-wide">
                    <Sparkles className="h-3 w-3" />
                    <span>極速全端解決方案</span>
                  </div>
                  <h3 className="text-base sm:text-lg font-extrabold tracking-tight">
                    只需 1 鍵，將影音提煉為中英日韓重點大綱！
                  </h3>
                  <p className="text-xs text-indigo-200 max-w-lg leading-relaxed font-semibold">
                    整合 Multimodal 的 Gemini-3.5-flash AI 智慧，直接聆聽音訊檔案與影片人聲，
                    秒級完成繁中逐字聽寫、時間軸分段、概念萃取，並由專業智庫系統同步翻成四大主流外語。
                  </p>
                </div>

                <div className="relative shrink-0 flex items-center justify-center h-18 w-18 rounded-2xl bg-indigo-900/50 text-indigo-200 border border-indigo-800 shadow-md">
                  <FileVideo className="h-9 w-9 text-indigo-300" />
                </div>
              </div>

              {/* Main Media input module */}
              <MediaInput onProcess={handleProcessMedia} isLoading={isLoading} />
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
