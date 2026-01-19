# unified_transcription_server.py
# OPTIMIZED: Best quality configs for each service + auto-restart for GCP

import asyncio
import websockets
import json
from datetime import datetime
import os
import time
from collections import Counter
from google.cloud import speech_v1p1beta1 as speech_v1
from google.cloud.speech_v2 import SpeechClient
from google.cloud.speech_v2.types import cloud_speech
from amazon_transcribe.client import TranscribeStreamingClient
from amazon_transcribe.handlers import TranscriptResultStreamHandler
from amazon_transcribe.model import TranscriptEvent
import threading
import queue
from dotenv import load_dotenv

load_dotenv()

SAVE_DIR = "received_recordings"
os.makedirs(SAVE_DIR, exist_ok=True)

PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT")
AWS_REGION = os.getenv("AWS_REGION", "ap-northeast-1")

# GCP v1 stream limit: restart every 4.5 minutes (before 5-minute timeout)
GCP_V1_RESTART_INTERVAL = 270  # 4.5 minutes

# GCP v2 stream limit: restart every 4.5 minutes (before 5-minute timeout)  
GCP_V2_RESTART_INTERVAL = 270  # 4.5 minutes

if not PROJECT_ID:
    raise ValueError("GOOGLE_CLOUD_PROJECT environment variable must be set in .env file")

class RecordingSession:
    def __init__(self, session_id, file_ext="raw"):
        self.session_id = session_id
        self.chunks = []
        self.transcripts = {
            "gcp_v1": [],
            "gcp_v2": [],
            "aws": []
        }
        self.total_bytes = 0
        self.start_time = datetime.now()
        self.filepath = os.path.join(SAVE_DIR, f"recording_{session_id}.{file_ext}")
    
    def add_chunk(self, chunk_data: bytes):
        self.chunks.append(chunk_data)
        self.total_bytes += len(chunk_data)
        with open(self.filepath, "ab") as f:
            f.write(chunk_data)
    
    def add_transcript(self, service: str, speaker: str, text: str):
        self.transcripts[service].append({
            "speaker": speaker,
            "text": text,
            "timestamp": datetime.now().isoformat()
        })
    
    def get_stats(self):
        duration = (datetime.now() - self.start_time).total_seconds()
        return {
            "session_id": self.session_id,
            "total_bytes": self.total_bytes,
            "total_mb": round(self.total_bytes / (1024 * 1024), 2),
            "duration_seconds": round(duration, 2),
            "filepath": self.filepath,
            "transcript_counts": {
                "gcp_v1": len(self.transcripts["gcp_v1"]),
                "gcp_v2": len(self.transcripts["gcp_v2"]),
                "aws": len(self.transcripts["aws"])
            }
        }

sessions = {}

# Initialize clients
speech_v1_client = speech_v1.SpeechClient()
speech_v2_client = SpeechClient()

# GCP v2 Recognizer setup
RECOGNIZER_ID = "japanese-streaming-recognizer"
RECOGNIZER_PATH = f"projects/{PROJECT_ID}/locations/global/recognizers/{RECOGNIZER_ID}"

def ensure_gcp_v2_recognizer():
    """Ensure GCP v2 recognizer exists (no diarization - not supported for streaming)."""
    try:
        speech_v2_client.get_recognizer(name=RECOGNIZER_PATH)
        print(f"✅ GCP v2 recognizer exists: {RECOGNIZER_ID}")
    except Exception:
        print(f"🔨 Creating GCP v2 recognizer: {RECOGNIZER_ID}")
        try:
            request = cloud_speech.CreateRecognizerRequest(
                parent=f"projects/{PROJECT_ID}/locations/global",
                recognizer_id=RECOGNIZER_ID,
                recognizer=cloud_speech.Recognizer(
                    language_codes=["ja-JP"],
                    model="long",  # Best for long-form audio
                ),
            )
            operation = speech_v2_client.create_recognizer(request=request)
            operation.result(timeout=300)
            print(f"✅ GCP v2 recognizer created successfully")
        except Exception as e:
            print(f"❌ Failed to create GCP v2 recognizer: {e}")

