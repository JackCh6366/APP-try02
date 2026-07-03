const fs = require('fs');
const { YoutubeTranscript } = require('youtube-transcript');

const apiKey = "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";

const systemPrompt = `You are an expert multilingual media analyst and transcription specialist.
Your task is to analyze the provided audio/video/transcript content and return a structured JSON response.

Analysis depth: Detailed analysis
Be thorough and comprehensive — include all important details, context, and nuance.
Focus on key takeaways, insights, and the most important concepts.

You MUST respond with ONLY valid JSON (no markdown fences, no prose), matching this exact schema:
{
  "title": "string — concise title for this content",
  "originalLanguage": "string — detected primary spoken/written language",
  "transcript": "" (IMPORTANT: always output empty string for this field — transcript is injected separately),
  "summaryText": "string — comprehensive summary in Traditional Chinese (繁體中文)",
  "segments": [
    {
      "title": "string — section heading",
      "timeRange": "string or null — e.g. '00:00 - 05:30'",
      "summary": "string — paragraph summary of this segment"
    }
  ],
  "keyConcepts": ["string", "..."],
  "actionItems": ["string", "..."],
  "translations": {
    "en": "string — full formatted Markdown summary in English"
  }
}

Target translation languages: English
If translation for a language is not requested, omit that key from translations.
Always include the Traditional Chinese summary in "summaryText".`;

const videoLink = 'https://www.youtube.com/watch?v=OViPNQR49Uw';

console.log("Fetching YouTube transcript...");
YoutubeTranscript.fetchTranscript(videoLink)
  .then(segments => {
    const rawTranscript = segments.map(s => s.text).join(' ');
    console.log("Fetched transcript length:", rawTranscript.length);

    const textContent = `YouTube URL: ${videoLink}\n\n字幕內容（逐字稿）：\n${rawTranscript}`;

    const MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1.5";
    const url = "https://integrate.api.nvidia.com/v1/chat/completions";

    console.log("Sending request to NVIDIA...");
    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: "/no_think\n\n" + systemPrompt },
          { role: "user", content: textContent },
        ],
        temperature: 0.2,
        max_tokens: 8192,
      }),
    });
  })
  .then(r => r.json())
  .then(data => {
    const rawText = data.choices?.[0]?.message?.content;
    console.log("Response length:", rawText ? rawText.length : 0);
    if (rawText) {
      fs.writeFileSync('nvidia_full_raw_response.json', rawText);
      console.log("Raw response saved to nvidia_full_raw_response.json");
      try {
        JSON.parse(rawText);
        console.log("JSON is VALID!");
      } catch (e) {
        console.log("JSON parsing FAILED:", e.message);
        try {
          const match = e.message.match(/position (\d+)/);
          if (match) {
            const pos = parseInt(match[1], 10);
            console.log("Context around error position:", JSON.stringify(rawText.slice(Math.max(0, pos - 50), pos + 50)));
          }
        } catch (_) {}
      }
    } else {
      console.log("Error or empty response:", data);
    }
  })
  .catch(console.error);
