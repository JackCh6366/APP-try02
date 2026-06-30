import { useState, useRef, useEffect, useCallback } from "react";
import {
  Upload,
  Mic,
  FileText,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  Square,
  RefreshCw,
  Sliders,
  Sparkles,
  Link,
  Globe,
  Cpu,
  Clock,
  User,
  AlertTriangle,
  Loader2,
  PlayCircle,
} from "lucide-react";
import { AIProvider, SummaryOptions, SummaryDepth, PrimaryGoal, LocalModelConfig, LocalEngineType, LOCAL_ENGINE_PRESETS } from "../types";
import { testLocalConnection } from "../lib/localProvider";

interface MediaInputProps {
  onProcess: (payload: {
    provider: AIProvider;
    mediaType: "file" | "record" | "transcript_paste" | "link";
    fileData?: string;
    fileName?: string;
    mimeType?: string;
    textTranscript?: string;
    videoLink?: string;
    options: SummaryOptions;
    localConfig?: LocalModelConfig;
  }) => void;
  isLoading: boolean;
}

export default function MediaInput({ onProcess, isLoading }: MediaInputProps) {
  const [activeTab, setActiveTab] = useState<"file" | "record" | "transcript_paste" | "link">("file");

  // Options states — 只保留有實際對應功能的選項
  const [depth, setDepth] = useState<SummaryDepth>("detailed");
  const [primaryGoal, setPrimaryGoal] = useState<PrimaryGoal>("takeaways");
  const [targetLanguages, setTargetLanguages] = useState<string[]>(["zh", "en"]);
  const [provider, setProvider] = useState<AIProvider>("gemini");

  // 本地模型（Ollama / LM Studio）連線設定
  const [localEngineType, setLocalEngineType] = useState<LocalEngineType>("ollama");
  const [localBaseUrl, setLocalBaseUrl] = useState<string>(LOCAL_ENGINE_PRESETS.ollama.defaultUrl);
  const [localModelName, setLocalModelName] = useState<string>("");
  const [localTestStatus, setLocalTestStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [localTestMessage, setLocalTestMessage] = useState<string>("");
  const [localDetectedModels, setLocalDetectedModels] = useState<string[]>([]);

  const handleTestLocalConnection = async () => {
    setLocalTestStatus("testing");
    const result = await testLocalConnection({ engineType: localEngineType, baseUrl: localBaseUrl, modelName: localModelName });
    setLocalTestStatus(result.ok ? "ok" : "fail");
    setLocalTestMessage(result.message);
    setLocalDetectedModels(result.models || []);
    if (result.ok && result.models && result.models.length > 0 && !localModelName) {
      setLocalModelName(result.models[0]);
    }
  };

  const handleLocalEngineChange = (engine: LocalEngineType) => {
    setLocalEngineType(engine);
    setLocalBaseUrl(LOCAL_ENGINE_PRESETS[engine].defaultUrl);
    setLocalTestStatus("idle");
    setLocalDetectedModels([]);
  };

  // File Upload states
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileBase64, setFileBase64] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  // Recording states
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Link paste states
  const [videoLink, setVideoLink] = useState("");

  // 影片預覽資訊
  interface VideoPreview {
    title: string;
    channelName: string;
    thumbnailUrl: string;
    durationText: string;
    durationSeconds: number;
    isPlaylist: boolean;
    playlistWarning?: string;
    durationWarning?: string;
    videoId: string | null;
  }
  const [videoPreview, setVideoPreview] = useState<VideoPreview | null>(null);
  const [isFetchingPreview, setIsFetchingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Transcript Paste states
  const [pastedText, setPastedText] = useState("");

  // Options toggle
  const [showAdvanced, setShowAdvanced] = useState(true);

  useEffect(() => {
    return () => {
      if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    };
  }, [recordedUrl]);

  useEffect(() => {
    if (isRecording) {
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);
    } else {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    }
    return () => {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    };
  }, [isRecording]);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) handleFileSelected(e.target.files[0]);
  };

  const handleFileSelected = (file: File) => {
    const limit = 25 * 1024 * 1024;
    if (file.size > limit) {
      alert("檔案大小超過 25MB 限制！若是大型影片，建議使用工具先單獨匯出成音訊檔（如 MP3）上傳，處理速度會大幅加快。");
      return;
    }
    setSelectedFile(file);
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      setFileBase64(result.split(",")[1]);
    };
    reader.readAsDataURL(file);
  };

  // 自動抓取影片預覽資訊（debounce 800ms）
  const fetchVideoPreview = useCallback(async (url: string) => {
    if (!url.trim() || (!url.includes("youtube.com") && !url.includes("youtu.be"))) {
      setVideoPreview(null);
      setPreviewError(null);
      return;
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) return;

    setIsFetchingPreview(true);
    setPreviewError(null);
    setVideoPreview(null);

    try {
      const res = await fetch("/api/video-info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (data.success && data.info) {
        setVideoPreview(data.info);
      } else {
        setPreviewError("無法取得影片資訊，請確認連結是否正確。");
      }
    } catch {
      setPreviewError("網路連線異常，無法預覽影片資訊。");
    } finally {
      setIsFetchingPreview(false);
    }
  }, []);

  const handleVideoLinkChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setVideoLink(val);
    setVideoPreview(null);
    setPreviewError(null);

    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    previewDebounceRef.current = setTimeout(() => {
      fetchVideoPreview(val);
    }, 800);
  };

  const startRecording = async () => {
    audioChunksRef.current = [];
    setRecordedBlob(null);
    if (recordedUrl) {
      URL.revokeObjectURL(recordedUrl);
      setRecordedUrl(null);
    }
    setRecordingDuration(0);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        setRecordedBlob(audioBlob);
        setRecordedUrl(URL.createObjectURL(audioBlob));
        stream.getTracks().forEach((track) => track.stop());
      };
      mediaRecorder.start(250);
      setIsRecording(true);
    } catch (err) {
      console.error("無法存取麥克風: ", err);
      alert("無法存取您的麥克風。請確認已給予麥克風權限。");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const handleLanguageToggle = (lang: string) => {
    if (targetLanguages.includes(lang)) {
      if (targetLanguages.length > 1) {
        setTargetLanguages(targetLanguages.filter((l) => l !== lang));
      } else {
        alert("必須至少選擇一種整理目標語系！");
      }
    } else {
      setTargetLanguages([...targetLanguages, lang]);
    }
  };

  const handleSubmit = async () => {
    const options: SummaryOptions = { depth, primaryGoal, targetLanguages };

    // 本地模型僅支援純文字路徑，上傳/錄音會直接擋下並提示
    if (provider === "local" && (activeTab === "file" || activeTab === "record")) {
      alert("本地模型僅支援文字輸入（貼上字幕/逐字稿、或含字幕的 YouTube 連結），請改選其他輸入方式或切換至 Gemini。");
      return;
    }
    if (provider === "local") {
      if (!localModelName.trim()) {
        alert("請先輸入或選擇本地模型名稱！");
        return;
      }
      if (localTestStatus !== "ok") {
        alert("請先點擊「測試連線」確認可以連到你的本地模型伺服器！");
        return;
      }
    }

    const localConfig: LocalModelConfig | undefined =
      provider === "local" ? { engineType: localEngineType, baseUrl: localBaseUrl, modelName: localModelName } : undefined;

    if (activeTab === "file") {
      if (!selectedFile || !fileBase64) {
        alert("請先選擇或拖入影音檔案！");
        return;
      }
      if (provider === "nvidia" && selectedFile.size > 15 * 1024 * 1024) {
        alert("NVIDIA 模型建議檔案大小在 15MB 內以確保穩定處理。請改用較短片段，或切換至 Google Gemini 處理大檔案。");
        return;
      }
      onProcess({ provider, mediaType: "file", fileData: fileBase64, fileName: selectedFile.name, mimeType: selectedFile.type, options });
    } else if (activeTab === "record") {
      if (!recordedBlob) {
        alert("請先錄製一段音訊！");
        return;
      }
      if (provider === "nvidia" && recordedBlob.size > 15 * 1024 * 1024) {
        alert("NVIDIA 模型建議檔案大小在 15MB 內以確保穩定處理，錄音時間過長請切換至 Google Gemini。");
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        onProcess({
          provider, mediaType: "record",
          fileData: result.split(",")[1],
          fileName: `現場錄音_${new Date().toLocaleDateString("zh-TW")}.webm`,
          mimeType: "audio/webm", options,
        });
      };
      reader.readAsDataURL(recordedBlob);
    } else if (activeTab === "transcript_paste") {
      if (!pastedText.trim()) {
        alert("請貼上字幕/逐字稿文字內容！");
        return;
      }
      onProcess({ provider, mediaType: "transcript_paste", textTranscript: pastedText, options, localConfig });
    } else if (activeTab === "link") {
      if (!videoLink.trim()) {
        alert("請填寫有效的影片或音訊連結網址！");
        return;
      }
      if (!videoLink.startsWith("http://") && !videoLink.startsWith("https://")) {
        alert("請輸入包含 http:// 或 https:// 的完整網路連結位址！");
        return;
      }
      onProcess({ provider, mediaType: "link", videoLink: videoLink.trim(), fileName: videoLink.trim(), options, localConfig });
    }
  };

  const clearSelectedFile = () => {
    setSelectedFile(null);
    setFileBase64("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-md p-6 space-y-6">
      {/* Tabs */}
      <div className="flex border-b border-slate-100 pb-0.5 overflow-x-auto whitespace-nowrap scrollbar-none">
        {(["file", "record", "link", "transcript_paste"] as const).map((tab) => {
          const labels: Record<string, { icon: React.ReactNode; label: string }> = {
            file: { icon: <Upload className="h-4 w-4" />, label: "上傳影音檔案" },
            record: { icon: <Mic className="h-4 w-4" />, label: "現場智慧錄音" },
            link: { icon: <Link className="h-4 w-4" />, label: "YouTube / 影音連結" },
            transcript_paste: { icon: <FileText className="h-4 w-4" />, label: "貼上字幕逐字稿" },
          };
          const { icon, label } = labels[tab];
          return (
            <button
              key={tab}
              onClick={() => { if (!isLoading) setActiveTab(tab); }}
              disabled={isLoading}
              className={`flex items-center space-x-2 pb-3 px-4 font-bold text-sm border-b-2 transition-all cursor-pointer shrink-0 ${
                activeTab === tab ? "border-indigo-600 text-indigo-600" : "border-transparent text-slate-400 hover:text-slate-600"
              }`}
            >
              {icon}
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      {/* Input Contents */}
      <div className="min-h-[180px] flex flex-col justify-center">

        {/* 上傳檔案 */}
        {activeTab === "file" && (
          <div
            onDragEnter={handleDrag} onDragOver={handleDrag} onDragLeave={handleDrag} onDrop={handleDrop}
            className={`relative flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-6 transition-all text-center ${
              dragActive ? "border-indigo-600 bg-indigo-50/20 scale-[0.99]"
              : selectedFile ? "border-indigo-200 bg-indigo-50/10"
              : "border-slate-200 bg-slate-50/20 hover:border-indigo-300"
            }`}
          >
            <input type="file" ref={fileInputRef} onChange={handleFileInputChange} accept="audio/*,video/*" className="hidden" disabled={isLoading} />
            {!selectedFile ? (
              <div className="space-y-3 cursor-pointer" onClick={() => !isLoading && fileInputRef.current?.click()}>
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-600 shadow-xs">
                  <Upload className="h-6 w-6" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-800">拖曳檔案至此，或 <span className="text-slate-900 underline underline-offset-2">點擊瀏覽</span></p>
                  <p className="text-xs text-slate-400 mt-1">支援 MP3, WAV, M4A, MP4, WebM（單一檔案最大 25MB）</p>
                </div>
              </div>
            ) : (
              <div className="w-full space-y-4">
                <div className="flex items-center justify-between p-3.5 bg-white border border-emerald-100 rounded-lg shadow-xs max-w-md mx-auto">
                  <div className="flex items-center space-x-3 text-left min-w-0">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                      <CheckCircle2 className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-slate-800 truncate select-none">{selectedFile.name}</p>
                      <p className="text-xs text-slate-400">大小: {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB • 格式: {selectedFile.type || "未知"}</p>
                    </div>
                  </div>
                  <button onClick={clearSelectedFile} disabled={isLoading} className="text-xs font-semibold text-slate-400 hover:text-slate-800 p-1 bg-slate-50 hover:bg-slate-100 rounded-md transition-all shrink-0 cursor-pointer">清除</button>
                </div>
                <div className="flex items-center justify-center space-x-2 text-xs text-slate-500">
                  <AlertCircle className="h-4 w-4 text-slate-400" />
                  <span>檔案已準備就緒，點選下方按鈕開始 AI 彙整。</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 現場錄音 */}
        {activeTab === "record" && (
          <div className="flex flex-col items-center justify-center border border-slate-100 bg-slate-50/30 rounded-xl p-6 text-center space-y-4">
            <div className="flex items-center justify-center h-16 relative">
              {isRecording ? (
                <div className="flex items-center space-x-1.5 h-10">
                  {[6, 10, 8, 4, 9, 5].map((h, i) => (
                    <div key={i} className={`w-1 bg-emerald-500 rounded-full animate-bounce`} style={{ height: `${h * 4}px`, animationDelay: `${i * 50}ms` }}></div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center justify-center h-12 w-12 rounded-full bg-slate-100 text-slate-400">
                  <Mic className="h-6 w-6" />
                </div>
              )}
            </div>
            <div className="space-y-1">
              {isRecording ? (
                <div>
                  <p className="text-sm font-bold text-slate-800">正在錄音中...</p>
                  <div className="flex items-center justify-center space-x-2 text-rose-500 font-mono text-xl font-bold mt-1">
                    <span className="h-2 w-2 rounded-full bg-rose-500 animate-ping"></span>
                    <span>{formatTime(recordingDuration)}</span>
                  </div>
                </div>
              ) : recordedBlob ? (
                <div>
                  <p className="text-sm font-bold text-slate-800">錄音已完成！</p>
                  <p className="text-xs text-slate-400 mt-1">錄音長度: {formatTime(recordingDuration)}</p>
                  {recordedUrl && <audio src={recordedUrl} controls className="mx-auto mt-3 h-8 max-w-xs" />}
                </div>
              ) : (
                <div>
                  <p className="text-sm font-semibold text-slate-800">透過裝置麥克風錄製音訊</p>
                  <p className="text-xs text-slate-400 mt-1 max-w-sm">適合會議錄音、訪談或個人靈感。請給予麥克風權限以進行錄製。</p>
                </div>
              )}
            </div>
            <div className="flex justify-center space-x-3 pt-2">
              {!isRecording && !recordedBlob && (
                <button type="button" onClick={startRecording} disabled={isLoading}
                  className="flex items-center space-x-2 bg-slate-900 text-white font-medium hover:bg-slate-800 text-sm px-5 py-2.5 rounded-lg shadow-sm transition-all cursor-pointer">
                  <Mic className="h-4 w-4" /><span>開始錄音</span>
                </button>
              )}
              {isRecording && (
                <button type="button" onClick={stopRecording}
                  className="flex items-center space-x-2 bg-rose-600 text-white font-medium hover:bg-rose-700 text-sm px-5 py-2.5 rounded-lg shadow-md transition-all animate-pulse cursor-pointer">
                  <Square className="h-4 w-4 fill-white" /><span>結束並儲存</span>
                </button>
              )}
              {recordedBlob && !isRecording && (
                <button type="button" onClick={startRecording} disabled={isLoading}
                  className="flex items-center space-x-2 border border-slate-200 text-slate-600 bg-white font-medium hover:bg-slate-50 text-sm px-4 py-2 rounded-lg transition-all cursor-pointer">
                  <RefreshCw className="h-4 w-4" /><span>重新錄製</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* YouTube / 連結 */}
        {activeTab === "link" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-700 tracking-wide select-none">
                輸入影音網址（YouTube 影片連結或公開 Podcast URL）
              </label>
              <div className="relative">
                <input
                  type="url"
                  placeholder="請貼上完整連結，例如 https://www.youtube.com/watch?v=..."
                  value={videoLink}
                  onChange={handleVideoLinkChange}
                  disabled={isLoading}
                  className={`w-full rounded-xl border bg-slate-50/20 p-4 pr-12 text-sm focus:bg-white focus:outline-hidden font-medium transition-all ${
                    videoPreview?.isPlaylist && !videoPreview?.videoId
                      ? "border-amber-400 focus:border-amber-500"
                      : videoPreview
                      ? "border-emerald-400 focus:border-emerald-500"
                      : "border-slate-200 focus:border-indigo-600"
                  }`}
                />
                <div className="absolute right-4 top-1/2 transform -translate-y-1/2 text-slate-400">
                  {isFetchingPreview
                    ? <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
                    : videoPreview
                    ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    : <Link className="h-4 w-4" />
                  }
                </div>
              </div>
            </div>

            {/* 載入中提示 */}
            {isFetchingPreview && (
              <div className="flex items-center space-x-2 text-xs text-slate-500 px-1">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400" />
                <span>正在取得影片資訊...</span>
              </div>
            )}

            {/* 預覽錯誤 */}
            {previewError && !isFetchingPreview && (
              <div className="flex items-center space-x-2 rounded-lg bg-rose-50 border border-rose-100 p-3 text-xs text-rose-700">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{previewError}</span>
              </div>
            )}

            {/* 播放清單警告（無法分析整個清單） */}
            {videoPreview?.isPlaylist && !videoPreview?.videoId && !isFetchingPreview && (
              <div className="flex items-start space-x-2.5 rounded-xl bg-amber-50 border border-amber-200 p-4 text-xs text-amber-800">
                <AlertTriangle className="h-4.5 w-4.5 text-amber-500 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-bold">⚠️ 播放清單連結無法直接分析</p>
                  <p className="leading-normal">{videoPreview.playlistWarning}</p>
                  <p className="text-amber-600 font-semibold mt-1">
                    請從播放清單中點開單一影片，複製該影片的網址後貼上。
                  </p>
                </div>
              </div>
            )}

            {/* 影片資訊預覽卡片 */}
            {videoPreview && videoPreview.videoId && !isFetchingPreview && (
              <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
                <div className="flex items-stretch gap-0">
                  {/* 縮圖 */}
                  {videoPreview.thumbnailUrl && (
                    <div className="relative shrink-0 w-32 sm:w-40 bg-slate-100">
                      <img
                        src={videoPreview.thumbnailUrl}
                        alt={videoPreview.title}
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                      {/* 時長標籤 */}
                      {videoPreview.durationSeconds > 0 && (
                        <div className="absolute bottom-1.5 right-1.5 bg-black/80 text-white text-[10px] font-mono font-bold px-1.5 py-0.5 rounded">
                          {videoPreview.durationText}
                        </div>
                      )}
                      <div className="absolute inset-0 flex items-center justify-center opacity-60">
                        <PlayCircle className="h-8 w-8 text-white drop-shadow-md" />
                      </div>
                    </div>
                  )}

                  {/* 資訊 */}
                  <div className="flex-1 p-3.5 space-y-2 min-w-0">
                    <h4 className="text-sm font-bold text-slate-900 leading-snug line-clamp-2">
                      {videoPreview.title}
                    </h4>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                      {videoPreview.channelName && (
                        <span className="flex items-center space-x-1">
                          <User className="h-3 w-3" />
                          <span>{videoPreview.channelName}</span>
                        </span>
                      )}
                      {videoPreview.durationSeconds > 0 && (
                        <span className="flex items-center space-x-1">
                          <Clock className="h-3 w-3" />
                          <span>{videoPreview.durationText}</span>
                        </span>
                      )}
                    </div>

                    {/* 播放清單提示（有影片ID但帶有list參數） */}
                    {videoPreview.isPlaylist && videoPreview.videoId && (
                      <div className="flex items-start space-x-1.5 text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
                        <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                        <span>{videoPreview.playlistWarning}</span>
                      </div>
                    )}

                    {/* 時長警告 */}
                    {videoPreview.durationWarning && (
                      <div className="flex items-start space-x-1.5 text-[10px] text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-lg px-2.5 py-1.5">
                        <Clock className="h-3 w-3 shrink-0 mt-0.5" />
                        <span>{videoPreview.durationWarning}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 說明文字（無預覽時顯示） */}
            {!videoPreview && !isFetchingPreview && !previewError && (
              <div className="flex items-start space-x-2.5 rounded-xl bg-indigo-50/40 border border-indigo-100 p-4 text-xs text-indigo-800">
                <Globe className="h-4 w-4 text-indigo-500 shrink-0 mt-0.5" />
                <div className="space-y-1 font-medium">
                  <p className="font-bold">🌐 YouTube 直接音訊分析模式</p>
                  <p className="text-slate-600 leading-normal">
                    貼上 YouTube 連結後會自動預覽影片資訊。Gemini 將直接讀取影片音訊分析，準確度更高，不依賴字幕。
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 貼上逐字稿 */}
        {activeTab === "transcript_paste" && (
          <div className="space-y-4">
            <div className="relative">
              <textarea
                placeholder="在此貼上影片的逐字稿、字幕內容（如 SRT、VTT 文字）或會議記錄..."
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                disabled={isLoading}
                rows={6}
                className="w-full rounded-xl border border-slate-200 bg-slate-50/20 p-4 text-sm focus:border-slate-800 focus:bg-white focus:ring-0 focus:outline-hidden font-medium"
              />
              <div className="absolute right-3.5 bottom-3.5 text-xs font-mono text-slate-400">字數: {pastedText.length}</div>
            </div>
            <div className="flex items-center space-x-2 rounded-lg bg-indigo-50/50 border border-indigo-100 p-3 text-xs text-indigo-800">
              <FileText className="h-4 w-4 text-indigo-500 shrink-0" />
              <span>支援大篇幅文字。可從 YouTube 複製逐字稿後貼到此處進行深度彙整。</span>
            </div>
          </div>
        )}
      </div>

      {/* 進階設定 */}
      <div className="border-t border-slate-100 pt-5">
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center justify-between w-full text-left text-slate-700 hover:text-slate-900 transition-all cursor-pointer"
        >
          <div className="flex items-center space-x-2.5">
            <Sliders className="h-4 w-4 text-slate-500" />
            <span className="text-sm font-bold text-slate-800">AI 重點彙整與多語翻譯偏好</span>
          </div>
          <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
        </button>

        {showAdvanced && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-5 mt-4 pt-2 bg-slate-50/50 p-4 border border-slate-100 rounded-xl">

            {/* AI Provider */}
            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-700 tracking-wide">AI Provider</label>
              <div className="space-y-1.5">
                {[
                  { value: "gemini" as AIProvider, label: "Google Gemini", sub: "gemini-2.5-flash-lite" },
                  { value: "nvidia" as AIProvider, label: "NVIDIA", sub: "Nemotron 3 Nano Omni（支援音訊/影片）" },
                  { value: "local" as AIProvider, label: "本地模型", sub: "Ollama / LM Studio（在你電腦執行）" },
                ].map(({ value, label, sub }) => (
                  <label key={value} className="flex items-center p-2 rounded-lg bg-white border border-slate-100 hover:border-slate-300 cursor-pointer transition-all">
                    <input type="radio" name="provider" value={value} checked={provider === value} onChange={() => setProvider(value)} disabled={isLoading}
                      className="h-4 w-4 text-slate-900 border-slate-300 focus:ring-slate-900" />
                    <div className="ml-3 min-w-0">
                      <span className="block text-xs font-bold text-slate-800">{label}</span>
                      <span className="block text-[10px] text-slate-400">{sub}</span>
                    </div>
                  </label>
                ))}
              </div>
              {provider === "nvidia" && (
                <div className="flex items-start space-x-2 text-[10px] text-slate-500 bg-white border border-slate-100 rounded-lg p-2">
                  <Cpu className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>支援上傳音訊檔案、文字稿與連結。單檔建議在 15MB 內以確保穩定處理（大型影片請改用 Gemini）。</span>
                </div>
              )}
              {provider === "local" && (
                <div className="space-y-2 bg-white border border-slate-100 rounded-lg p-3">
                  <div className="flex items-start space-x-2 text-[10px] text-slate-500">
                    <Cpu className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>使用你自己電腦上執行的模型，資料不會上傳到雲端。僅支援文字稿輸入（貼上文字 / YouTube 字幕）。</span>
                  </div>

                  {/* 引擎類型選擇 */}
                  <div className="flex gap-1.5">
                    {(["ollama", "lmstudio", "custom"] as LocalEngineType[]).map((eng) => (
                      <button key={eng} type="button" onClick={() => handleLocalEngineChange(eng)}
                        className={`flex-1 text-[10px] font-bold py-1.5 rounded-md border transition-all ${localEngineType === eng ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"}`}>
                        {LOCAL_ENGINE_PRESETS[eng].label}
                      </button>
                    ))}
                  </div>

                  {/* 連線網址 */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 mb-1">伺服器網址</label>
                    <input type="text" value={localBaseUrl} onChange={(e) => { setLocalBaseUrl(e.target.value); setLocalTestStatus("idle"); }}
                      placeholder={LOCAL_ENGINE_PRESETS[localEngineType].defaultUrl}
                      className="w-full text-[11px] font-mono px-2 py-1.5 border border-slate-200 rounded-md focus:border-slate-900 focus:outline-none" />
                  </div>

                  {/* 連線測試 */}
                  <button type="button" onClick={handleTestLocalConnection} disabled={localTestStatus === "testing"}
                    className="w-full text-[10px] font-bold py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 transition-all flex items-center justify-center gap-1.5 disabled:opacity-50">
                    {localTestStatus === "testing" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    測試連線
                  </button>

                  {localTestStatus !== "idle" && (
                    <div className={`text-[10px] p-2 rounded-md flex items-start gap-1.5 ${localTestStatus === "ok" ? "bg-emerald-50 text-emerald-700" : localTestStatus === "fail" ? "bg-red-50 text-red-700" : "bg-slate-50 text-slate-500"}`}>
                      {localTestStatus === "ok" && <CheckCircle2 className="h-3 w-3 shrink-0 mt-0.5" />}
                      {localTestStatus === "fail" && <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />}
                      <span>{localTestMessage}</span>
                    </div>
                  )}

                  {/* 模型選擇 */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 mb-1">模型名稱</label>
                    {localDetectedModels.length > 0 ? (
                      <select value={localModelName} onChange={(e) => setLocalModelName(e.target.value)}
                        className="w-full text-[11px] font-mono px-2 py-1.5 border border-slate-200 rounded-md focus:border-slate-900 focus:outline-none">
                        {localDetectedModels.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    ) : (
                      <input type="text" value={localModelName} onChange={(e) => setLocalModelName(e.target.value)}
                        placeholder="例：llama3.1 或 qwen2.5:14b"
                        className="w-full text-[11px] font-mono px-2 py-1.5 border border-slate-200 rounded-md focus:border-slate-900 focus:outline-none" />
                    )}
                  </div>

                  <a href="https://ollama.com" target="_blank" rel="noreferrer" className="block text-[10px] text-slate-400 underline hover:text-slate-600">
                    還沒安裝 Ollama？點此前往下載
                  </a>
                </div>
              )}
            </div>

            {/* 摘要深度 — 移除「心智圖」選項 */}
            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-700 tracking-wide">摘要深度與完整度</label>
              <div className="space-y-1.5">
                <label className="flex items-center p-2 rounded-lg bg-white border border-slate-100 hover:border-slate-300 cursor-pointer transition-all">
                  <input type="radio" name="depth" value="quick" checked={depth === "quick"} onChange={() => setDepth("quick")} disabled={isLoading}
                    className="h-4 w-4 text-slate-900 border-slate-300 focus:ring-slate-900" />
                  <div className="ml-3">
                    <span className="block text-xs font-bold text-slate-800">簡短精華大綱</span>
                    <span className="block text-[10px] text-slate-400">只提煉最核心的主幹（約 3000 字）</span>
                  </div>
                </label>
                <label className="flex items-center p-2 rounded-lg bg-white border border-slate-100 hover:border-slate-300 cursor-pointer transition-all mt-1.5">
                  <input type="radio" name="depth" value="detailed" checked={depth === "detailed"} onChange={() => setDepth("detailed")} disabled={isLoading}
                    className="h-4 w-4 text-slate-900 border-slate-300 focus:ring-slate-900" />
                  <div className="ml-3">
                    <span className="block text-xs font-bold text-slate-800">深度章節解析（推薦）</span>
                    <span className="block text-[10px] text-slate-400">完整論點、脈絡與論點還原（10000 字以上）</span>
                  </div>
                </label>
              </div>
            </div>

            {/* 彙整重心 — 移除「全文逐字聽寫」選項 */}
            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-700 tracking-wide">彙整重心定位</label>
              <div className="space-y-1.5">
                <label className="flex items-center p-2 rounded-lg bg-white border border-slate-100 hover:border-slate-300 cursor-pointer transition-all">
                  <input type="radio" name="primaryGoal" value="takeaways" checked={primaryGoal === "takeaways"} onChange={() => setPrimaryGoal("takeaways")} disabled={isLoading}
                    className="h-4 w-4 text-slate-900 border-slate-300 focus:ring-slate-900" />
                  <div className="ml-3">
                    <span className="block text-xs font-bold text-slate-800">知識核心 Takeaways</span>
                    <span className="block text-[10px] text-slate-400">提煉關鍵概念、技術要義與亮點</span>
                  </div>
                </label>
                <label className="flex items-center p-2 rounded-lg bg-white border border-slate-100 hover:border-slate-300 cursor-pointer transition-all mt-1.5">
                  <input type="radio" name="primaryGoal" value="actions" checked={primaryGoal === "actions"} onChange={() => setPrimaryGoal("actions")} disabled={isLoading}
                    className="h-4 w-4 text-slate-900 border-slate-300 focus:ring-slate-900" />
                  <div className="ml-3">
                    <span className="block text-xs font-bold text-slate-800">待辦與行動清單 Action Items</span>
                    <span className="block text-[10px] text-slate-400">抓出會議交辦事務、具體下一步計劃</span>
                  </div>
                </label>
              </div>
            </div>

            {/* 翻譯語系 */}
            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-700 tracking-wide">翻譯與整理目標語系（複選）</label>
              <p className="text-[10px] text-slate-400">AI 將同步產出已核選語系的重點大綱與精準翻譯。</p>
              <div className="grid grid-cols-2 gap-2 pt-1">
                {[
                  { code: "zh", label: "繁體中文 (ZH)" },
                  { code: "en", label: "英文 (EN)" },
                  { code: "ja", label: "日本語 (JA)" },
                  { code: "ko", label: "한국어 (KO)" },
                ].map(({ code, label }) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => handleLanguageToggle(code)}
                    disabled={isLoading}
                    className={`flex items-center justify-between p-2.5 rounded-lg border text-xs font-semibold text-left transition-all cursor-pointer ${
                      targetLanguages.includes(code)
                        ? "bg-indigo-600 text-white border-indigo-600 shadow-xs"
                        : "bg-white text-slate-700 border-slate-200 hover:border-indigo-300"
                    }`}
                  >
                    <span>{label}</span>
                    {targetLanguages.includes(code) && <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse"></span>}
                  </button>
                ))}
              </div>
            </div>

          </div>
        )}
      </div>

      {/* 送出按鈕 */}
      <div className="pt-2">
        <button
          onClick={handleSubmit}
          disabled={isLoading}
          className={`relative w-full flex items-center justify-center space-x-2 py-4 px-6 rounded-xl text-base font-bold text-white shadow-md transition-all cursor-pointer ${
            isLoading ? "bg-indigo-400 cursor-not-allowed" : "bg-indigo-600 hover:bg-indigo-700 shadow-indigo-600/20 active:scale-[0.99]"
          }`}
        >
          {isLoading ? (
            <>
              <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span>正在傳輸音軌並分析此媒體（約需 15~40 秒）...</span>
            </>
          ) : (
            <>
              <Sparkles className="h-5 w-5 text-amber-400 animate-pulse" />
              <span>啟動 AI 重點智整理與多語對照翻譯 →</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
