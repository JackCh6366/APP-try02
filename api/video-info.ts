// api/video-info.ts
// Vercel Serverless Function：抓取 YouTube 影片基本資訊
// 使用 YouTube oEmbed（免費，不需要 API Key）+ 頁面解析取得時長
 
export const config = {
  api: {
    bodyParser: { sizeLimit: "1mb" },
  },
};
 
interface VideoInfo {
  title: string;
  channelName: string;
  thumbnailUrl: string;
  durationText: string;   // 格式化後的時長，例如 "12:34"
  durationSeconds: number;
  isPlaylist: boolean;
  playlistWarning?: string;
  videoId: string | null;
}
 
function getYoutubeVideoId(url: string): string | null {
  const match = url.match(
    /^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/|shorts\/)|(?:(?:watch)?\?v(?:i)?=|&v(?:i)?=))([^#&?]*).*/
  );
  return match?.[1]?.length === 11 ? match[1] : null;
}
 
function isPlaylistUrl(url: string): boolean {
  return url.includes("list=") && url.includes("youtube");
}
 
function formatDuration(seconds: number): string {
  if (seconds <= 0) return "時長未知";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}
 
// 從 YouTube 頁面 HTML 解析時長（ISO 8601 格式 PT#H#M#S）
function parseDurationFromHtml(html: string): number {
  // 嘗試從 JSON-LD schema 取得
  const schemaMatch = html.match(/"duration"\s*:\s*"PT([^"]+)"/);
  if (schemaMatch) {
    const iso = schemaMatch[1];
    let total = 0;
    const h = iso.match(/(\d+)H/);
    const m = iso.match(/(\d+)M/);
    const s = iso.match(/(\d+)S/);
    if (h) total += parseInt(h[1]) * 3600;
    if (m) total += parseInt(m[1]) * 60;
    if (s) total += parseInt(s[1]);
    return total;
  }
 
  // 嘗試從 meta itemprop 取得
  const metaMatch = html.match(/itemprop="duration"\s+content="PT([^"]+)"/);
  if (metaMatch) {
    const iso = metaMatch[1];
    let total = 0;
    const h = iso.match(/(\d+)H/);
    const m = iso.match(/(\d+)M/);
    const s = iso.match(/(\d+)S/);
    if (h) total += parseInt(h[1]) * 3600;
    if (m) total += parseInt(m[1]) * 60;
    if (s) total += parseInt(s[1]);
    return total;
  }
 
  return 0;
}
 
export default async function handler(req: any, res: any) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
 
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
 
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }
 
  // 支援 POST body 或 GET query string
  const url: string =
    (typeof req.body === "string" ? JSON.parse(req.body) : req.body)?.url ||
    req.query?.url ||
    "";
 
  if (!url?.trim()) {
    return res.status(400).json({ success: false, error: "請提供影片網址。" });
  }
 
  // 非 YouTube 連結直接回傳簡單結果
  if (!url.includes("youtube.com") && !url.includes("youtu.be")) {
    return res.status(200).json({
      success: true,
      info: {
        title: "非 YouTube 連結",
        channelName: "",
        thumbnailUrl: "",
        durationText: "時長未知",
        durationSeconds: 0,
        isPlaylist: false,
        videoId: null,
      } as VideoInfo,
    });
  }
 
  const videoId = getYoutubeVideoId(url);
  const isPlaylist = isPlaylistUrl(url);
 
  // 播放清單警告訊息
  let playlistWarning: string | undefined;
  if (isPlaylist) {
    if (videoId) {
      playlistWarning = "此連結包含播放清單參數（list=...），系統將只分析當前影片，不會逐一分析整個播放清單。";
    } else {
      playlistWarning = "此連結是播放清單頁面，無法直接分析整個清單。請開啟播放清單中的單一影片後複製其連結再試。";
    }
  }
 
  // 若無有效 videoId，直接回傳
  if (!videoId) {
    return res.status(200).json({
      success: true,
      info: {
        title: "無法取得影片資訊",
        channelName: "",
        thumbnailUrl: "",
        durationText: "時長未知",
        durationSeconds: 0,
        isPlaylist,
        playlistWarning,
        videoId: null,
      } as VideoInfo,
    });
  }
 
  // ── 1. 用 oEmbed 取得標題和頻道名稱 ──
  let title = "未知標題";
  let channelName = "";
  let thumbnailUrl = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`; // 預設縮圖
 
  try {
    const oembedRes = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (oembedRes.ok) {
      const data = await oembedRes.json() as {
        title?: string;
        author_name?: string;
        thumbnail_url?: string;
      };
      if (data.title) title = data.title;
      if (data.author_name) channelName = data.author_name;
      if (data.thumbnail_url) thumbnailUrl = data.thumbnail_url;
    }
  } catch {
    // oEmbed 失敗，使用預設值繼續
  }
 
  // ── 2. 抓頁面取得時長 ──
  let durationSeconds = 0;
  try {
    const pageRes = await fetch(
      `https://www.youtube.com/watch?v=${videoId}`,
      {
        signal: AbortSignal.timeout(7000),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
          "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
          "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+417",
        },
      }
    );
    if (pageRes.ok) {
      const html = await pageRes.text();
      durationSeconds = parseDurationFromHtml(html);
    }
  } catch {
    // 頁面抓取失敗，時長維持 0
  }
 
  // 超長影片額外提示
  let durationWarning: string | undefined;
  if (durationSeconds > 3600) {
    durationWarning = `此影片長達 ${formatDuration(durationSeconds)}，分析時間可能較長（約 30~60 秒），請耐心等候。`;
  } else if (durationSeconds > 1800) {
    durationWarning = `此影片長度超過 30 分鐘（${formatDuration(durationSeconds)}），分析約需 20~40 秒。`;
  }
 
  const info: VideoInfo & { durationWarning?: string } = {
    title,
    channelName,
    thumbnailUrl,
    durationText: formatDuration(durationSeconds),
    durationSeconds,
    isPlaylist,
    playlistWarning,
    durationWarning,
    videoId,
  };
 
  return res.status(200).json({ success: true, info });
}