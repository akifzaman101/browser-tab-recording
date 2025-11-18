// App.jsx
// Multi-speaker, multi-language live transcription with Post-Processing Upload

import React, { useState, useRef, useEffect } from "react";
import "./App.css";

function App() {
  const [recordingMode, setRecordingMode] = useState("online");
  const [recording, setRecording] = useState(false);
  const [videoURL, setVideoURL] = useState(null);
  const [status, setStatus] = useState("");
  const [duration, setDuration] = useState(0);
  const [recordingSize, setRecordingSize] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const [wsStatus, setWsStatus] = useState("Disconnected");
  const [summary, setSummary] = useState(null);

  // Transcription state
  const [finalLines, setFinalLines] = useState([]);
  const [interimText, setInterimText] = useState("");

  // Post-processing state
  const [postProcessingTranscripts, setPostProcessingTranscripts] = useState([]);
  const [postProcessingSummary, setPostProcessingSummary] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const micStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const chunksRef = useRef([]);
  const audioContextRef = useRef(null);
  const timerRef = useRef(null);

  const micAnalyserRef = useRef(null);
  const systemAnalyserRef = useRef(null);
  const animationRef = useRef(null);
  const canvasRef = useRef(null);

  const wsRef = useRef(null);
  const fileInputRef = useRef(null);

  // PCM streaming refs
  const mixingBusRef = useRef(null);
  const workletNodeRef = useRef(null);
  const pcmByteBufferRef = useRef([]);
  const pcmBufferedBytesRef = useRef(0);
  const desiredChunkMs = 20;
  const desiredBytesPerChunkRef = useRef(0);
  const sampleRateRef = useRef(48000);

  useEffect(() => {
    connectWebSocket();

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const connectWebSocket = () => {
    try {
      const ws = new WebSocket("ws://localhost:8765");
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        setWsStatus("Connected");
        console.log(`✅ WebSocket connected`);
        console.log(`🎵 Sending audio format: LINEAR16, ${sampleRateRef.current}Hz, mono`);
        try {
          ws.send(JSON.stringify({
            type: "audio_format",
            encoding: "LINEAR16",
            sampleRateHertz: sampleRateRef.current || 48000,
            channels: 1
          }));
        } catch (err) {
          console.error("Failed to send audio format:", err);
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === "transcript") {
            const speaker = data.speaker || "Speaker";
            const language = data.language_name || data.language || "Unknown";
            const confidence = data.confidence;
            
            if (data.final) {
              const newLine = {
                id: `${Date.now()}-${Math.random()}`,
                speaker,
                text: (data.text || "").trim(),
                language,
                confidence,
                timestamp: data.ts
              };
              setFinalLines(prev => [...prev, newLine]);
              setInterimText("");
              
              console.log(`✅ FINAL [${language}] ${speaker}: ${data.text}`);
              if (confidence) {
                console.log(`   Confidence: ${(confidence * 100).toFixed(1)}%`);
              }
            } else {
              setInterimText(`${speaker}: ${(data.text || "").trim()}`);
              console.log(`⏳ INTERIM [${language}] ${speaker}: ${data.text}`);
            }
          } 
          else if (data.type === "recording_stopped_ack") {
            console.log("🛑 Recording stopped acknowledged");
            if (data.summary) {
              setSummary(data.summary);
              console.log("📋 Real-time Summary received:", data.summary);
            }
          }
          else if (data.type === "post_processing_complete") {
            console.log("✅ Post-processing complete!");
            setIsProcessing(false);
            setPostProcessingTranscripts(data.transcripts || []);
            setPostProcessingSummary(data.summary);
            setStatus("Post-processing complete! Check the Post-Processed Transcription tab.");
          }
          else if (data.type === "post_processing_error") {
            console.error("❌ Post-processing error:", data.error);
            setIsProcessing(false);
            setStatus(`Post-processing error: ${data.error}`);
          }
          else if (data.type === "connected") {
            console.log("✅ Connected to server:", data.message);
          } else if (data.type === "audio_format_ack") {
            console.log("✅ Audio format acknowledged");
          } else if (data.type === "recording_saved") {
            console.log("✅ Recording saved:", data.stats);
          }
        } catch (err) {
          console.error("WebSocket message error:", err);
        }
      };

      ws.onerror = (err) => {
        console.error("WebSocket error:", err);
        setWsStatus("Error");
      };

      ws.onclose = () => {
        console.log("WebSocket closed");
        setWsConnected(false);
        setWsStatus("Disconnected");
      };
    } catch (error) {
      setWsStatus("Failed to connect");
      console.error("WebSocket connection error:", error);
    }
  };

  const startRecording = async () => {
    if (recording) return;

    if (!wsConnected) {
      alert("WebSocket not connected! Please refresh the page.");
      return;
    }

    try {
      setStatus("Requesting permissions...");
      setDuration(0);
      setRecordingSize(0);

      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = audioContext;
      sampleRateRef.current = audioContext.sampleRate;
      console.log(`🎵 AudioContext sample rate: ${audioContext.sampleRate}Hz`);
      
      const destination = audioContext.createMediaStreamDestination();
      const mixingBus = audioContext.createGain();
      mixingBus.gain.value = 1.0;
      mixingBusRef.current = mixingBus;

      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = micStream;

      const micSource = audioContext.createMediaStreamSource(micStream);
      const micGain = audioContext.createGain();
      micGain.gain.value = 1.0;
      micSource.connect(micGain).connect(mixingBus);

      if (recordingMode === "online") {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { cursor: "always" },
          audio: true,
        });
        screenStreamRef.current = screenStream;

        if (screenStream.getAudioTracks().length > 0) {
          const screenSource = audioContext.createMediaStreamSource(screenStream);
          const screenGain = audioContext.createGain();
          screenGain.gain.value = 1.0;
          screenSource.connect(screenGain).connect(mixingBus);
          console.log("✅ System audio detected and connected");
        } else {
          console.warn("⚠️ No system audio detected");
        }

        mixingBus.connect(destination);

        const combinedStream = new MediaStream([
          ...screenStream.getVideoTracks(),
          ...destination.stream.getAudioTracks(),
        ]);
        streamRef.current = combinedStream;

        micAnalyserRef.current = audioContext.createAnalyser();
        const micSourceForVis = audioContext.createMediaStreamSource(micStream);
        micSourceForVis.connect(micAnalyserRef.current);

        if (screenStream.getAudioTracks().length > 0) {
          systemAnalyserRef.current = audioContext.createAnalyser();
          const systemSourceForVis = audioContext.createMediaStreamSource(screenStream);
          systemSourceForVis.connect(systemAnalyserRef.current);
        }

        visualizeAudioLevels();
      } else {
        mixingBus.connect(destination);
        streamRef.current = destination.stream;
      }

      if (recordingMode === "online") {
        const mimeType = getSupportedMimeType();
        const mediaRecorder = new MediaRecorder(streamRef.current, { mimeType });
        mediaRecorderRef.current = mediaRecorder;
        chunksRef.current = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            chunksRef.current.push(event.data);
            setRecordingSize((prev) => prev + event.data.size);
          }
        };

        mediaRecorder.onstop = async () => {
          const blob = new Blob(chunksRef.current, { type: mimeType });
          const url = URL.createObjectURL(blob);

          if (videoURL) URL.revokeObjectURL(videoURL);
          setVideoURL(url);

          setStatus("Recording complete - Starting post-processing...");

          const a = document.createElement("a");
          a.href = url;
          a.download = `recording_${Date.now()}.webm`;
          a.click();

          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: "recording_complete",
              timestamp: Date.now(),
              total_size: recordingSize,
              duration: duration
            }));
          }
        };

        mediaRecorder.start(1000);
      }

      await initPcmWorklet(audioContext);
      const workletNode = new AudioWorkletNode(audioContext, "pcm-encoder");
      workletNodeRef.current = workletNode;

      mixingBus.connect(workletNode);

      const bytesPerSample = 2;
      desiredBytesPerChunkRef.current =
        Math.floor((sampleRateRef.current * desiredChunkMs) / 1000) * bytesPerSample;

      workletNode.port.onmessage = (e) => {
        const buf = e.data;
        if (!(buf instanceof ArrayBuffer)) return;

        const u8 = new Uint8Array(buf);
        pcmByteBufferRef.current.push(u8);
        pcmBufferedBytesRef.current += u8.byteLength;

        if (pcmBufferedBytesRef.current % 10000 < u8.byteLength) {
          console.log(`📤 Buffered ${pcmBufferedBytesRef.current} bytes`);
        }

        while (pcmBufferedBytesRef.current >= desiredBytesPerChunkRef.current) {
          const chunk = takeBytesFromBuffer(desiredBytesPerChunkRef.current);
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            try {
              wsRef.current.send(chunk.buffer);
              console.log(`✅ Sent ${chunk.byteLength} bytes to backend`);
            } catch (err) {
              console.error("❌ Failed to send PCM chunk:", err);
              break;
            }
          }
        }
      };

      setRecording(true);
      setStatus(`Recording... (streaming PCM ${sampleRateRef.current}Hz mono)`);

      setFinalLines([]);
      setInterimText("");

      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);

      if (recordingMode === "online" && screenStreamRef.current) {
        screenStreamRef.current.getVideoTracks()[0].addEventListener("ended", stopRecording);
      }
    } catch (err) {
      console.error("Recording error:", err);
      setStatus("Error: " + err.message);
    }
  };

  const stopRecording = () => {
    console.log("🛑 Stopping recording...");
    
    setIsProcessing(true);
    setStatus("Stopping recording and starting post-processing...");
    
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({
          type: "recording_stopped",
          timestamp: Date.now()
        }));
        console.log("📤 Sent recording_stopped signal to backend");
      } catch (err) {
        console.error("Failed to send stop signal:", err);
      }
    }
    
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }

    try {
      if (mixingBusRef.current && workletNodeRef.current) {
        mixingBusRef.current.disconnect(workletNodeRef.current);
      }
    } catch (err) {
      console.warn("Worklet disconnect error:", err);
    }
    workletNodeRef.current = null;
    pcmByteBufferRef.current = [];
    pcmBufferedBytesRef.current = 0;

    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (micStreamRef.current) micStreamRef.current.getTracks().forEach((t) => t.stop());
    if (screenStreamRef.current) screenStreamRef.current.getTracks().forEach((t) => t.stop());
    if (audioContextRef.current) audioContextRef.current.close();

    setRecording(false);

    if (timerRef.current) clearInterval(timerRef.current);
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    
    console.log("✅ Recording stopped successfully");
  };

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setIsUploading(true);
    setIsProcessing(true);
    setUploadError(null);
    setUploadProgress(0);
    setStatus(`Uploading ${file.name}...`);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const percentComplete = (e.loaded / e.total) * 100;
          setUploadProgress(Math.round(percentComplete));
        }
      });

      xhr.addEventListener('load', () => {
        setIsUploading(false);
        if (xhr.status === 200) {
          const response = JSON.parse(xhr.responseText);
          setPostProcessingTranscripts(response.transcripts || []);
          setPostProcessingSummary(response.summary);
          setIsProcessing(false);
          setStatus("Upload and post-processing complete!");
          console.log("✅ Upload processing complete");
        } else {
          const error = JSON.parse(xhr.responseText);
          setUploadError(error.error || "Upload failed");
          setIsProcessing(false);
          setStatus(`Upload failed: ${error.error}`);
        }
      });

      xhr.addEventListener('error', () => {
        setIsUploading(false);
        setIsProcessing(false);
        setUploadError("Network error during upload");
        setStatus("Network error during upload");
      });

      xhr.open('POST', 'http://localhost:8766/upload');
      xhr.send(formData);
    } catch (error) {
      console.error("Upload error:", error);
      setIsUploading(false);
      setIsProcessing(false);
      setUploadError(error.message);
      setStatus(`Upload error: ${error.message}`);
    }

    event.target.value = '';
  };

  const getSupportedMimeType = () => {
    const types = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  };

  const visualizeAudioLevels = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    const micAnalyser = micAnalyserRef.current;
    const sysAnalyser = systemAnalyserRef.current;
    const micData = new Uint8Array(micAnalyser.frequencyBinCount);
    const sysData = sysAnalyser ? new Uint8Array(sysAnalyser.frequencyBinCount) : null;

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);
      micAnalyser.getByteFrequencyData(micData);
      if (sysAnalyser) sysAnalyser.getByteFrequencyData(sysData);

      const micAvg = micData.reduce((a, b) => a + b, 0) / micData.length;
      const sysAvg = sysData ? sysData.reduce((a, b) => a + b, 0) / sysData.length : 0;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#f5f5f5";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const micHeight = (micAvg / 255) * (canvas.height - 30);
      ctx.fillStyle = "#4CAF50";
      ctx.fillRect(60, canvas.height - 25 - micHeight, 50, micHeight);

      const sysHeight = (sysAvg / 255) * (canvas.height - 30);
      ctx.fillStyle = "#2196F3";
      ctx.fillRect(190, canvas.height - 25 - sysHeight, 50, sysHeight);

      ctx.fillStyle = "#666";
      ctx.font = "13px system-ui, -apple-system, sans-serif";
      ctx.fillText("Microphone", 40, canvas.height - 8);
      ctx.fillText("System Audio", 165, canvas.height - 8);
    };
    draw();
  };

  async function initPcmWorklet(audioContext) {
    const workletCode = `
      class PCMProcessor extends AudioWorkletProcessor {
        process(inputs, outputs, parameters) {
          const input = inputs[0];
          if (!input || input.length === 0) return true;

          const frames = input[0]?.length || 0;
          if (frames === 0) return true;

          const channels = input.length;
          const mono = new Float32Array(frames);

          if (channels === 1) {
            mono.set(input[0]);
          } else {
            for (let i = 0; i < frames; i++) {
              let sum = 0;
              for (let ch = 0; ch < channels; ch++) sum += (input[ch]?.[i] || 0);
              mono[i] = sum / channels;
            }
          }

          const out = new Int16Array(frames);
          for (let i = 0; i < frames; i++) {
            let s = mono[i];
            if (s > 1) s = 1;
            else if (s < -1) s = -1;
            out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }

          this.port.postMessage(out.buffer, [out.buffer]);
          return true;
        }
      }
      registerProcessor('pcm-encoder', PCMProcessor);
    `;
    const blob = new Blob([workletCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await audioContext.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function takeBytesFromBuffer(nBytes) {
    let need = nBytes;
    const out = new Uint8Array(nBytes);
    let offset = 0;
    while (need > 0 && pcmByteBufferRef.current.length > 0) {
      const head = pcmByteBufferRef.current[0];
      if (head.byteLength <= need) {
        out.set(head, offset);
        offset += head.byteLength;
        need -= head.byteLength;
        pcmByteBufferRef.current.shift();
      } else {
        out.set(head.subarray(0, need), offset);
        pcmByteBufferRef.current[0] = head.subarray(need);
        offset += need;
        need = 0;
      }
    }
    pcmBufferedBytesRef.current -= nBytes;
    return out;
  }

  const formatTime = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  return (
    <div className="app-page">
      <div className="left-pane">
        <div className="app-content">
          <div className="app-header">
            <h1 className="app-title">Meeting Recorder</h1>
            <p className="app-subtitle">Record and transcribe with live speech recognition & Chirp 3 post-processing</p>
          </div>

          <div className="ws-status">
            <div className={`ws-indicator ${wsConnected ? 'connected' : 'disconnected'}`}></div>
            <span className="ws-status-text">{wsStatus}</span>
          </div>

          <div className="mode-selector">
            <div className="mode-label">Choose Meeting Type</div>
            <div className="mode-buttons">
              <button
                onClick={() => setRecordingMode("online")}
                disabled={recording || !wsConnected}
                className={`mode-btn online ${recordingMode === "online" ? "selected" : ""}`}
              >
                <div className="mode-btn-icon">🖥️</div>
                <div className="mode-btn-text">
                  <div className="mode-btn-title">Online Meeting</div>
                  <div className="mode-btn-desc">Screen + Audio</div>
                </div>
              </button>
              <button
                onClick={() => setRecordingMode("in-person")}
                disabled={recording || !wsConnected}
                className={`mode-btn in-person ${recordingMode === "in-person" ? "selected" : ""}`}
              >
                <div className="mode-btn-icon">🎤</div>
                <div className="mode-btn-text">
                  <div className="mode-btn-title">In-Person Meeting</div>
                  <div className="mode-btn-desc">Microphone Only</div>
                </div>
              </button>
            </div>
          </div>

          <div className="control-section">
            {!recording ? (
              <button
                onClick={startRecording}
                disabled={!wsConnected}
                className="control-btn start"
              >
                Start Recording
              </button>
            ) : (
              <button
                onClick={stopRecording}
                className="control-btn stop"
              >
                Stop Recording
              </button>
            )}
          </div>

          {/* Upload Section */}
          <div className="upload-section">
            <div className="upload-label">Or Upload Video for Post-Processing</div>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,audio/*"
              onChange={handleFileUpload}
              disabled={isUploading || recording}
              style={{ display: 'none' }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading || recording || !wsConnected}
              className="upload-btn"
            >
              {isUploading ? `Uploading... ${uploadProgress}%` : "📁 Upload Video/Audio"}
            </button>
            {uploadError && (
              <div className="upload-error">❌ {uploadError}</div>
            )}
          </div>

          {recordingMode === "online" && (
            <div className="visualizer-container">
              <div className="visualizer-label">Audio Levels</div>
              <canvas
                ref={canvasRef}
                width={350}
                height={100}
                className="visualizer-canvas"
              />
            </div>
          )}

          {recording && (
            <div className="stats-container">
              <div className="stat-item">
                <div className="stat-label">Duration</div>
                <div className="stat-value">{formatTime(duration)}</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Size</div>
                <div className="stat-value">{formatSize(recordingSize)}</div>
              </div>
            </div>
          )}

          {isProcessing && (
            <div className="processing-indicator">
              <div className="spinner"></div>
              <span>Processing with Google Chirp 3...</span>
            </div>
          )}

          {status && (
            <div className="status-message">
              <span className="status-text">{status}</span>
            </div>
          )}

          {videoURL && (
            <div className="video-preview">
              <h3 className="video-title">Recorded Video</h3>
              <video
                src={videoURL}
                controls
                className="video-player"
              />
            </div>
          )}

          <div className="summary-section">
            <h3 className="summary-title">📋 Real-Time Summary</h3>
            <div className="summary-content">
              {summary && summary.summary ? (
                <pre className="summary-text">{summary.summary}</pre>
              ) : (
                <div className="empty-summary">
                  <p>No summary yet. Stop recording to generate a summary.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="right-pane">
        <div className="tabs-container">
          <div className="tabs">
            <button 
              className="tab active" 
              onClick={(e) => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                e.target.classList.add('active');
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                document.getElementById('realtime-tab').classList.add('active');
              }}
            >
              Real-Time
            </button>
            <button 
              className="tab" 
              onClick={(e) => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                e.target.classList.add('active');
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                document.getElementById('postprocessing-tab').classList.add('active');
              }}
            >
              Post-Processed (Chirp 3)
            </button>
          </div>
        </div>

        {/* Real-Time Transcription Tab */}
        <div id="realtime-tab" className="tab-content active">
          <div className="transcript-header">
            <h2 className="transcript-title">Live Transcription</h2>
          </div>

          <div className="transcript-body">
            {finalLines.map((line) => (
              <div className="transcript-line" key={line.id}>
                <div className="speaker-info">
                  <span className="speaker">{line.speaker}</span>
                  <span className="language-badge">{line.language}</span>
                </div>
                <span className="text">{line.text}</span>
              </div>
            ))}

            {interimText && (
              <div className="transcript-line interim">
                <span className="text">{interimText}</span>
              </div>
            )}
            
            {finalLines.length === 0 && !interimText && (
              <div className="empty-state">
                <p className="empty-state-main">🎤 Start speaking to see live transcription</p>
              </div>
            )}
          </div>
        </div>

        {/* Post-Processing Transcription Tab */}
        <div id="postprocessing-tab" className="tab-content">
          <div className="transcript-header">
            <h2 className="transcript-title">Post-Processed Transcription</h2>
            <p className="transcript-subtitle">Powered by Google Chirp 3</p>
          </div>

          <div className="transcript-body">
            {postProcessingTranscripts.length > 0 ? (
              <>
                {postProcessingTranscripts.map((line, index) => (
                  <div className="transcript-line post-processed" key={index}>
                    <div className="speaker-info">
                      <span className="speaker">{line.speaker}</span>
                      <span className="language-badge">{line.language}</span>
                      {line.confidence && (
                        <span className="confidence-badge">
                          {(line.confidence * 100).toFixed(0)}%
                        </span>
                      )}
                      {line.start_time !== null && line.start_time !== undefined && (
                        <span className="time-badge">
                          {formatTime(Math.floor(line.start_time))}
                        </span>
                      )}
                    </div>
                    <span className="text">{line.text}</span>
                  </div>
                ))}
                
                {postProcessingSummary && (
                  <div className="post-summary-section">
                    <h4 className="post-summary-title">📊 Summary</h4>
                    <div className="post-summary-content">
                      <pre className="summary-text">{postProcessingSummary.summary}</pre>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="empty-state">
                <p className="empty-state-main">🎬 Upload a video or stop recording to see post-processed transcription</p>
                <p className="empty-state-sub">Post-processing uses Google Chirp 3 for enhanced accuracy and speaker diarization</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;