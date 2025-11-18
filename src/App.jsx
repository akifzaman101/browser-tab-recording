// App.jsx
// File upload interface for batch transcription with Chirp 3

import React, { useState, useRef } from "react";
import "./App.css";

function App() {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState("");
  const [transcripts, setTranscripts] = useState([]);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  
  const fileInputRef = useRef(null);

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  };

  const handleFileInput = (e) => {
    if (e.target.files && e.target.files[0]) {
      handleFileSelect(e.target.files[0]);
    }
  };

  const handleFileSelect = (selectedFile) => {
    // Validate file type
    const validTypes = [
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/flac',
      'audio/m4a', 'audio/aac', 'audio/ogg', 'audio/webm',
      'video/mp4', 'video/webm', 'video/quicktime'
    ];
    
    const fileExtension = selectedFile.name.split('.').pop().toLowerCase();
    const validExtensions = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'webm', 'mp4', 'mov'];
    
    if (!validTypes.includes(selectedFile.type) && !validExtensions.includes(fileExtension)) {
      setError("Unsupported file type. Please upload an audio or video file.");
      return;
    }
    
    setFile(selectedFile);
    setError(null);
    setTranscripts([]);
    setSummary(null);
    setStatus(`Selected: ${selectedFile.name} (${formatSize(selectedFile.size)})`);
  };

  const handleUpload = async () => {
    if (!file) {
      setError("Please select a file first");
      return;
    }

    setUploading(true);
    setProcessing(false);
    setError(null);
    setStatus("Uploading file...");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("http://localhost:8000/upload", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || "Upload failed");
      }

      setUploading(false);
      setProcessing(true);
      setStatus("Processing transcription with Chirp 3...");

      const data = await response.json();

      if (data.status === "success") {
        setTranscripts(data.transcripts || []);
        setSummary(data.summary || null);
        setStatus(`✅ Transcription complete! (${data.transcripts.length} segments)`);
        setProcessing(false);
      } else {
        throw new Error("Transcription failed");
      }

    } catch (err) {
      console.error("Upload error:", err);
      setError(err.message || "An error occurred during transcription");
      setStatus("");
      setUploading(false);
      setProcessing(false);
    }
  };

  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  const resetApp = () => {
    setFile(null);
    setTranscripts([]);
    setSummary(null);
    setStatus("");
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <div className="app-page">
      <div className="left-pane">
        <div className="app-content">
          <div className="app-header">
            <h1 className="app-title">Chirp 3 Transcription</h1>
            <p className="app-subtitle">Upload audio/video files for AI-powered transcription with speaker diarization</p>
          </div>

          {/* Upload Area */}
          <div
            className={`upload-area ${dragActive ? 'drag-active' : ''} ${file ? 'has-file' : ''}`}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onClick={() => !uploading && !processing && fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              onChange={handleFileInput}
              accept="audio/*,video/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.webm,.mp4,.mov"
              style={{ display: 'none' }}
              disabled={uploading || processing}
            />
            
            {!file ? (
              <>
                <div className="upload-icon">📁</div>
                <div className="upload-text">
                  <p className="upload-main">Drop your audio/video file here</p>
                  <p className="upload-sub">or click to browse</p>
                </div>
                <div className="upload-formats">
                  Supported: MP3, WAV, FLAC, M4A, MP4, WebM (up to 3 hours)
                </div>
              </>
            ) : (
              <>
                <div className="upload-icon">✅</div>
                <div className="upload-text">
                  <p className="upload-main">{file.name}</p>
                  <p className="upload-sub">{formatSize(file.size)}</p>
                </div>
                {!uploading && !processing && (
                  <button className="change-file-btn" onClick={(e) => {
                    e.stopPropagation();
                    resetApp();
                  }}>
                    Change File
                  </button>
                )}
              </>
            )}
          </div>

          {/* Upload Button */}
          {file && !uploading && !processing && !transcripts.length && (
            <div className="control-section">
              <button
                onClick={handleUpload}
                className="control-btn start"
              >
                Start Transcription
              </button>
            </div>
          )}

          {/* Status Messages */}
          {status && (
            <div className={`status-message ${processing ? 'processing' : ''}`}>
              {(uploading || processing) && (
                <div className="spinner"></div>
              )}
              <span className="status-text">{status}</span>
            </div>
          )}

          {error && (
            <div className="error-message">
              <span className="error-icon">⚠️</span>
              <span className="error-text">{error}</span>
            </div>
          )}

          {/* Progress Info */}
          {(uploading || processing) && (
            <div className="progress-info">
              <div className="progress-steps">
                <div className={`progress-step ${uploading ? 'active' : 'completed'}`}>
                  <div className="step-number">1</div>
                  <div className="step-label">Uploading</div>
                </div>
                <div className="progress-line"></div>
                <div className={`progress-step ${processing ? 'active' : ''}`}>
                  <div className="step-number">2</div>
                  <div className="step-label">Transcribing</div>
                </div>
                <div className="progress-line"></div>
                <div className="progress-step">
                  <div className="step-number">3</div>
                  <div className="step-label">Complete</div>
                </div>
              </div>
              <p className="progress-note">
                {processing && "⏳ This may take several minutes for long files..."}
              </p>
            </div>
          )}

          {/* Summary Section */}
          {transcripts.length > 0 && (
            <div className="summary-section">
              <h3 className="summary-title">📋 Summary</h3>
              <div className="summary-content">
                {summary && summary.summary ? (
                  <pre className="summary-text">{summary.summary}</pre>
                ) : summary && summary.error ? (
                  <div className="empty-summary">
                    <p>⚠️ Summary generation failed: {summary.error}</p>
                  </div>
                ) : (
                  <div className="empty-summary">
                    <p>No summary available.</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* New Transcription Button */}
          {transcripts.length > 0 && (
            <div className="control-section">
              <button
                onClick={resetApp}
                className="control-btn secondary"
              >
                New Transcription
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Right Pane - Transcription */}
      <div className="right-pane">
        <div className="transcript-header">
          <h2 className="transcript-title">Transcription Results</h2>
          {transcripts.length > 0 && (
            <div className="transcript-count">{transcripts.length} segments</div>
          )}
        </div>

        <div className="transcript-body">
          {transcripts.map((line) => (
            <div className="transcript-line" key={line.id}>
              <div className="speaker-info">
                <span className="speaker">{line.speaker}</span>
                {line.language && (
                  <span className="language-tag">{line.language}</span>
                )}
              </div>
              <span className="text">{line.text}</span>
            </div>
          ))}

          {transcripts.length === 0 && (
            <div className="empty-state">
              <p className="empty-state-main">🎤 Upload a file to see transcription results</p>
              <p className="empty-state-sub">
                Chirp 3 will automatically detect speakers and languages
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;