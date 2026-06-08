import { FileVideo, Sparkles } from "lucide-react";

export default function Header() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3.5 sm:px-6 lg:px-8">
        <div className="flex items-center space-x-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-xs">
            <FileVideo className="h-4.5 w-4.5" id="header-logo-icon" />
          </div>
          <div>
            <h1 className="text-lg font-extrabold tracking-tight text-slate-900 sm:text-xl">
              TransVantage <span className="text-indigo-600">AI</span>
            </h1>
            <p className="text-[11px] text-slate-500 font-medium">
              多元影音智慧重點彙整與多語系對照翻譯工具 • 多模態支援
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <div className="hidden sm:flex items-center space-x-2 rounded-full bg-slate-50 px-3 py-1 text-xs text-slate-600 border border-slate-100">
            <Sparkles className="h-3.5 w-3.5 text-indigo-500 animate-pulse" />
            <span className="font-semibold">Gemini 3.5 Flash 能量核心</span>
          </div>
          <div className="flex items-center space-x-2 rounded-full bg-indigo-50 px-3 py-1 text-xs text-indigo-700 border border-indigo-100">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-indigo-600"></span>
            </span>
            <span className="font-bold">連線就緒</span>
          </div>
        </div>
      </div>
    </header>
  );
}
