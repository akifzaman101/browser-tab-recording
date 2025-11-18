# post_processing.py
# Module for post-processing audio/video files with Chirp 3 + Speaker Diarization
# Optimized for Asia region (Japan/Bangladesh)

import os
import uuid
import subprocess
from datetime import datetime
from google.cloud import speech_v2
from google.cloud import storage
from google.api_core.client_options import ClientOptions
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv("../.env")

PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT")
REGION = os.getenv("GOOGLE_CLOUD_REGION", "asia-northeast1")  # Tokyo by default
GCS_BUCKET_NAME = os.getenv("GCS_BUCKET_NAME", f"{PROJECT_ID}-transcription-temp")

# Initialize clients with regional endpoint for Chirp 3
speech_client = speech_v2.SpeechClient(
    client_options=ClientOptions(
        api_endpoint=f"{REGION}-speech.googleapis.com",
    )
)
storage_client = storage.Client()
openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def extract_audio_from_video(video_path, output_audio_path):
    """Extract audio from video using FFmpeg and convert to FLAC"""
    try:
        print(f"🎬 Extracting audio from video: {video_path}")
        
        command = [
            'ffmpeg',
            '-i', video_path,
            '-vn',
            '-acodec', 'flac',
            '-ar', '16000',  # 16kHz for better compatibility
            '-ac', '1',
            '-y',
            output_audio_path
        ]
        
        result = subprocess.run(command, capture_output=True, text=True)
        
        if result.returncode != 0:
            raise Exception(f"FFmpeg error: {result.stderr}")
        
        print(f"✅ Audio extracted: {output_audio_path}")
        return output_audio_path
    
    except Exception as e:
        print(f"❌ Audio extraction failed: {e}")
        raise

def convert_raw_to_flac(raw_path, output_audio_path, sample_rate=48000):
    """Convert raw PCM audio to FLAC"""
    try:
        print(f"🎵 Converting RAW to FLAC: {raw_path}")
        
        command = [
            'ffmpeg',
            '-f', 's16le',
            '-ar', str(sample_rate),
            '-ac', '1',
            '-i', raw_path,
            '-acodec', 'flac',
            '-ar', '16000',  # Downsample to 16kHz
            '-y',
            output_audio_path
        ]
        
        result = subprocess.run(command, capture_output=True, text=True)
        
        if result.returncode != 0:
            raise Exception(f"FFmpeg error: {result.stderr}")
        
        print(f"✅ Converted to FLAC: {output_audio_path}")
        return output_audio_path
    
    except Exception as e:
        print(f"❌ Conversion failed: {e}")
        raise

def convert_audio_to_flac(audio_path, output_audio_path):
    """Convert any audio format to FLAC"""
    try:
        print(f"🎵 Converting audio to FLAC: {audio_path}")
        
        command = [
            'ffmpeg',
            '-i', audio_path,
            '-acodec', 'flac',
            '-ar', '16000',
            '-ac', '1',
            '-y',
            output_audio_path
        ]
        
        result = subprocess.run(command, capture_output=True, text=True)
        
        if result.returncode != 0:
            raise Exception(f"FFmpeg error: {result.stderr}")
        
        print(f"✅ Converted to FLAC: {output_audio_path}")
        return output_audio_path
    
    except Exception as e:
        print(f"❌ Conversion failed: {e}")
        raise

def upload_to_gcs(local_path, gcs_filename):
    """Upload file to Google Cloud Storage"""
    try:
        print(f"☁️  Uploading to GCS: {gcs_filename}")
        
        try:
            bucket = storage_client.get_bucket(GCS_BUCKET_NAME)
            print(f"✅ Using existing bucket: {GCS_BUCKET_NAME}")
        except:
            print(f"🪣 Creating bucket: {GCS_BUCKET_NAME} in region {REGION}")
            
            # Determine location based on region
            if REGION.startswith("asia-"):
                location = REGION  # Use specific region like asia-northeast1
            elif REGION in ["us", "eu", "asia"]:
                location = REGION.upper()
            else:
                location = REGION
            
            bucket = storage_client.create_bucket(
                GCS_BUCKET_NAME,
                location=location
            )
            print(f"✅ Created bucket: {GCS_BUCKET_NAME} in {location}")
        
        blob = bucket.blob(gcs_filename)
        blob.upload_from_filename(local_path)
        
        gcs_uri = f"gs://{GCS_BUCKET_NAME}/{gcs_filename}"
        print(f"✅ Uploaded to: {gcs_uri}")
        return gcs_uri
    
    except Exception as e:
        print(f"❌ GCS upload failed: {e}")
        raise

