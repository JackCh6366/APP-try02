// ─────────────────────────────────────────────────────────────────────────────
// buildGeminiContents
// 【主要修改】link 模式分兩條路：
//   1. YouTube URL → 直接用 fileData.fileUri 讓 Gemini 原生讀取影片音訊
//   2. 一般 URL    → 維持原本抓 meta + 字幕的方式
// ─────────────────────────────────────────────────────────────────────────────
async function buildGeminiContents(body: GenerateBody) {
  if (body.mediaType === "transcript_paste") {
    if (!body.textTranscript?.trim()) {
      throw new Error("Please provide transcript text.");
    }
    return [{ text: `Analyze this transcript:\n\n${body.textTranscript}` }];
  }

  if (body.mediaType === "link") {
    if (!body.videoLink?.trim()) {
      throw new Error("Please provide a valid media URL.");
    }

    // ── YouTube：讓 Gemini 直接聽音訊，不靠字幕 ──
    if (isYoutubeUrl(body.videoLink)) {
      return [
        {
          fileData: {
            fileUri: body.videoLink,   // Gemini 原生支援 YouTube URL
            mimeType: "video/mp4",     // YouTube 連結填 video/mp4 即可觸發影音分析
          },
        },
        {
          text: "Please fully transcribe and analyze this video's audio content in detail. If you cannot access the audio or the link is invalid, reply with exactly: [CONTENT_ACCESS_FAILED]",
        },
      ];
    }

    // ── 非 YouTube：保留原本 meta + 字幕邏輯 ──
    const context = await getNonYoutubeLinkContext(body.videoLink);
    return [
      {
        text: `Analyze this media link: ${body.videoLink}\n\nPage context:\n${context.pageText || "(none)"}\n\nTranscript or captions:\n${
          context.transcript || "(no captions found; infer cautiously from available page context)"
        }`,
      },
    ];
  }

  if (!body.fileData) {
    throw new Error("Please provide media file data.");
  }

  return [
    {
      inlineData: {
        mimeType: body.mimeType || "audio/webm",
        data: body.fileData,
      },
    },
    {
      text: `Analyze this uploaded media file. File name: ${body.fileName || "untitled"}.`,
    },
  ];
}