# ========== GCP V1 STT (With Diarization + Auto-restart) ==========
def start_gcp_v1_thread(audio_q, websocket, loop, sample_rate, session):
    print(f"🎤 [GCP v1] Thread started ({sample_rate}Hz) - Japanese + Diarization")
    print(f"⏰ [GCP v1] Auto-restart every {GCP_V1_RESTART_INTERVAL}s")
    
    def build_v1_config():
        """Best quality config for GCP v1 with diarization"""
        diarization_config = speech_v1.SpeakerDiarizationConfig(
            enable_speaker_diarization=True,
            min_speaker_count=2,
            max_speaker_count=6,
        )
        
        rec_config = speech_v1.RecognitionConfig(
            encoding=speech_v1.RecognitionConfig.AudioEncoding.LINEAR16,
            sample_rate_hertz=sample_rate,
            audio_channel_count=1,
            language_code="ja-JP",
            enable_automatic_punctuation=True,
            diarization_config=diarization_config,
            model="latest_long",  # Best for long-form conversation
            use_enhanced=True,  # Enhanced model for better quality
        )
        
        return speech_v1.StreamingRecognitionConfig(
            config=rec_config,
            interim_results=True,
        )
    
    restart_count = 0
    stop_requested = False
    
    while not stop_requested:
        restart_count += 1
        stream_start_time = time.time()
        print(f"🔄 [GCP v1] Starting stream #{restart_count}")
        
        streaming_config = build_v1_config()
        stream_active = True
        
        def audio_generator():
            """Pull audio with auto-restart timer"""
            while stream_active and not stop_requested:
                # Auto-restart before 5-minute limit
                if time.time() - stream_start_time >= GCP_V1_RESTART_INTERVAL:
                    print(f"⏰ [GCP v1] {GCP_V1_RESTART_INTERVAL}s reached, restarting...")
                    return
                
                try:
                    chunk = audio_q.get(timeout=0.5)
                    if chunk is None:
                        print("🛑 [GCP v1] Stop signal received")
                        return
                    if len(chunk) > 0:
                        yield chunk
                except queue.Empty:
                    continue
        
        try:
            requests = (
                speech_v1.StreamingRecognizeRequest(audio_content=content)
                for content in audio_generator()
            )
            
            responses = speech_v1_client.streaming_recognize(streaming_config, requests)
            
            for response in responses:
                if not response.results:
                    continue
                    
                for result in response.results:
                    if not result.alternatives:
                        continue
                        
                    alt = result.alternatives[0]
                    transcript = alt.transcript or ""
                    is_final = bool(result.is_final)
                    
                    # Extract speaker from words
                    speaker_tag = None
                    if alt.words:
                        speaker_tags = [getattr(w, "speaker_tag", None) for w in alt.words 
                                       if getattr(w, "speaker_tag", None)]
                        if speaker_tags:
                            speaker_tag = Counter(speaker_tags).most_common(1)[0][0]
                    
                    speaker_label = f"Speaker {speaker_tag}" if speaker_tag else "Speaker"
                    
                    if is_final and transcript.strip():
                        session.add_transcript("gcp_v1", speaker_label, transcript)
                    
                    payload = {
                        "type": "transcript",
                        "service": "gcp_v1",
                        "text": transcript,
                        "final": is_final,
                        "speaker": speaker_label,
                    }
                    
                    try:
                        asyncio.run_coroutine_threadsafe(
                            websocket.send(json.dumps(payload)), loop
                        )
                    except Exception:
                        pass
            
            # Stream ended - check if timer or stop signal
            elapsed = time.time() - stream_start_time
            if elapsed >= GCP_V1_RESTART_INTERVAL:
                print(f"✅ [GCP v1] Stream #{restart_count} completed, restarting...")
                continue
            else:
                print("✅ [GCP v1] Stream ended (stop signal)")
                stop_requested = True
            
        except Exception as e:
            error_str = str(e)
            timeout_keywords = ["Audio Timeout", "OUT_OF_RANGE", "exceeds maximum", 
                              "deadline", "DEADLINE_EXCEEDED"]
            
            if any(kw.lower() in error_str.lower() for kw in timeout_keywords):
                print(f"⚠️ [GCP v1] Timeout error, restarting...")
                continue
            else:
                print(f"❌ [GCP v1] Fatal error: {e}")
                stop_requested = True
        
        finally:
            stream_active = False
    
    print(f"🎤 [GCP v1] Thread exiting after {restart_count} stream(s)")


