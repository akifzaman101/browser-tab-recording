# Meeting Recorder with Live Transcription

A real-time meeting recorder with live transcription using Google Cloud Speech-to-Text and OpenAI for summaries.

## What's Being Used

### Frontend
- **React** - UI framework for the web app
- **Web Audio API** - Capture and process audio from microphone and screen
- **AudioWorklet** - Convert audio to PCM format in real-time
- **WebSocket** - Send audio stream to backend and receive transcripts

### Backend
- **Python + WebSockets** - Server for handling connections and audio streaming
- **Google Cloud Speech-to-Text** - Multi-language transcription with speaker diarization
- **OpenAI GPT-4** - Generate meeting summaries automatically

## How It Works

### Recording Flow

1. **User selects meeting type:**
   - Online Meeting: Captures screen + microphone audio
   - In-Person Meeting: Captures only microphone audio

2. **Audio Capture:**
   - Web Audio API mixes microphone and system audio
   - AudioWorklet converts audio to 16-bit PCM format
   - Audio sent in 20ms chunks via WebSocket to backend

3. **Real-Time Transcription:**
   - Backend receives PCM audio stream
   - Google Speech-to-Text processes audio and detects speakers
   - Transcripts sent back to frontend in real-time
   - Interim results show as user is speaking
   - Final results confirmed after silence

4. **Meeting Summary:**
   - After recording stops, backend collects all transcripts
   - OpenAI GPT-4 generates a concise summary
   - Summary displayed in the app

### Video Recording (Online Mode)
- Screen + mixed audio combined into MediaStream
- Recorded as WebM video and auto-downloaded
- Saved on backend as raw PCM audio file

## Tech Stack Summary

| Component | Technology |
|-----------|-----------|
| Frontend UI | React + CSS |
| Audio Processing | Web Audio API + AudioWorklet |
| Real-time Comms | WebSocket |
| Speech Recognition | Google Cloud Speech-to-Text |
| Speaker Diarization | Google Cloud (built-in) |
| Languages | English & Japanese |
| Summarization | OpenAI GPT-4 |
| Backend | Python + asyncio |

## Setup

### Frontend
```bash
cd frontend
npm install
npm start
# Runs on http://localhost:3000
```

### Backend
```bash
pip install -r requirements.txt
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/credentials.json"
python websocket_backend.py
# Runs on ws://localhost:8765
```

## Key Features

🎤 **Dual Mode Recording**
- Online: Screen + Audio with video download
- In-Person: Microphone only for meetings

📊 **Real-Time Transcription**
- Multi-speaker detection
- English & Japanese support
- Confidence scores
- Live interim + final text

📝 **Auto Summarization**
- AI-powered summaries
- Generated on recording stop

🎬 **Video Export**
- WebM format for online meetings
- Automatic download

## File Structure

```
frontend/
├── src/
│   ├── App.jsx            # Main React component
│   ├── App.css            # Styling
│   └── index.js
├── backend/
│   ├── websocket_backend.py
│   ├── requirements.txt
│   └── received_recordings/   # Saved audio files
├── package.json
└── README.md
```

## Requirements

- Node.js 16+
- Python 3.9+
- Google Cloud Speech-to-Text API key
- OpenAI API key

## Environment Variables

```env
OPENAI_API_KEY=sk-your-key-here
GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json
```

## Audio Specs

- **Sample Rate**: 48kHz
- **Format**: 16-bit PCM mono
- **Chunk Size**: 20ms chunks
- **Latency**: ~500ms for transcription

## Browser Support

Chrome/Edge 88+, Firefox 79+, Safari 14.1+