// ─────────────────────────────────────────────────────────────────────────────
// buildGeminiContents - 混合模式（推薦版）
// 1. YouTube → 先試 fileUri（聽音訊）
// 2. 失敗 → fallback 抓字幕 + meta
// 3. 再失敗 → 明確提示使用者貼字幕
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

    // === 優先：YouTube 直接用 fileUri 聽音訊 ===
    if (isYoutube) {
      return [
        {
          fileData: {
            fileUri: body.videoLink,
            mimeType: "video/mp4",
          },
        },
        {
          text: "Please fully transcribe and analyze this video's audio content in detail. If you cannot access the audio, reply with exactly: [AUDIO_ACCESS_FAILED]",
        },
      ];
    }

    // 非 YouTube 連結：維持原本邏輯
    const context = await getNonYoutubeLinkContext(body.videoLink);
    return [{
      text: `Analyze this media link: ${body.videoLink}\n\nPage context:\n${context.pageText || "(none)"}\n\nTranscript:\n${context.transcript || "(no captions found)"}`,
    }];
  }

  // 上傳檔案模式（維持不變）
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