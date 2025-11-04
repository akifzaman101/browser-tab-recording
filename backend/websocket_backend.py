# websocket_backend.py
# Multi-speaker diarization + English/Japanese transcription (v2 API)

import asyncio
import websockets
import json
from datetime import datetime
import os
from typing import Optional
from collections import Counter
from openai import OpenAI
from google.cloud.speech_v2 import SpeechClient
from google.cloud.speech_v2.types import cloud_speech
import threading
import queue
from dotenv import load_dotenv

load_dotenv("../.env")

SAVE_DIR = "received_recordings"
os.makedirs(SAVE_DIR, exist_ok=True)

PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT")
if not PROJECT_ID:
    raise ValueError("GOOGLE_CLOUD_PROJECT environment variable is not set. Please set it in your .env file.")

openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

class RecordingSession:
    def __init__(self, session_id, file_ext="raw"):
        self.session_id = session_id
        self.chunks = []
        self.transcripts = []
        self.total_bytes = 0
        self.start_time = datetime.now()
        self.filepath = os.path.join(SAVE_DIR, f"recording_{session_id}.{file_ext}")
    
    def add_chunk(self, chunk_data: bytes):
        self.chunks.append(chunk_data)
        self.total_bytes += len(chunk_data)
        with open(self.filepath, "ab") as f:
            f.write(chunk_data)
    
    def add_transcript(self, speaker: str, text: str, language: str):
        """Add a final transcript line."""
        self.transcripts.append({
            "speaker": speaker,
            "text": text,
            "language": language,
            "timestamp": datetime.now().isoformat()
        })
    
    def get_stats(self):
        duration = (datetime.now() - self.start_time).total_seconds()
        return {
            "session_id": self.session_id,
            "chunks_received": len(self.chunks),
            "total_bytes": self.total_bytes,
            "total_mb": round(self.total_bytes / (1024 * 1024), 2),
            "duration_seconds": round(duration, 2),
            "filepath": self.filepath,
            "transcript_lines": len(self.transcripts)
        }

sessions = {}
speech_client = SpeechClient()

RECOGNIZER_ID = "diarization-recognizer"
RECOGNIZER_PATH = f"projects/{PROJECT_ID}/locations/global/recognizers/{RECOGNIZER_ID}"

def ensure_recognizer_exists():
    """Create recognizer if it doesn't exist."""
    try:
        speech_client.get_recognizer(name=RECOGNIZER_PATH)
        print(f"✅ Using existing recognizer: {RECOGNIZER_ID}")
    except Exception:
        print(f"🔨 Creating recognizer: {RECOGNIZER_ID}")
        try:
            request = cloud_speech.CreateRecognizerRequest(
                parent=f"projects/{PROJECT_ID}/locations/global",
                recognizer_id=RECOGNIZER_ID,
                recognizer=cloud_speech.Recognizer(
                    language_codes=["en-US", "ja-JP"],
                    model="long",
                ),
            )
            operation = speech_client.create_recognizer(request=request)
            operation.result(timeout=300)
            print(f"✅ Recognizer created: {RECOGNIZER_ID}")
        except Exception as e:
            print(f"❌ Failed to create recognizer: {e}")
            raise

def build_streaming_config(sample_rate: int = 48000) -> cloud_speech.StreamingRecognitionConfig:
    recognition_config = cloud_speech.RecognitionConfig(
        explicit_decoding_config=cloud_speech.ExplicitDecodingConfig(
            encoding=cloud_speech.ExplicitDecodingConfig.AudioEncoding.LINEAR16,
            sample_rate_hertz=sample_rate,
            audio_channel_count=1,
        ),
        language_codes=["en-US", "ja-JP"],
        model="long",
        features=cloud_speech.RecognitionFeatures(
            enable_automatic_punctuation=True,
            enable_word_time_offsets=True,
            enable_word_confidence=True,
        ),
    )
    
    return cloud_speech.StreamingRecognitionConfig(
        config=recognition_config,
        streaming_features=cloud_speech.StreamingRecognitionFeatures(
            interim_results=True,
        ),
    )
    