# ========== GCP V2 STT (No Diarization + Auto-restart) ==========
def start_gcp_v2_thread(audio_q, websocket, loop, sample_rate, session):
    print(f"🎤 [GCP v2] Thread started ({sample_rate}Hz) - Japanese only")
    print(f"⏰ [GCP v2] Auto-restart every {GCP_V2_RESTART_INTERVAL}s")
    print(f"ℹ️  [GCP v2] No diarization (not supported for streaming in v2)")
    
    def build_v2_config():
        """Best quality config for GCP v2 (no diarization support for streaming)"""
        recognition_config = cloud_speech.RecognitionConfig(
            explicit_decoding_config=cloud_speech.ExplicitDecodingConfig(
                encoding=cloud_speech.ExplicitDecodingConfig.AudioEncoding.LINEAR16,
                sample_rate_hertz=sample_rate,
                audio_channel_count=1,
            ),
            language_codes=["ja-JP"],
            model="long",  # Best for long-form audio
            features=cloud_speech.RecognitionFeatures(
                enable_automatic_punctuation=True,
                enable_word_time_offsets=True,
            ),
        )
        
        return cloud_speech.StreamingRecognitionConfig(
            config=recognition_config,
            streaming_features=cloud_speech.StreamingRecognitionFeatures(
                interim_results=True,
            ),
        )
    
    restart_count = 0
    stop_requested = False
    
    while not stop_requested:
        restart_count += 1
        stream_start_time = time.time()
        print(f"🔄 [GCP v2] Starting stream #{restart_count}")
        
        streaming_config = build_v2_config()
        stream_active = True
        
        def request_generator():
            """Send config + audio with auto-restart timer"""
            yield cloud_speech.StreamingRecognizeRequest(
                recognizer=RECOGNIZER_PATH,
                streaming_config=streaming_config,
            )
            
            while stream_active and not stop_requested:
                # Auto-restart before 5-minute limit
                if time.time() - stream_start_time >= GCP_V2_RESTART_INTERVAL:
                    print(f"⏰ [GCP v2] {GCP_V2_RESTART_INTERVAL}s reached, restarting...")
                    return
                
                try:
                    chunk = audio_q.get(timeout=0.5)
                    if chunk is None:
                        print("🛑 [GCP v2] Stop signal received")
                        return
                    if len(chunk) > 0:
                        yield cloud_speech.StreamingRecognizeRequest(audio=chunk)
                except queue.Empty:
                    continue
        
        try:
            responses = speech_v2_client.streaming_recognize(requests=request_generator())
            
            for response in responses:
                if not response.results:
                    continue
                    
                for result in response.results:
                    if not result.alternatives:
                        continue
                        
                    alt = result.alternatives[0]
                    transcript = alt.transcript or ""
                    is_final = bool(result.is_final)
                    
                    if is_final and transcript.strip():
                        session.add_transcript("gcp_v2", "Speaker", transcript)
                    
                    payload = {
                        "type": "transcript",
                        "service": "gcp_v2",
                        "text": transcript,
                        "final": is_final,
                        "speaker": "Speaker",  # No diarization
                    }
                    
                    try:
                        asyncio.run_coroutine_threadsafe(
                            websocket.send(json.dumps(payload)), loop
                        )
                    except Exception:
                        pass
            
            # Stream ended - check if timer or stop signal
            elapsed = time.time() - stream_start_time
            if elapsed >= GCP_V2_RESTART_INTERVAL:
                print(f"✅ [GCP v2] Stream #{restart_count} completed, restarting...")
                continue
            else:
                print("✅ [GCP v2] Stream ended (stop signal)")
                stop_requested = True
            
        except Exception as e:
            error_str = str(e)
            timeout_keywords = ["Audio Timeout", "OUT_OF_RANGE", "exceeds maximum",
                              "deadline", "DEADLINE_EXCEEDED"]
            
            if any(kw.lower() in error_str.lower() for kw in timeout_keywords):
                print(f"⚠️ [GCP v2] Timeout error, restarting...")
                continue
            else:
                print(f"❌ [GCP v2] Fatal error: {e}")
                stop_requested = True
        
        finally:
            stream_active = False
    
    print(f"🎤 [GCP v2] Thread exiting after {restart_count} stream(s)")


# ========== AWS TRANSCRIBE (With Diarization, No restart needed) ==========
class AWSStreamHandler(TranscriptResultStreamHandler):
    def __init__(self, output_stream, websocket, loop, session):
        super().__init__(output_stream)
        self.websocket = websocket
        self.loop = loop
        self.session = session

    async def handle_transcript_event(self, event: TranscriptEvent):
        for result in event.transcript.results:
            for alternative in result.alternatives:
                # Extract speaker
                speaker = None
                if alternative.items:
                    for item in alternative.items:
                        if hasattr(item, 'speaker') and item.speaker is not None:
                            speaker = item.speaker
                            break
                
                speaker_label = f"Speaker {int(speaker) + 1}" if speaker is not None else "Speaker"
                transcript = alternative.transcript
                is_final = not result.is_partial
                
                if is_final and transcript.strip():
                    self.session.add_transcript("aws", speaker_label, transcript)
                
                payload = {
                    "type": "transcript",
                    "service": "aws",
                    "text": transcript,
                    "final": is_final,
                    "speaker": speaker_label,
                }
                
                try:
                    asyncio.run_coroutine_threadsafe(
                        self.websocket.send(json.dumps(payload)), 
                        self.loop
                    )
                except Exception:
                    pass

