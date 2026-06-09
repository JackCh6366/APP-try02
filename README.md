<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/100241b0-bb4e-4ffa-b993-2c944cf14f74

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set `GEMINI_API_KEY` and `NVIDIA_API_KEY` in `.env.local` for local testing.
3. Run the app locally:
   `npm run dev`

During local development, Vite mounts `api/generate.ts` at `/api/generate` and reads keys from `.env.local`.

## Deploy on Vercel

Add these environment variables in Vercel Project Settings:

```bash
GEMINI_API_KEY=your_Gemini_API_key
NVIDIA_API_KEY=your_NVIDIA_API_key
```

The frontend calls `/api/generate`, which is implemented as a Vercel Serverless Function in `api/generate.ts`.

AI provider models:

- Google Gemini: `gemini-2.5-flash-lite`
- NVIDIA: `nvidia/llama-3.3-nemotron-super-49b-v1.5`
