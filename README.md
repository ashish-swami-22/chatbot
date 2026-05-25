# Gemini Chatbot

## Local Setup

### 1. Install Node.js

Use Node.js 20 or newer.

### 2. Create your `.env`

Set these values:

```powershell
PORT=3000
SUPABASE_URL=https://your-project-ref.supabase.co
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

## Notes

- `SUPABASE_URL` points this app to the Supabase Edge Function for chat responses.
- Set `GEMINI_API_KEY` in your Supabase Edge Function secrets.
- Conversation data is stored locally by the app.