def start_aws_thread(audio_q, websocket, loop, sample_rate, session):
    print(f"🎤 [AWS] Thread started ({sample_rate}Hz) - Japanese + Diarization")
    
    async def run_aws_stream():
        try:
            client = TranscribeStreamingClient(region=AWS_REGION)
            stream = await client.start_stream_transcription(
                language_code="ja-JP",
                media_sample_rate_hz=sample_rate,
                media_encoding="pcm",
                show_speaker_label=True,  # Enable diarization
            )
            
            handler = AWSStreamHandler(stream.output_stream, websocket, loop, session)
            
            async def send_audio():
                while True:
                    try:
                        chunk = audio_q.get(timeout=1.0)
                        if chunk is None:
                            await stream.input_stream.end_stream()
                            break
                        if len(chunk) > 0:
                            await stream.input_stream.send_audio_event(audio_chunk=chunk)
                    except queue.Empty:
                        continue
            
            await asyncio.gather(
                send_audio(),
                handler.handle_events()
            )
            
        except Exception as e:
            print(f"❌ [AWS] Error: {e}")
    
    asyncio.run(run_aws_stream())
    print("🎤 [AWS] Thread exiting")


# ========== WEBSOCKET HANDLER ==========
async def handle_client(websocket):
    session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    session = RecordingSession(session_id)
    sessions[session_id] = session

    audio_queues = {"gcp_v1": None, "gcp_v2": None, "aws": None}
    current_sample_rate = 48000
    recording_active = False
    stt_threads = []

    print(f"\n🟢 Client connected: {session_id}")

    await websocket.send(json.dumps({
        "type": "connected",
        "session_id": session_id,
        "message": "Connected to unified transcription server"
    }))

    loop = asyncio.get_event_loop()

    try:
        async for message in websocket:
            if isinstance(message, (bytes, bytearray)):
                chunk = bytes(message)
                session.add_chunk(chunk)
                
                if not recording_active:
                    recording_active = True
                    
                    # Create queues
                    audio_queues["gcp_v1"] = queue.Queue()
                    audio_queues["gcp_v2"] = queue.Queue()
                    audio_queues["aws"] = queue.Queue()
                    
                    # Start threads
                    t1 = threading.Thread(
                        target=start_gcp_v1_thread,
                        args=(audio_queues["gcp_v1"], websocket, loop, current_sample_rate, session),
                        daemon=True
                    )
                    t2 = threading.Thread(
                        target=start_gcp_v2_thread,
                        args=(audio_queues["gcp_v2"], websocket, loop, current_sample_rate, session),
                        daemon=True
                    )
                    t3 = threading.Thread(
                        target=start_aws_thread,
                        args=(audio_queues["aws"], websocket, loop, current_sample_rate, session),
                        daemon=True
                    )
                    
                    stt_threads = [t1, t2, t3]
                    for t in stt_threads:
                        t.start()
                    
                    print("🎙️ All services started")
                
                # Send audio to all queues
                for q in audio_queues.values():
                    if q:
                        q.put(chunk)
                    
            else:
                try:
                    data = json.loads(message)
                    if data.get("type") == "audio_format":
                        sr = int(data.get("sampleRateHertz", current_sample_rate))
                        current_sample_rate = sr
                        print(f"🎵 Audio format: {sr}Hz")
                        await websocket.send(json.dumps({
                            "type": "audio_format_ack",
                            "sampleRateHertz": sr
                        }))
                    elif data.get("type") == "recording_stopped":
                        print("🛑 Recording stopped")
                        if recording_active:
                            for q in audio_queues.values():
                                if q:
                                    q.put(None)
                            for t in stt_threads:
                                t.join(timeout=5.0)
                        
                        recording_active = False
                        
                        await websocket.send(json.dumps({
                            "type": "recording_stopped_ack",
                            "message": "Recording stopped"
                        }))
                    elif data.get("type") == "recording_complete":
                        stats = session.get_stats()
                        print(f"🎬 Complete: {stats}")
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
        if recording_active:
            for q in audio_queues.values():
                if q:
                    q.put(None)
        for t in stt_threads:
            t.join(timeout=5.0)
        if session_id in sessions:
            del sessions[session_id]


async def main():
    host = "localhost"
    port = 8765
    
    print(f"🚀 Unified Transcription Server Starting...")
    print(f"📡 Listening on ws://{host}:{port}")
    print(f"🌏 Language: Japanese (ja-JP)")
    print(f"")
    print(f"Service Configuration:")
    print(f"  • GCP v1: Diarization ✓, Auto-restart every {GCP_V1_RESTART_INTERVAL}s")
    print(f"  • GCP v2: Diarization ✗ (not supported), Auto-restart every {GCP_V2_RESTART_INTERVAL}s")
    print(f"  • AWS:    Diarization ✓, No restart needed")
    print(f"")
    
    if PROJECT_ID:
        ensure_gcp_v2_recognizer()
    
    async with websockets.serve(handle_client, host, port, max_size=10 * 1024 * 1024):
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\n👋 Server stopped")