def generate_summary(transcripts: list) -> dict:
    """Generate summary from transcripts using OpenAI."""
    if not transcripts:
        return {"summary": "No transcription available", "key_points": []}
    
    full_text = "\n".join([f"{t['speaker']}: {t['text']}" for t in transcripts])
    
    try:
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "You are a helpful assistant that summarizes conversations. Provide a concise brief summary and extract 3-5 key points."},
                {"role": "user", "content": f"Summarize this conversation:\n\n{full_text}\n\nProvide:\n1. A brief summary (2-3 sentences)\n2. Key points (3-5 bullet points)"}
            ],
            temperature=0.7,
            max_tokens=500
        )
        
        summary_text = response.choices[0].message.content
        print(f"✅ Summary generated: {len(summary_text)} chars")
        return {"summary": summary_text, "error": None}
    
    except Exception as e:
        print(f"❌ Summary generation failed: {e}")
        return {"summary": None, "error": str(e)}

def start_stt_thread(
    audio_q: "queue.Queue[Optional[bytes]]",
    websocket: websockets.WebSocketServerProtocol,
    loop: asyncio.AbstractEventLoop,
    sample_rate: int,
    session: RecordingSession,
):
    print(f"🎤 STT thread started ({sample_rate}Hz, EN/JP, 2 speakers)")
    
    while True:
        streaming_config = build_streaming_config(sample_rate)
        
        def request_generator():
            chunk_count = 0
            yield cloud_speech.StreamingRecognizeRequest(
                recognizer=RECOGNIZER_PATH,
                streaming_config=streaming_config,
            )
            
            while True:
                try:
                    chunk = audio_q.get(timeout=1.0)
                    if chunk is None:
                        print(f"🛑 Stop signal received ({chunk_count} chunks)")
                        return
                    if len(chunk) > 0:
                        chunk_count += 1
                        yield cloud_speech.StreamingRecognizeRequest(audio=chunk)
                except queue.Empty:
                    continue
        
        try:
            responses = speech_client.streaming_recognize(requests=request_generator())
            print("📊 STT stream active")
            
            for response in responses:
                if not response.results:
                    continue
                    
                for result in response.results:
                    if not result.alternatives:
                        continue
                        
                    alt = result.alternatives[0]
                    transcript = alt.transcript or ""
                    is_final = bool(result.is_final)
                    
                    detected_language = result.language_code if hasattr(result, 'language_code') else "en-US"
                    language_name = "English" if detected_language.startswith("en") else "Japanese" if detected_language.startswith("ja") else detected_language
                    
                    speaker_tag = None
                    if alt.words and len(alt.words) > 0:
                        speaker_tags = [word.speaker_label for word in alt.words if hasattr(word, 'speaker_label') and word.speaker_label]
                        if speaker_tags:
                            speaker_tag = Counter(speaker_tags).most_common(1)[0][0]
                    
                    speaker_label = f"Speaker {speaker_tag}" if speaker_tag else "Speaker"
                    confidence = alt.confidence if is_final and hasattr(alt, 'confidence') else None
                    
                    if is_final and transcript.strip():
                        session.add_transcript(speaker_label, transcript, language_name)
                    
                    status = "✅" if is_final else "⏳"
                    print(f"{status} [{language_name}] {speaker_label}: {transcript}")

                    payload = {
                        "type": "transcript",
                        "text": transcript,
                        "final": is_final,
                        "speaker": speaker_label,
                        "language": detected_language,
                        "language_name": language_name,
                        "confidence": confidence,
                        "ts": datetime.utcnow().isoformat() + "Z",
                    }
                    
                    asyncio.run_coroutine_threadsafe(websocket.send(json.dumps(payload)), loop)
            
            print("✅ STT stream closed")
            break
            
        except Exception as e:
            error_str = str(e)
            
            if "Audio Timeout" in error_str or "OUT_OF_RANGE" in error_str:
                print("⟳ Restarting stream (silence timeout)")
                continue
            else:
                print(f"❌ STT error: {e}")
                break
    
    print("🎤 STT thread exiting")

