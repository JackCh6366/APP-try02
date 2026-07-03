const fs = require('fs');

function extractFirstJsonBlock(str) {
  const start = str.indexOf('{');
  if (start === -1) return str;

  let braceCount = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < str.length; i++) {
    const char = str[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          return str.slice(start, i + 1);
        }
      }
    }
  }

  return str;
}

try {
  const nvidiaRaw = fs.readFileSync('nvidia_full_raw_response.json', 'utf8');
  const cleaned = extractFirstJsonBlock(nvidiaRaw);
  console.log('NVIDIA Cleaned length:', cleaned.length);
  JSON.parse(cleaned);
  console.log('NVIDIA JSON is VALID!');
} catch (e) {
  console.log('NVIDIA JSON parsing FAILED:', e.message);
}

try {
  const geminiRaw = fs.readFileSync('gemini_multimodal_raw_response.json', 'utf8');
  const cleaned = extractFirstJsonBlock(geminiRaw);
  console.log('Gemini Cleaned length:', cleaned.length);
  JSON.parse(cleaned);
  console.log('Gemini JSON is VALID!');
} catch (e) {
  console.log('Gemini JSON parsing FAILED:', e.message);
}
