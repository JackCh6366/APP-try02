import { useState, useRef, useEffect } from "react";
import {
  Upload,
  Mic,
  FileText,
  Clock,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  ChevronDown,
  Play,
  Square,
  RefreshCw,
  Sliders,
  Sparkles,
  Link,
  Globe,
  Cpu,
} from "lucide-react";
import { AIProvider, SummaryOptions, SummaryDepth, PrimaryGoal } from "../types";

interface MediaInputProps {
  onProcess: (payload: {
    provider: AIProvider;
    mediaType: "file" | "record" | "transcript_paste" | "link";
    fileData?: string; // base64 string
    fileName?: string;
    mimeType?: string;
    textTranscript?: string;
    videoLink?: string;
    options: SummaryOptions;
  }) => void;
  isLoading: boolean;
}

export default function MediaInput({ onProcess, isLoading }: MediaInputProps) {
  const [activeTab, setActiveTab] = useState<"file" | "record" | "transcript_paste" | "link">("file");

  // Options states
  const [depth, setDepth] = useState<SummaryDepth>("detailed");
  const [primaryGoal, setPrimaryGoal] = useState<PrimaryGoal>("takeaways");
  const [targetLanguages, setTargetLanguages] = useState<string[]>(["zh", "en"]);
  const [provider, setProvider] = useState<AIProvider>("gemini");

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

  // Transcript Paste states
  const [pastedText, setPastedText] = useState("");

  // Options toggle
  const [showAdvanced, setShowAdvanced] = useState(true);

  // Cleanup object URLs to avoid memory leaks
  useEffect(() => {
    return () => {
      if (recordedUrl) {
        URL.revokeObjectURL(recordedUrl);
      }
    };
  }, [recordedUrl]);

  // Audio Recorder Duration Timer
  useEffect(() => {
    if (isRecording) {
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);
    } else {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
    }
    return () => {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    };
  }, [isRecording]);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
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
    if (e.target.files && e.target.files[0]) {
      handleFileSelected(e.target.files[0]);
    }
  };

  const handleFileSelected = (file: File) => {
    // Check if within 25MB limit (approx 25 * 1024 * 1024 bytes)
    const limit = 25 * 1024 * 1024;
    if (file.size > limit) {
      alert("檔案大小超過 25MB 限制！若是大型影片，建議使用工具先單獨匯出成音訊檔（如 MP3）上傳，處理速度會大幅加快。");
      return;
    }

    setSelectedFile(file);

    // Read to Base64
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Extract the raw base64 data parts
      const base64Data = result.split(",")[1];
      setFileBase64(base64Data);
    };
    reader.readAsDataURL(file);
  };

  // Recording Functions
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
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: "audio/webm",
      });

      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        setRecordedBlob(audioBlob);
        setRecordedUrl(URL.createObjectURL(audioBlob));

        // Stop all audio tracks to free mic
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start(250); // Slice chunks every 250ms
      setIsRecording(true);
    } catch (err) {
      console.error("無法存取麥克風: ", err);
      alert("無法存取您的麥克風。請確認已給予 AI Studio 麥克風權限（您可在瀏覽器網址列左側點擊重新啟用確認）。");
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
    const options: SummaryOptions = {
      depth,
      primaryGoal,
      targetLanguages,
    };

    if (activeTab === "file") {
      if (!selectedFile || !fileBase64) {
        alert("請先選擇或拖入影音檔案！");
        return;
      }
      onProcess({
        provider,
        mediaType: "file",
        fileData: fileBase64,
        fileName: selectedFile.name,
        mimeType: selectedFile.type,
        options,
      });
    } else if (activeTab === "record") {
      if (!recordedBlob) {
        alert("請先錄製一段音訊！");
        return;
      }

      // Convert Blob to Base64
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        const base64Data = result.split(",")[1];
        onProcess({
          provider,
          mediaType: "record",
          fileData: base64Data,
          fileName: `現場錄音_${new Date().toLocaleDateString("zh-TW")}.webm`,
          mimeType: "audio/webm",
          options,
        });
      };
      reader.readAsDataURL(recordedBlob);
    } else if (activeTab === "transcript_paste") {
      if (!pastedText.trim()) {
        alert("請貼上字幕/逐字稿文字內容！");
        return;
      }
      onProcess({
        provider,
        mediaType: "transcript_paste",
        textTranscript: pastedText,
        options,
      });
    } else if (activeTab === "link") {
      if (!videoLink.trim()) {
        alert("請填寫有效的影片或音訊連結網址！");
        return;
      }
      if (!videoLink.startsWith("http://") && !videoLink.startsWith("https://")) {
        alert("請輸入包含 http:// 或 https:// 的完整網路連結位址！");
        return;
      }
      onProcess({
        provider,
        mediaType: "link",
        videoLink: videoLink.trim(),
        fileName: videoLink.trim(),
        options,
      });
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
        <button
          onClick={() => {
            if (!isLoading) setActiveTab("file");
          }}
          disabled={isLoading}
          className={`flex items-center space-x-2 pb-3 px-4 font-bold text-sm border-b-2 transition-all cursor-pointer shrink-0 ${
            activeTab === "file"
              ? "border-indigo-600 text-indigo-600"
              : "border-transparent text-slate-400 hover:text-slate-600"
          }`}
          id="tab-btn-file"
        >
          <Upload className="h-4 w-4" />
          <span>上傳影音檔案</span>
        </button>
        <button
          onClick={() => {
            if (!isLoading) setActiveTab("record");
          }}
          disabled={isLoading}
          className={`flex items-center space-x-2 pb-3 px-4 font-bold text-sm border-b-2 transition-all cursor-pointer shrink-0 ${
            activeTab === "record"
              ? "border-indigo-600 text-indigo-600"
              : "border-transparent text-slate-400 hover:text-slate-600"
          }`}
          id="tab-btn-record"
        >
          <Mic className="h-4 w-4" />
          <span>現場智慧錄音</span>
        </button>
        <button
          onClick={() => {
            if (!isLoading) setActiveTab("link");
          }}
          disabled={isLoading}
          className={`flex items-center space-x-2 pb-3 px-4 font-bold text-sm border-b-2 transition-all cursor-pointer shrink-0 ${
            activeTab === "link"
              ? "border-indigo-600 text-indigo-600"
              : "border-transparent text-slate-400 hover:text-slate-600"
          }`}
          id="tab-btn-link"
        >
          <Link className="h-4 w-4" />
          <span>YouTube / 影音連結</span>
        </button>
        <button
          onClick={() => {
            if (!isLoading) setActiveTab("transcript_paste");
          }}
          disabled={isLoading}
          className={`flex items-center space-x-2 pb-3 px-4 font-bold text-sm border-b-2 transition-all cursor-pointer shrink-0 ${
            activeTab === "transcript_paste"
              ? "border-indigo-600 text-indigo-600"
              : "border-transparent text-slate-400 hover:text-slate-600"
          }`}
          id="tab-btn-pasted"
        >
          <FileText className="h-4 w-4" />
          <span>貼上字幕逐字稿</span>
        </button>
      </div>

      {/* Input Contents */}
      <div className="min-h-[180px] flex flex-col justify-center">
        {activeTab === "file" && (
          <div
            onDragEnter={handleDrag}
            onDragOver={handleDrag}
            onDragLeave={handleDrag}
            onDrop={handleDrop}
            className={`relative flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-6 transition-all text-center ${
              dragActive
                ? "border-indigo-600 bg-indigo-50/20 scale-[0.99]"
                : selectedFile
                ? "border-indigo-200 bg-indigo-50/10"
                : "border-slate-200 bg-slate-50/20 hover:border-indigo-300"
            }`}
            id="drag-drop-zone"
          >
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileInputChange}
              accept="audio/*,video/*"
              className="hidden"
              id="media-file-input"
              disabled={isLoading}
            />

            {!selectedFile ? (
              <div className="space-y-3 cursor-pointer" onClick={() => !isLoading && fileInputRef.current?.click()}>
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-600 shadow-xs">
                  <Upload className="h-6 w-6" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-800">
                    拖曳檔案至此，或 <span className="text-slate-900 underline underline-offset-2">點擊瀏覽</span>
                  </p>
                  <p className="text-xs text-slate-400 mt-1">
                    支援 MP3, WAV, M4A, MP4, WebM (單一檔案最大 25MB)
                  </p>
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
                      <p className="text-sm font-bold text-slate-800 truncate select-none">
                        {selectedFile.name}
                      </p>
                      <p className="text-xs text-slate-400">
                        大小: {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB • 格式: {selectedFile.type || "未知"}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={clearSelectedFile}
                    disabled={isLoading}
                    className="text-xs font-semibold text-slate-400 hover:text-slate-800 p-1 bg-slate-50 hover:bg-slate-100 rounded-md transition-all shrink-0 cursor-pointer"
                  >
                    清除
                  </button>
                </div>
                <div className="flex items-center justify-center space-x-2 text-xs text-slate-500">
                  <AlertCircle className="h-4 w-4 text-slate-400" />
                  <span>檔案已準備就緒，您可以點選下方按鈕開始進行 AI 彙整。</span>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "record" && (
          <div className="flex flex-col items-center justify-center border border-slate-100 bg-slate-50/30 rounded-xl p-6 text-center space-y-4">
            {/* Visualizer Loop indicator */}
            <div className="flex items-center justify-center h-16 relative">
              {isRecording ? (
                <div className="flex items-center space-x-1.5 h-10">
                  <div className="w-1 bg-emerald-500 h-6 rounded-full animate-bounce delay-100"></div>
                  <div className="w-1 bg-emerald-500 h-10 rounded-full animate-bounce delay-200"></div>
                  <div className="w-1 bg-emerald-500 h-8 rounded-full animate-bounce"></div>
                  <div className="w-1 bg-emerald-500 h-4 rounded-full animate-bounce delay-300"></div>
                  <div className="w-1 bg-emerald-500 h-9 rounded-full animate-bounce delay-100"></div>
                  <div className="w-1 bg-emerald-500 h-5 rounded-full animate-bounce delay-150"></div>
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
                  <p className="text-xs text-slate-400 mt-1">
                    錄音長度: {formatTime(recordingDuration)}
                  </p>
                  {recordedUrl && (
                    <audio src={recordedUrl} controls className="mx-auto mt-3 h-8 max-w-xs" />
                  )}
                </div>
              ) : (
                <div>
                  <p className="text-sm font-semibold text-slate-800">透過裝置麥克風錄製音訊</p>
                  <p className="text-xs text-slate-400 mt-1 max-w-sm">
                    此功能適合會議隨手錄音、訪談錄音或個人靈感。請給予瀏覽器麥克風權限以進行錄製。
                  </p>
                </div>
              )}
            </div>

            <div className="flex justify-center space-x-3 pt-2">
              {!isRecording && !recordedBlob && (
                <button
                  type="button"
                  onClick={startRecording}
                  disabled={isLoading}
                  className="flex items-center space-x-2 bg-slate-900 text-white font-medium hover:bg-slate-800 text-sm px-5 py-2.5 rounded-lg shadow-sm transition-all cursor-pointer"
                >
                  <Mic className="h-4 w-4" />
                  <span>開始錄音</span>
                </button>
              )}

              {isRecording && (
                <button
                  type="button"
                  onClick={stopRecording}
                  className="flex items-center space-x-2 bg-rose-600 text-white font-medium hover:bg-rose-700 text-sm px-5 py-2.5 rounded-lg shadow-md transition-all animate-pulse cursor-pointer"
                >
                  <Square className="h-4 w-4 fill-white" />
                  <span>結束並儲存</span>
                </button>
              )}

              {recordedBlob && !isRecording && (
                <button
                  type="button"
                  onClick={startRecording}
                  disabled={isLoading}
                  className="flex items-center space-x-2 border border-slate-200 text-slate-600 bg-white font-medium hover:bg-slate-50 text-sm px-4 py-2 rounded-lg transition-all cursor-pointer"
                >
                  <RefreshCw className="h-4 w-4" />
                  <span>重新錄製</span>
                </button>
              )}
            </div>
          </div>
        )}

        {activeTab === "link" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-700 tracking-wide select-none">
                輸入影音網址（如 YouTube 影片連結或公開 Podcast URL）
              </label>
              <div className="relative">
                <input
                  type="url"
                  placeholder="請在此貼上完整的線上影片或音訊網址 (例如 https://www.youtube.com/watch?v=... 或 Podcast 網址)"
                  value={videoLink}
                  onChange={(e) => setVideoLink(e.target.value)}
                  disabled={isLoading}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50/20 p-4 pr-12 text-sm focus:border-indigo-600 focus:bg-white focus:outline-hidden font-medium transition-all"
                  id="video-link-input"
                />
                <div className="absolute right-4.5 top-1/2 transform -translate-y-1/2 text-slate-400">
                  <Link className="h-4.5 w-4.5" />
                </div>
              </div>
            </div>
            <div className="flex items-start space-x-2.5 rounded-xl bg-indigo-50/40 border border-indigo-100 p-4 text-xs text-indigo-800">
              <Globe className="h-4.5 w-4.5 text-indigo-500 shrink-0 mt-0.5" />
              <div className="space-y-1 font-medium">
                <p className="font-bold">🌐 線上多模態網址提取與智能感知連結模式</p>
                <p className="text-slate-600 leading-normal">
                  支援直接輸入任何公開的線上影片或音訊連結（如 YouTube 音訊、TED 講座等）。伺服器將自動擷取網頁標題與簡介對應，由 Gemini 自動索引、消化並重組出最完美的四國語文對照筆記、主題紀要與待辦行動大綱。
                </p>
              </div>
            </div>
          </div>
        )}

        {activeTab === "transcript_paste" && (
          <div className="space-y-4">
            <div className="relative">
              <textarea
                placeholder="在此貼上影片的逐字稿、字幕內容（例如 SRT、VTT 文字）或是您手邊的長篇會議記錄文件..."
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                disabled={isLoading}
                rows={6}
                className="w-full rounded-xl border border-slate-200 bg-slate-50/20 p-4 text-sm focus:border-slate-800 focus:bg-white focus:ring-0 focus:outline-hidden font-medium"
                id="text-transcript-textarea"
              />
              <div className="absolute right-3.5 bottom-3.5 text-xs font-mono text-slate-400">
                字數統計: {pastedText.length}
              </div>
            </div>
            <div className="flex items-center space-x-2 rounded-lg bg-indigo-50/50 border border-indigo-100 p-3 text-xs text-indigo-800">
              <FileText className="h-4 w-4 text-indigo-500 shrink-0" />
              <span>
                支援黏貼大篇幅文字。如果您有 Youtube 的字幕，可以先至 YouTube 複製其逐字稿直接貼到此處進行深度彙整。
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Advanced Configurations Accent */}
      <div className="border-t border-slate-100 pt-5">
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center justify-between w-full text-left text-slate-700 hover:text-slate-900 transition-all cursor-pointer"
          id="btn-toggle-options"
        >
          <div className="flex items-center space-x-2.5">
            <Sliders className="h-4 w-4 text-slate-500" />
            <span className="text-sm font-bold text-slate-800">AI 重點彙整與多語翻譯偏好</span>
          </div>
          <ChevronDown
            className={`h-4 w-4 text-slate-400 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
          />
        </button>

        {showAdvanced && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-5 mt-4 pt-2 bg-slate-50/50 p-4 border border-slate-100 rounded-xl">
            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-700 tracking-wide">
                AI Provider
              </label>
              <div className="space-y-1.5">
                <label className="flex items-center p-2 rounded-lg bg-white border border-slate-100 hover:border-slate-300 cursor-pointer transition-all">
                  <input
                    type="radio"
                    name="provider"
                    value="gemini"
                    checked={provider === "gemini"}
                    onChange={() => setProvider("gemini")}
                    disabled={isLoading}
                    className="h-4 w-4 text-slate-900 border-slate-300 focus:ring-slate-900"
                  />
                  <div className="ml-3 min-w-0">
                    <span className="block text-xs font-bold text-slate-800">Google Gemini</span>
                    <span className="block text-[10px] text-slate-400">gemini-2.5-flash-lite</span>
                  </div>
                </label>
                <label className="flex items-center p-2 rounded-lg bg-white border border-slate-100 hover:border-slate-300 cursor-pointer transition-all mt-1.5">
                  <input
                    type="radio"
                    name="provider"
                    value="nvidia"
                    checked={provider === "nvidia"}
                    onChange={() => setProvider("nvidia")}
                    disabled={isLoading}
                    className="h-4 w-4 text-slate-900 border-slate-300 focus:ring-slate-900"
                  />
                  <div className="ml-3 min-w-0">
                    <span className="block text-xs font-bold text-slate-800">NVIDIA</span>
                    <span className="block text-[10px] text-slate-400">llama-3.3-nemotron-super-49b-v1.5</span>
                  </div>
                </label>
              </div>
              {provider === "nvidia" && (
                <div className="flex items-start space-x-2 text-[10px] text-slate-500 bg-white border border-slate-100 rounded-lg p-2">
                  <Cpu className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>NVIDIA text model supports long pasted transcripts and link text.</span>
                </div>
              )}
            </div>

            {/* Depth */}
            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-700 tracking-wide">
                摘要深度與完整度
              </label>
              <div className="space-y-1.5Packed">
                <label className="flex items-center p-2 rounded-lg bg-white border border-slate-100 hover:border-slate-300 cursor-pointer transition-all">
                  <input
                    type="radio"
                    name="depth"
                    value="quick"
                    checked={depth === "quick"}
                    onChange={() => setDepth("quick")}
                    disabled={isLoading}
                    className="h-4 w-4 text-slate-900 border-slate-300 focus:ring-slate-900"
                  />
                  <div className="ml-3">
                    <span className="block text-xs font-bold text-slate-800">簡短精華大綱</span>
                    <span className="block text-[10px] text-slate-400">只提煉最核心的主幹</span>
                  </div>
                </label>
                <label className="flex items-center p-2 rounded-lg bg-white border border-slate-100 hover:border-slate-300 cursor-pointer transition-all mt-1.5">
                  <input
                    type="radio"
                    name="depth"
                    value="detailed"
                    checked={depth === "detailed"}
                    onChange={() => setDepth("detailed")}
                    disabled={isLoading}
                    className="h-4 w-4 text-slate-900 border-slate-300 focus:ring-slate-900"
                  />
                  <div className="ml-3">
                    <span className="block text-xs font-bold text-slate-800">深度章節解析 (推薦)</span>
                    <span className="block text-[10px] text-slate-400">完整論點、脈絡與論點還原</span>
                  </div>
                </label>
                <label className="flex items-center p-2 rounded-lg bg-white border border-slate-100 hover:border-slate-300 cursor-pointer transition-all mt-1.5">
                  <input
                    type="radio"
                    name="depth"
                    value="mindmap"
                    checked={depth === "mindmap"}
                    onChange={() => setDepth("mindmap")}
                    disabled={isLoading}
                    className="h-4 w-4 text-slate-900 border-slate-300 focus:ring-slate-900"
                  />
                  <div className="ml-3">
                    <span className="block text-xs font-bold text-slate-800">心智圖階層結構</span>
                    <span className="block text-[10px] text-slate-400">以樹狀關聯整理邏輯結構</span>
                  </div>
                </label>
              </div>
            </div>

            {/* Focus / Output goal */}
            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-700 tracking-wide">
                彙整重心定位
              </label>
              <div className="space-y-1.5">
                <label className="flex items-center p-2 rounded-lg bg-white border border-slate-100 hover:border-slate-300 cursor-pointer transition-all">
                  <input
                    type="radio"
                    name="primaryGoal"
                    value="takeaways"
                    checked={primaryGoal === "takeaways"}
                    onChange={() => setPrimaryGoal("takeaways")}
                    disabled={isLoading}
                    className="h-4 w-4 text-slate-900 border-slate-300 focus:ring-slate-900"
                  />
                  <div className="ml-3">
                    <span className="block text-xs font-bold text-slate-800">知識核心 Takeaways</span>
                    <span className="block text-[10px] text-slate-400">提煉關鍵概念、技術要義與亮點</span>
                  </div>
                </label>
                <label className="flex items-center p-2 rounded-lg bg-white border border-slate-100 hover:border-slate-300 cursor-pointer transition-all mt-1.5">
                  <input
                    type="radio"
                    name="primaryGoal"
                    value="actions"
                    checked={primaryGoal === "actions"}
                    onChange={() => setPrimaryGoal("actions")}
                    disabled={isLoading}
                    className="h-4 w-4 text-slate-900 border-slate-300 focus:ring-slate-900"
                  />
                  <div className="ml-3">
                    <span className="block text-xs font-bold text-slate-800">待辦與行動清單 Action Items</span>
                    <span className="block text-[10px] text-slate-400">抓出會議交辦事務、具體下一步計劃</span>
                  </div>
                </label>
                <label className="flex items-center p-2 rounded-lg bg-white border border-slate-100 hover:border-slate-300 cursor-pointer transition-all mt-1.5">
                  <input
                    type="radio"
                    name="primaryGoal"
                    value="full-transcript"
                    checked={primaryGoal === "full-transcript"}
                    onChange={() => setPrimaryGoal("full-transcript")}
                    disabled={isLoading}
                    className="h-4 w-4 text-slate-900 border-slate-300 focus:ring-slate-900"
                  />
                  <div className="ml-3">
                    <span className="block text-xs font-bold text-slate-800">全文精準逐字聽寫</span>
                    <span className="block text-[10px] text-slate-400">盡量完整重現影音逐字並進行組織</span>
                  </div>
                </label>
              </div>
            </div>

            {/* Translation Languages */}
            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-700 tracking-wide flex items-center space-x-1">
                <span>翻譯與重點整理目標語系（複選）</span>
              </label>
              <p className="text-[10px] text-slate-400">
                AI 將同步產出以下已核選國語系的重點大綱、會議記錄與精準翻譯段落。
              </p>
              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => handleLanguageToggle("zh")}
                  disabled={isLoading}
                  className={`flex items-center justify-between p-2.5 rounded-lg border text-xs font-semibold text-left transition-all cursor-pointer ${
                    targetLanguages.includes("zh")
                      ? "bg-indigo-600 text-white border-indigo-600 shadow-xs"
                      : "bg-white text-slate-700 border-slate-200 hover:border-indigo-300"
                  }`}
                >
                  <span>繁體中文 (ZH)</span>
                  {targetLanguages.includes("zh") && <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse"></span>}
                </button>

                <button
                  type="button"
                  onClick={() => handleLanguageToggle("en")}
                  disabled={isLoading}
                  className={`flex items-center justify-between p-2.5 rounded-lg border text-xs font-semibold text-left transition-all cursor-pointer ${
                    targetLanguages.includes("en")
                      ? "bg-indigo-600 text-white border-indigo-600 shadow-xs"
                      : "bg-white text-slate-700 border-slate-200 hover:border-indigo-300"
                  }`}
                >
                  <span>英文 (EN)</span>
                  {targetLanguages.includes("en") && <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse"></span>}
                </button>

                <button
                  type="button"
                  onClick={() => handleLanguageToggle("ja")}
                  disabled={isLoading}
                  className={`flex items-center justify-between p-2.5 rounded-lg border text-xs font-semibold text-left transition-all cursor-pointer ${
                    targetLanguages.includes("ja")
                      ? "bg-indigo-600 text-white border-indigo-600 shadow-xs"
                      : "bg-white text-slate-700 border-slate-200 hover:border-indigo-300"
                  }`}
                >
                  <span>日本語 (JA)</span>
                  {targetLanguages.includes("ja") && <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse"></span>}
                </button>

                <button
                  type="button"
                  onClick={() => handleLanguageToggle("ko")}
                  disabled={isLoading}
                  className={`flex items-center justify-between p-2.5 rounded-lg border text-xs font-semibold text-left transition-all cursor-pointer ${
                    targetLanguages.includes("ko")
                      ? "bg-indigo-600 text-white border-indigo-600 shadow-xs"
                      : "bg-white text-slate-700 border-slate-200 hover:border-indigo-300"
                  }`}
                >
                  <span>한국어 (KO)</span>
                  {targetLanguages.includes("ko") && <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse"></span>}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Submit button */}
      <div className="pt-2">
        <button
          onClick={handleSubmit}
          disabled={isLoading}
          className={`relative w-full flex items-center justify-center space-x-2 py-4 px-6 rounded-xl text-base font-bold text-white shadow-md transition-all cursor-pointer ${
            isLoading
              ? "bg-indigo-400 cursor-not-allowed"
              : "bg-indigo-600 hover:bg-indigo-700 shadow-indigo-600/20 active:scale-[0.99]"
          }`}
          id="btn-process-media"
        >
          {isLoading ? (
            <>
              <svg
                className="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
              <span>正在傳輸音軌並分析此媒體 (約需 10-30 秒)...</span>
            </>
          ) : (
            <>
              <Sparkles className="h-5 w-5 text-amber-400 animate-pulse" />
              <span>啟動 AI 重點智整理與多語對照翻譯 &rarr;</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
