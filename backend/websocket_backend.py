# websocket_backend.py
# Multi-speaker diarization + English/Japanese transcription

import asyncio
import websockets
import json
from datetime import datetime
import os
from typing import Optional
from collections import Counter
from openai import OpenAI
from google.cloud import speech_v1p1beta1 as speech
import threading
import queue
from dotenv import load_dotenv

load_dotenv("../.env")

SAVE_DIR = "received_recordings"
os.makedirs(SAVE_DIR, exist_ok=True)

openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

class RecordingSession:
    def __init__(self, session_id, file_ext="raw"):
        self.session_id = session_id
        self.chunks = []
        self.transcripts = []  # ✅ NEW: Store transcripts
        self.total_bytes = 0
        self.start_time = datetime.now()
        self.filepath = os.path.join(SAVE_DIR, f"recording_{session_id}.{file_ext}")
    
    def add_chunk(self, chunk_data: bytes):
        self.chunks.append(chunk_data)
        self.total_bytes += len(chunk_data)
        with open(self.filepath, "ab") as f:
            f.write(chunk_data)
    
    def add_transcript(self, speaker: str, text: str, language: str):  # ✅ NEW
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
            "transcript_lines": len(self.transcripts)  # ✅ NEW
        }

sessions = {}
speech_client = speech.SpeechClient()

def build_streaming_config(sample_rate: int = 48000) -> speech.StreamingRecognitionConfig:
    diarization_config = speech.SpeakerDiarizationConfig(
        enable_speaker_diarization=True,
        min_speaker_count=2,
        max_speaker_count=2,
    )
    
    rec_config = speech.RecognitionConfig(
        encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
        sample_rate_hertz=sample_rate,
        audio_channel_count=1,
        language_code="en-US",
        alternative_language_codes=["ja-JP"],
        enable_automatic_punctuation=True,
        diarization_config=diarization_config,
        model="default",
        use_enhanced=True,
        enable_word_time_offsets=True,
        enable_word_confidence=True,
    )
    
    return speech.StreamingRecognitionConfig(
        config=rec_config,
        interim_results=True,
        single_utterance=False,
    )
    
def generate_summary(transcripts: list) -> dict:
    """Generate summary from transcripts using OpenAI."""
    if not transcripts:
        return {"summary": "No transcription available", "key_points": []}
    
    # Combine all transcripts
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
    session: RecordingSession,  # ✅ NEW: Pass session
):
    print(f"🎤 STT thread started ({sample_rate}Hz, EN/JP, 2 speakers)")
    
    while True:
        streaming_config = build_streaming_config(sample_rate)
        
        def audio_generator():
            chunk_count = 0
            while True:
                try:
                    chunk = audio_q.get(timeout=1.0)
                    if chunk is None:
                        print(f"🛑 Stop signal received ({chunk_count} chunks)")
                        return
                    if len(chunk) > 0:
                        chunk_count += 1
                        yield chunk
                except queue.Empty:
                    continue
        
        try:
            requests = (
                speech.StreamingRecognizeRequest(audio_content=content)
                for content in audio_generator()
            )
            
            responses = speech_client.streaming_recognize(streaming_config, requests)
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
                    
                    detected_language = getattr(alt, 'language', "en-US")
                    language_name = "English" if detected_language.startswith("en") else "Japanese" if detected_language.startswith("ja") else detected_language
                    
                    speaker_tag = None
                    if alt.words and len(alt.words) > 0:
                        speaker_tags = [getattr(word, "speaker_tag", None) or getattr(word, "speakerTag", None) for word in alt.words if getattr(word, "speaker_tag", None) or getattr(word, "speakerTag", None)]
                        if speaker_tags:
                            speaker_tag = Counter(speaker_tags).most_common(1)[0][0]
                    
                    speaker_label = f"Speaker {speaker_tag}" if speaker_tag else "Speaker"
                    confidence = getattr(alt, 'confidence', None) if is_final else None
                    
                    # ✅ NEW: Store final transcripts in session
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
                        args=(audio_q, websocket, loop, current_sample_rate, session),  # ✅ Pass session
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
                        
                        # ✅ NEW: Generate summary
                        print("🤖 Generating summary...")
                        summary_result = generate_summary(session.transcripts)
                        
                        recording_active = False
                        audio_q = None
                        stt_thread = None
                        
                        await websocket.send(json.dumps({
                            "type": "recording_stopped_ack",
                            "message": "Recording stopped",
                            "summary": summary_result  # ✅ Send summary
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
    print(f"🌍 EN/JP (Chirp) • 2 speakers\n")
    
    async with websockets.serve(handle_client, host, port, max_size=10 * 1024 * 1024):
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\n👋 Server stopped")