async def handle_client(websocket):
    session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    session = RecordingSession(session_id, file_ext="raw")
    sessions[session_id] = session

    audio_q: "queue.Queue[Optional[bytes]]" = None
    current_sample_rate = 48000
    recording_active = False
    stt_thread = None

    print(f"\n🟢 New client: {session_id}")

    await websocket.send(json.dumps({
        "type": "connected",
        "session_id": session_id,
        "message": "WebSocket connection established"
    }))

    loop = asyncio.get_event_loop()

    try:
        async for message in websocket:
            if isinstance(message, (bytes, bytearray)):
                chunk = bytes(message)
                session.add_chunk(chunk)
                
                if not recording_active:
                    recording_active = True
                    audio_q = queue.Queue()
                    stt_thread = threading.Thread(
                        target=start_stt_thread,
                        args=(audio_q, websocket, loop, current_sample_rate, session),
                        daemon=True
                    )
                    stt_thread.start()
                    print("🎙️ Recording started")
                
                if audio_q:
                    audio_q.put(chunk)
                    
            else:
                try:
                    data = json.loads(message)
                    if data.get("type") == "audio_format":
                        sr = int(data.get("sampleRateHertz", current_sample_rate))
                        current_sample_rate = sr
                        print(f"🎵 Format: {data.get('encoding', 'LINEAR16')}, {sr}Hz")
                        await websocket.send(json.dumps({
                            "type": "audio_format_ack",
                            "sampleRateHertz": sr,
                            "encoding": data.get("encoding", "LINEAR16"),
                            "channels": data.get("channels", 1)
                        }))
                    elif data.get("type") == "recording_stopped":
                        print("🛑 Recording stopped")
                        if recording_active and audio_q:
                            audio_q.put(None)
                            if stt_thread:
                                stt_thread.join(timeout=3.0)
                        
                        print("🤖 Generating summary...")
                        summary_result = generate_summary(session.transcripts)
                        
                        recording_active = False
                        audio_q = None
                        stt_thread = None
                        
                        await websocket.send(json.dumps({
                            "type": "recording_stopped_ack",
                            "message": "Recording stopped",
                            "summary": summary_result
                        }))
                    elif data.get("type") == "recording_complete":
                        stats = session.get_stats()
                        print(f"🎬 Complete: {stats['total_mb']} MB, {stats['duration_seconds']}s")
                        await websocket.send(json.dumps({
                            "type": "recording_saved",
                            "stats": stats
                        }))
                except json.JSONDecodeError:
                    pass

    except websockets.exceptions.ConnectionClosed:
        print(f"🔌 Connection closed")
    except Exception as e:
        print(f"❌ Error: {e}")
    finally:
        if recording_active and audio_q:
            audio_q.put(None)
        if stt_thread:
            stt_thread.join(timeout=3.0)
        if session_id in sessions:
            stats = sessions[session_id].get_stats()
            print(f"\n🔴 Disconnected: {stats['total_mb']} MB, {stats['duration_seconds']}s")
            del sessions[session_id]
            
async def main():
    host = "localhost"
    port = 8765
    
    print(f"🚀 WebSocket Server Starting...")
    print(f"📡 Listening on ws://{host}:{port}")
    print(f"📁 Recordings: {os.path.abspath(SAVE_DIR)}")
    print(f"🌐 EN/JP (v2 API) • 2 speakers\n")
    
    # Ensure recognizer exists before starting server
    ensure_recognizer_exists()
    
    async with websockets.serve(handle_client, host, port, max_size=10 * 1024 * 1024):
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\n👋 Server stopped")