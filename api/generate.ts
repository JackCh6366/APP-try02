// ─────────────────────────────────────────────────────────────────────────────
// buildGeminiContents - 混合模式 v3（Vercel 安全版）
// 優先 fileUri，失敗時自動走字幕模式
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

    const isYoutube = isYoutubeUrl(body.videoLink);

    // YouTube 優先使用 fileUri 直接聽音訊
    if (isYoutube) {
      return [
        {
          fileData: {
            fileUri: body.videoLink,
            mimeType: "video/mp4",
          },
        },
        {
          text: "Please fully transcribe and analyze this video's audio content in detail.",
        },
      ];
    }

    // 非 YouTube 或 fallback 時使用字幕模式
    const context = await getNonYoutubeLinkContext(body.videoLink);
    return [{
      text: `Analyze this media link: ${body.videoLink}\n\nPage context:\n${context.pageText || "(none)"}\n\nTranscript or captions:\n${context.transcript || "(no captions found; please provide transcript manually)"}`,
    }];
  }

  // 上傳檔案模式
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