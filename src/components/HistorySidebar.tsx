import { History, FileText, Trash2, Calendar, Search, Film, Mic, AlignLeft, Link } from "lucide-react";
import { useState } from "react";
import { SummaryHistoryItem } from "../types";

interface HistorySidebarProps {
  history: SummaryHistoryItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onClearAll: () => void;
  onClose?: () => void;
}

export default function HistorySidebar({
  history,
  selectedId,
  onSelect,
  onDelete,
  onClearAll,
  onClose,
}: HistorySidebarProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);

  const filteredHistory = history.filter((item) => {
    const matchesSearch = item.title.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = filterType === "all" || item.mediaType === filterType;
    return matchesSearch && matchesType;
  });

  const getMediaIcon = (type: string) => {
    switch (type) {
      case "file":
        return <Film className="h-4 w-4 text-sky-500" />;
      case "record":
        return <Mic className="h-4 w-4 text-emerald-500" />;
      case "link":
        return <Link className="h-4 w-4 text-indigo-500" />;
      case "transcript_paste":
        return <AlignLeft className="h-4 w-4 text-amber-500" />;
      default:
        return <FileText className="h-4 w-4 text-slate-500" />;
    }
  };

  const getMediaName = (type: string) => {
    switch (type) {
      case "file":
        return "影音檔案";
      case "record":
        return "現場錄音";
      case "link":
        return "網頁連結";
      case "transcript_paste":
        return "字幕/逐字稿";
      default:
        return "其他";
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString("zh-TW", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-50 border-r border-slate-200">
      {/* Sidebar Header */}
      <div className="p-4 border-b border-slate-200 bg-white">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center space-x-2">
            <History className="h-5 w-5 text-slate-700" />
            <h2 className="text-base font-bold text-slate-900">歷史紀錄</h2>
          </div>
          <div className="flex items-center space-x-1.5">
            {history.length > 0 && (
              <>
                {isConfirmingClear ? (
                  <span className="flex items-center space-x-1.5 text-[10px] bg-rose-50 border border-rose-100 text-rose-600 rounded-lg px-2 py-0.5 mr-1 font-bold">
                    <button
                      onClick={() => {
                        onClearAll();
                        setIsConfirmingClear(false);
                      }}
                      className="hover:text-rose-800 hover:underline cursor-pointer"
                      id="confirm-clear-yes"
                    >
                      確認清除
                    </button>
                    <span className="text-rose-200">|</span>
                    <button
                      onClick={() => setIsConfirmingClear(false)}
                      className="text-slate-400 hover:text-slate-600 font-semibold cursor-pointer"
                      id="confirm-clear-no"
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => {
                      setIsConfirmingClear(true);
                      // 4 秒後自動恢復原狀
                      setTimeout(() => {
                        setIsConfirmingClear(false);
                      }, 4000);
                    }}
                    className="text-[11px] text-rose-500 hover:text-rose-700 font-bold hover:underline p-1 border-r border-slate-200 pr-2 mr-1 cursor-pointer"
                    id="clear-all-history-button"
                  >
                    清除全部
                  </button>
                )}
              </>
            )}
            {onClose && (
              <button
                onClick={onClose}
                className="text-[11px] text-slate-500 hover:text-slate-800 font-bold bg-slate-100 hover:bg-slate-200 px-2 py-0.5 rounded-md transition-all flex items-center"
                id="close-history-sidebar-inline"
                title="收起歷史紀錄"
              >
                <span>收合 ◀</span>
              </button>
            )}
          </div>
        </div>

        {/* Search */}
        <div className="relative mb-3">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder="搜尋歷史紀錄..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-9 pr-3 text-sm focus:border-slate-500 focus:bg-white focus:outline-hidden"
            id="history-search-input"
          />
        </div>

        {/* Filters */}
        <div className="flex bg-slate-100 p-1 rounded-md text-xs overflow-x-auto scrollbar-none gap-0.5">
          <button
            onClick={() => setFilterType("all")}
            className={`flex-1 min-w-[36px] py-1 text-center rounded-sm transition-all font-medium whitespace-nowrap shrink-0 ${
              filterType === "all" ? "bg-white shadow-xs text-slate-900" : "text-slate-500 hover:text-slate-900"
            }`}
          >
            全部
          </button>
          <button
            onClick={() => setFilterType("file")}
            className={`flex-1 min-w-[36px] py-1 text-center rounded-sm transition-all font-medium whitespace-nowrap shrink-0 ${
              filterType === "file" ? "bg-white shadow-xs text-slate-900" : "text-slate-500 hover:text-slate-900"
            }`}
          >
            檔案
          </button>
          <button
            onClick={() => setFilterType("record")}
            className={`flex-1 min-w-[36px] py-1 text-center rounded-sm transition-all font-medium whitespace-nowrap shrink-0 ${
              filterType === "record" ? "bg-white shadow-xs text-slate-900" : "text-slate-500 hover:text-slate-900"
            }`}
          >
            錄音
          </button>
          <button
            onClick={() => setFilterType("link")}
            className={`flex-1 min-w-[36px] py-1 text-center rounded-sm transition-all font-medium whitespace-nowrap shrink-0 ${
              filterType === "link" ? "bg-white shadow-xs text-slate-900" : "text-slate-500 hover:text-slate-900"
            }`}
          >
            連結
          </button>
          <button
            onClick={() => setFilterType("transcript_paste")}
            className={`flex-1 min-w-[36px] py-1 text-center rounded-sm transition-all font-medium whitespace-nowrap shrink-0 ${
              filterType === "transcript_paste" ? "bg-white shadow-xs text-slate-900" : "text-slate-500 hover:text-slate-900"
            }`}
          >
            字幕
          </button>
        </div>
      </div>

      {/* History List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredHistory.length === 0 ? (
          <div className="py-12 text-center">
            <History className="mx-auto h-8 w-8 text-slate-300 mb-2" />
            <p className="text-xs text-slate-400">目前沒有符合的歷史紀錄</p>
          </div>
        ) : (
          filteredHistory.map((item) => (
            <div
              key={item.id}
              onClick={() => onSelect(item.id)}
              className={`group flex items-start justify-between p-3 cursor-pointer transition-all ${
                selectedId === item.id
                  ? "bg-indigo-50/75 border-l-4 border-indigo-600 rounded-r-lg"
                  : "bg-white text-slate-700 hover:bg-slate-100 border border-slate-200/60 rounded-lg"
              }`}
              id={`history-item-${item.id}`}
            >
              <div className="flex space-x-2.5 min-w-0 flex-1">
                <div
                  className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                    selectedId === item.id ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {getMediaIcon(item.mediaType)}
                </div>
                <div className="min-w-0 flex-1">
                  <h4
                    className={`text-sm font-bold truncate leading-snug ${
                      selectedId === item.id ? "text-indigo-950 font-extrabold" : "text-slate-800"
                    }`}
                  >
                    {item.title}
                  </h4>
                  <div className="flex items-center space-x-2 mt-1 text-[11px]">
                    <span
                      className={`font-semibold ${
                        selectedId === item.id ? "text-indigo-800" : "text-slate-500"
                      }`}
                    >
                      {getMediaName(item.mediaType)}
                    </span>
                    <span className={selectedId === item.id ? "text-indigo-300" : "text-slate-300"}>•</span>
                    <span
                      className={`flex items-center ${
                        selectedId === item.id ? "text-indigo-700" : "text-slate-400"
                      }`}
                    >
                      <Calendar className="mr-0.5 h-3 w-3" />
                      {formatDate(item.createdAt)}
                    </span>
                  </div>
                </div>
              </div>
              <button
                onClick={(e) => onDelete(item.id, e)}
                className={`ml-2 p-1.5 rounded-md self-center opacity-0 group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-600 transition-all ${
                  selectedId === item.id ? "text-indigo-400 hover:bg-indigo-100" : "text-slate-400"
                }`}
                id={`delete-history-item-${item.id}`}
                title="刪除紀錄"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
