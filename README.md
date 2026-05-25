# Gemini Chatbot

## Local Setup

### 1. Install Node.js

Use Node.js 20 or newer.

### 2. Create your `.env`

Set these values:

```powershell
PORT=3000
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
```

### 3. Start the app

```powershell
npm start
```

### 4. Open the app

```text
http://localhost:3000
```

The dashboard is here:

```text
http://localhost:3000/dashboard
```

## Kubernetes Setup

1. Build the image.
2. Apply the manifests in `k8s/`.
3. Create the Kubernetes Secret from `k8s/secret.example.yaml`.
4. Make sure the Deployment gets `GEMINI_API_KEY`.

## Notes

- The app talks to Gemini from the server side only.
- Conversation data is stored locally in `data/db.json`.
