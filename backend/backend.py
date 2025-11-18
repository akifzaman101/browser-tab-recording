import os
import time
import uuid
from typing import List, Dict, Any

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google.cloud.speech_v2 import SpeechClient
from google.cloud.speech_v2.types import cloud_speech
from google.api_core.client_options import ClientOptions
from google.cloud import storage
from dotenv import load_dotenv

# Load local .env (dev convenience). This will not override existing environment variables.
load_dotenv("../.env")

PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT")
REGION = os.getenv("GOOGLE_CLOUD_REGION", "us")
GCS_BUCKET = os.getenv("GCS_BUCKET")


def transcribe_batch_chirp3(audio_uri: str, timeout: int = 300) -> List[Dict[str, Any]]:
    """Transcribes an audio file from a Google Cloud Storage URI using the Chirp 3 model.

    Returns a list of segments with speaker labels, start/end times, language and text.
    """

    client = SpeechClient(client_options=ClientOptions(api_endpoint=f"{REGION}-speech.googleapis.com"))

    config = cloud_speech.RecognitionConfig(
        auto_decoding_config=cloud_speech.AutoDetectDecodingConfig(),
        language_codes=["en-US"],
        model="chirp_3",
        features=cloud_speech.RecognitionFeatures(
            diarization_config=cloud_speech.SpeakerDiarizationConfig(),
        ),
    )

    file_metadata = cloud_speech.BatchRecognizeFileMetadata(uri=audio_uri)

    request = cloud_speech.BatchRecognizeRequest(
        recognizer=f"projects/{PROJECT_ID}/locations/{REGION}/recognizers/_",
        config=config,
        files=[file_metadata],
        recognition_output_config=cloud_speech.RecognitionOutputConfig(
            inline_response_config=cloud_speech.InlineOutputConfig(),
        ),
    )

    operation = client.batch_recognize(request=request)
    print("Waiting for transcription job to complete...")
    response = operation.result(timeout=timeout)

    segments: List[Dict[str, Any]] = []

    # response.results is a mapping keyed by file uri (the key may be the uri)
    for key, file_result in response.results.items():
        transcript = getattr(file_result, "transcript", None)
        if not transcript:
            continue

        for res in transcript.results:
            # choose the first alternative (highest confidence)
            alt = res.alternatives[0] if res.alternatives else None
            if not alt:
                continue

            text = getattr(alt, "transcript", "")
            language = getattr(res, "language_code", None) or getattr(alt, "language", None) or "unknown"

            # If word-level info exists, group by speaker_tag where available
            if getattr(alt, "words", None):
                for w in alt.words:
                    speaker_tag = getattr(w, "speaker_tag", None) or getattr(w, "speakerTag", None)
                    start = getattr(w, "start_time", None)
                    end = getattr(w, "end_time", None)
                    word_text = getattr(w, "word", None) or getattr(w, "text", None)
                    segments.append({
                        "speaker": f"Speaker {speaker_tag}" if speaker_tag else None,
                        "start_time": str(start) if start is not None else None,
                        "end_time": str(end) if end is not None else None,
                        "text": word_text,
                        "language": language,
                    })
            else:
                # Fall back to whole alternative text for this result
                segments.append({
                    "speaker": None,
                    "start_time": None,
                    "end_time": None,
                    "text": text,
                    "language": language,
                })

    return segments


def upload_file_to_gcs(local_path: str, destination_blob_name: str) -> str:
    """Uploads a local file to GCS and returns the gs:// URI."""
    if not GCS_BUCKET:
        raise RuntimeError("GCS_BUCKET environment variable is not set. Set GCS_BUCKET or GCS_BUCKET_NAME, or add it to backend/.env")

    client = storage.Client()
    bucket = client.bucket(GCS_BUCKET)
    blob = bucket.blob(destination_blob_name)
    blob.upload_from_filename(local_path)
    return f"gs://{GCS_BUCKET}/{destination_blob_name}"


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    """Accepts a file upload, stores it to GCS, runs Chirp 3 batch transcription and returns JSON results.
    The frontend expects `{ status: 'success', transcripts: [], summary: {} }`.
    """
    # Save uploaded file locally first
    save_dir = os.path.join(os.path.dirname(__file__), "received_recordings")
    os.makedirs(save_dir, exist_ok=True)

    filename = f"upload_{int(time.time())}_{uuid.uuid4().hex}.{file.filename.split('.')[-1]}"
    local_path = os.path.join(save_dir, filename)

    try:
        with open(local_path, "wb") as f:
            content = await file.read()
            f.write(content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save uploaded file: {e}")

    # Upload to GCS
    try:
        gcs_uri = upload_file_to_gcs(local_path, filename)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to upload to GCS: {e}")

    # Run transcription
    try:
        segments = transcribe_batch_chirp3(gcs_uri)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")

    # Convert segments to simple transcript lines (group contiguous words by speaker if possible)
    transcripts = []
    # If the segments are word-level, group by speaker and join words
    if segments and any(s.get("start_time") for s in segments):
        current = None
        for s in segments:
            speaker = s.get("speaker") or "Speaker"
            if current is None or current["speaker"] != speaker:
                if current:
                    transcripts.append(current)
                current = {"id": len(transcripts) + 1, "speaker": speaker, "text": s.get("text", ""), "language": s.get("language")}
            else:
                current["text"] += " " + (s.get("text") or "")
        if current:
            transcripts.append(current)
    else:
        # already chunked by result
        for i, s in enumerate(segments):
            transcripts.append({"id": i + 1, "speaker": s.get("speaker") or "Speaker", "text": s.get("text"), "language": s.get("language")})

    return {"status": "success", "transcripts": transcripts, "summary": None}


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)