def transcribe_with_chirp3(gcs_uri, language_codes=["en-US", "ja-JP"]):
    """Transcribe audio using Google Chirp 3 model with speaker diarization (Official API)"""
    try:
        print(f"🎤 Starting Chirp 3 transcription with speaker diarization")
        print(f"📍 Region: {REGION}")
        print(f"🔗 GCS URI: {gcs_uri}")
        
        # Configuration exactly as per Google's official documentation
        config = speech_v2.RecognitionConfig(
            auto_decoding_config=speech_v2.AutoDetectDecodingConfig(),
            language_codes=language_codes,  # Or use ["auto"] for auto-detection
            model="chirp_3",
            features=speech_v2.RecognitionFeatures(
                enable_automatic_punctuation=True,
                enable_word_time_offsets=True,
                # Note: Chirp 3 doesn't support enable_word_confidence - removed
                # Enable diarization by setting empty diarization configuration
                diarization_config=speech_v2.SpeakerDiarizationConfig(),
            ),
        )
        
        file_metadata = speech_v2.BatchRecognizeFileMetadata(uri=gcs_uri)
        
        request = speech_v2.BatchRecognizeRequest(
            recognizer=f"projects/{PROJECT_ID}/locations/{REGION}/recognizers/_",
            config=config,
            files=[file_metadata],
            recognition_output_config=speech_v2.RecognitionOutputConfig(
                inline_response_config=speech_v2.InlineOutputConfig(),
            ),
        )
        
        print(f"🔄 Submitting batch recognition request...")
        operation = speech_client.batch_recognize(request=request)
        
        print(f"⏳ Waiting for transcription to complete (this may take several minutes)...")
        response = operation.result(timeout=7200)  # 2 hour timeout
        
        # Debug: Check what we got back
        print(f"🔍 Debug: Response keys: {list(response.results.keys())}")
        if gcs_uri in response.results:
            print(f"🔍 Debug: Transcript results count: {len(response.results[gcs_uri].transcript.results)}")
        else:
            print(f"❌ Error: GCS URI not found in response results")
            print(f"🔍 Available URIs: {list(response.results.keys())}")
            raise Exception(f"GCS URI {gcs_uri} not found in transcription results")
        
        # Parse results with speaker diarization
        transcripts = []
        
        for result in response.results[gcs_uri].transcript.results:
            if not result.alternatives:
                print(f"⚠️  Warning: Result has no alternatives, skipping")
                continue
            
            alternative = result.alternatives[0]
            
            # Debug: Check if we have text
            if not alternative.transcript or not alternative.transcript.strip():
                print(f"⚠️  Warning: Empty transcript in result")
                continue
                
            detected_language = result.language_code if hasattr(result, 'language_code') else "en-US"
            
            print(f"📝 Transcript segment: {alternative.transcript}")
            print(f"🌍 Detected Language: {detected_language}")
            
            # Check if we have words for diarization
            if not hasattr(alternative, 'words') or not alternative.words:
                print(f"⚠️  Warning: No words found for diarization, treating as single speaker")
                transcripts.append({
                    "speaker": "Speaker 1",
                    "text": alternative.transcript,
                    "start_time": 0,
                    "language": detected_language,
                    "confidence": alternative.confidence if hasattr(alternative, 'confidence') else None,
                    "timestamp": datetime.now().isoformat()
                })
                continue
            
            # Group words by speaker
            current_speaker = None
            current_text = []
            start_time = None
            
            for word_info in alternative.words:
                # Extract speaker label from word
                speaker_label = getattr(word_info, 'speaker_label', None)
                speaker_name = f"Speaker {speaker_label}" if speaker_label else "Unknown Speaker"
                
                if current_speaker is None:
                    current_speaker = speaker_name
                    start_time = word_info.start_offset.total_seconds() if hasattr(word_info, 'start_offset') else None
                
                # New speaker detected
                if speaker_label and speaker_name != current_speaker:
                    if current_text:
                        transcripts.append({
                            "speaker": current_speaker,
                            "text": " ".join(current_text),
                            "start_time": start_time,
                            "language": detected_language,
                            "confidence": alternative.confidence if hasattr(alternative, 'confidence') else None,
                            "timestamp": datetime.now().isoformat()
                        })
                    current_speaker = speaker_name
                    current_text = []
                    start_time = word_info.start_offset.total_seconds() if hasattr(word_info, 'start_offset') else None
                
                current_text.append(word_info.word)
            
            # Save last segment
            if current_text:
                transcripts.append({
                    "speaker": current_speaker,
                    "text": " ".join(current_text),
                    "start_time": start_time,
                    "language": detected_language,
                    "confidence": alternative.confidence if hasattr(alternative, 'confidence') else None,
                    "timestamp": datetime.now().isoformat()
                })
        
        print(f"✅ Transcription complete: {len(transcripts)} segments")
        return transcripts
    
    except Exception as e:
        print(f"❌ Transcription failed: {e}")
        raise

def generate_summary(transcripts):
    """Generate summary from transcripts using OpenAI"""
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

def cleanup_gcs_file(gcs_uri):
    """Delete file from GCS"""
    try:
        bucket_name = gcs_uri.split('/')[2]
        blob_name = '/'.join(gcs_uri.split('/')[3:])
        
        bucket = storage_client.bucket(bucket_name)
        blob = bucket.blob(blob_name)
        blob.delete()
        
        print(f"✅ Cleaned up GCS file: {gcs_uri}")
    except Exception as e:
        print(f"⚠️  GCS cleanup warning: {e}")

def process_file(file_path, filename, is_raw=False, sample_rate=48000):
    """
    Main function to process any audio/video file
    Returns: (transcripts, summary, error)
    """
    job_id = str(uuid.uuid4())
    audio_path = None
    gcs_uri = None
    
    try:
        print(f"\n{'='*60}")
        print(f"🚀 Starting post-processing job: {job_id}")
        print(f"📁 File: {filename}")
        print(f"📍 Region: {REGION}")
        print(f"{'='*60}\n")
        
        # Step 1: Convert to FLAC
        import tempfile
        temp_dir = tempfile.gettempdir()
        temp_flac = os.path.join(temp_dir, f"{job_id}.flac")
        
        if is_raw:
            audio_path = convert_raw_to_flac(file_path, temp_flac, sample_rate)
        elif filename.lower().endswith(('.mp4', '.webm', '.mov', '.avi', '.mkv')):
            audio_path = extract_audio_from_video(file_path, temp_flac)
        else:
            audio_path = convert_audio_to_flac(file_path, temp_flac)
        
        # Step 2: Upload to GCS
        gcs_filename = f"transcription-jobs/{job_id}.flac"
        gcs_uri = upload_to_gcs(audio_path, gcs_filename)
        
        # Step 3: Transcribe with Chirp 3
        transcripts = transcribe_with_chirp3(gcs_uri)
        
        # Step 4: Generate summary
        print(f"🤖 Generating summary...")
        summary = generate_summary(transcripts)
        
        # Step 5: Cleanup
        print(f"🧹 Cleaning up temporary files...")
        try:
            if os.path.exists(temp_flac):
                os.remove(temp_flac)
            # cleanup_gcs_file(gcs_uri)  # DISABLED: Files kept in GCS for viewing
            print(f"💾 File saved in GCS: {gcs_uri}")
            print(f"🌐 View at: https://console.cloud.google.com/storage/browser/{GCS_BUCKET_NAME}/transcription-jobs")
        except Exception as cleanup_error:
            print(f"⚠️  Cleanup warning: {cleanup_error}")
        
        print(f"\n{'='*60}")
        print(f"✅ Post-processing complete!")
        print(f"📊 Transcripts: {len(transcripts)} segments")
        print(f"{'='*60}\n")
        
        return transcripts, summary, None
    
    except Exception as e:
        error_msg = str(e)
        print(f"\n{'='*60}")
        print(f"❌ Post-processing failed: {error_msg}")
        print(f"{'='*60}\n")
        
        # Cleanup on error
        try:
            if audio_path and os.path.exists(audio_path):
                os.remove(audio_path)
            if gcs_uri:
                cleanup_gcs_file(gcs_uri)
        except:
            pass
        
        return None, None, error_msg