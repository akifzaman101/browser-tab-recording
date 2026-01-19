// App.jsx
// 3-panel transcription UI for GCP v1, GCP v2, AWS Transcribe
// FIXED: Flickering with React.memo + Japanese-only detection

import React, { useState, useRef, useEffect, memo } from "react";
import "./App.css";

function App() {
  const [recording, setRecording] = useState(false);
  const [videoURL, setVideoURL] = useState(null);
  const [status, setStatus] = useState("");
  const [duration, setDuration] = useState(0);
  const [recordingSize, setRecordingSize] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const [wsStatus, setWsStatus] = useState("Disconnected");

  // Transcription state for 3 services
  const [transcripts, setTranscripts] = useState({
    gcp_v1: { final: [], interim: "" },
    gcp_v2: { final: [], interim: "" },
    aws: { final: [], interim: "" }
  });

  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const chunksRef = useRef([]);
  const audioContextRef = useRef(null);
  const timerRef = useRef(null);

  const systemAnalyserRef = useRef(null);
  const animationRef = useRef(null);
  const canvasRef = useRef(null);

  const wsRef = useRef(null);

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
            const service = data.service;
            const speaker = data.speaker || "Speaker";
            const text = (data.text || "").trim();
            
            if (data.final) {
              const newLine = {
                id: `${Date.now()}-${Math.random()}`,
                speaker,
                text,
                timestamp: Date.now()
              };
              
              setTranscripts(prev => ({
                ...prev,
                [service]: {
                  final: [...prev[service].final, newLine],
                  interim: ""
                }
              }));
              
              console.log(`✅ FINAL [${service}] ${speaker}: ${text}`);
            } else {
              setTranscripts(prev => ({
                ...prev,
                [service]: {
                  ...prev[service],
                  interim: `${speaker}: ${text}`
                }
              }));
              console.log(`⏳ INTERIM [${service}] ${speaker}: ${text}`);
            }
          } 
          else if (data.type === "recording_stopped_ack") {
            console.log("🛑 Recording stopped acknowledged");
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

      const audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 48000
      });
      audioContextRef.current = audioContext;
      sampleRateRef.current = audioContext.sampleRate;
      console.log(`🎵 AudioContext sample rate: ${audioContext.sampleRate}Hz`);
      
      const destination = audioContext.createMediaStreamDestination();
      const mixingBus = audioContext.createGain();
      mixingBus.gain.value = 1.0;
      mixingBusRef.current = mixingBus;

      // Get screen + system audio ONLY (no microphone)
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
        alert("⚠️ No system audio detected! Please make sure to check 'Share audio' when selecting your screen.");
      }

      mixingBus.connect(destination);

      // Combine video + mixed audio for local recording
      const combinedStream = new MediaStream([
        ...screenStream.getVideoTracks(),
        ...destination.stream.getAudioTracks(),
      ]);
      streamRef.current = combinedStream;

      // Audio visualizer (system audio only)
      if (screenStream.getAudioTracks().length > 0) {
        systemAnalyserRef.current = audioContext.createAnalyser();
        const systemSourceForVis = audioContext.createMediaStreamSource(screenStream);
        systemSourceForVis.connect(systemAnalyserRef.current);
        visualizeAudioLevels();
      }

      // Local video recorder
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

        setStatus("Recording complete - Video ready for download");

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

      // PCM streaming to backend
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

        while (pcmBufferedBytesRef.current >= desiredBytesPerChunkRef.current) {
          const chunk = takeBytesFromBuffer(desiredBytesPerChunkRef.current);
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            try {
              wsRef.current.send(chunk.buffer);
            } catch (err) {
              console.error("❌ Failed to send PCM chunk:", err);
              break;
            }
          }
        }
      };

      setRecording(true);
      setStatus(`Recording... (streaming to all 3 services)`);

      // Reset transcripts
      setTranscripts({
        gcp_v1: { final: [], interim: "" },
        gcp_v2: { final: [], interim: "" },
        aws: { final: [], interim: "" }
      });

      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);

      if (screenStreamRef.current) {
        screenStreamRef.current.getVideoTracks()[0].addEventListener("ended", stopRecording);
      }
    } catch (err) {
      console.error("Recording error:", err);
      setStatus("Error: " + err.message);
    }
  };

  const stopRecording = () => {
    console.log("🛑 Stopping recording...");
    
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
    if (screenStreamRef.current) screenStreamRef.current.getTracks().forEach((t) => t.stop());
    if (audioContextRef.current) audioContextRef.current.close();

    setRecording(false);
    setStatus("Stopped");

    if (timerRef.current) clearInterval(timerRef.current);
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    
    console.log("✅ Recording stopped successfully");
  };

  const downloadVideo = () => {
    if (!videoURL) return;
    
    const a = document.createElement("a");
    a.href = videoURL;
    a.download = `recording_${Date.now()}.webm`;
    a.click();
    
    console.log("✅ Video downloaded");
  };

  const downloadCSV = () => {
    const formatConversation = (serviceData) => {
      return serviceData.final
        .map(line => `${line.speaker}: ${line.text}`)
        .join('\n');
    };

    const gcpV1Text = formatConversation(transcripts.gcp_v1);
    const gcpV2Text = formatConversation(transcripts.gcp_v2);
    const awsText = formatConversation(transcripts.aws);

    const BOM = '\uFEFF';
    const escape = (str) => `"${str.replace(/"/g, '""')}"`;
    
    let csvContent = BOM + "GCP v1,GCP v2,AWS Transcribe\n";
    csvContent += `${escape(gcpV1Text)},${escape(gcpV2Text)},${escape(awsText)}\n`;

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `transcription_comparison_${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    
    console.log("✅ CSV downloaded with full conversations");
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

    const sysAnalyser = systemAnalyserRef.current;
    if (!sysAnalyser) return;
    
    const sysData = new Uint8Array(sysAnalyser.frequencyBinCount);

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);
      sysAnalyser.getByteFrequencyData(sysData);

      const sysAvg = sysData.reduce((a, b) => a + b, 0) / sysData.length;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#f5f5f5";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const sysHeight = (sysAvg / 255) * (canvas.height - 30);
      ctx.fillStyle = "#2196F3";
      ctx.fillRect(150, canvas.height - 25 - sysHeight, 50, sysHeight);

      ctx.fillStyle = "#666";
      ctx.font = "13px system-ui, -apple-system, sans-serif";
      ctx.fillText("System Audio", 125, canvas.height - 8);
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
      <div className="top-section">
        <div className="app-header">
          <h1 className="app-title">Real-time Transcription Comparison</h1>
          <p className="app-subtitle">GCP v1 • GCP v2 • AWS Transcribe (Japanese)</p>
        </div>

        <div className="ws-status">
          <div className={`ws-indicator ${wsConnected ? 'connected' : 'disconnected'}`}></div>
          <span className="ws-status-text">{wsStatus}</span>
        </div>

        <div className="control-row">
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
          
          <button
            onClick={downloadCSV}
            disabled={recording || (
              transcripts.gcp_v1.final.length === 0 &&
              transcripts.gcp_v2.final.length === 0 &&
              transcripts.aws.final.length === 0
            )}
            className="control-btn download"
          >
            Download CSV
          </button>
          
          <button
            onClick={downloadVideo}
            disabled={!videoURL}
            className="control-btn download-video"
          >
            Download Video
          </button>
        </div>

        <div className="visualizer-container">
          <div className="visualizer-label">Audio Levels</div>
          <canvas
            ref={canvasRef}
            width={350}
            height={100}
            className="visualizer-canvas"
          />
        </div>

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
      </div>

      <div className="transcripts-grid">
        <TranscriptPanel 
          service="gcp_v1" 
          title="GCP v1" 
          finalTranscripts={transcripts.gcp_v1.final}
          interimText={transcripts.gcp_v1.interim}
        />
        <TranscriptPanel 
          service="gcp_v2" 
          title="GCP v2" 
          finalTranscripts={transcripts.gcp_v2.final}
          interimText={transcripts.gcp_v2.interim}
        />
        <TranscriptPanel 
          service="aws" 
          title="AWS Transcribe" 
          finalTranscripts={transcripts.aws.final}
          interimText={transcripts.aws.interim}
        />
      </div>
    </div>
  );
}

// FIXED: Memoized component to prevent flickering
const TranscriptLine = memo(({ line }) => (
  <div className="transcript-line final">
    <div className="speaker-info">
      <span className="speaker">{line.speaker}</span>
    </div>
    <span className="text">{line.text}</span>
  </div>
), (prevProps, nextProps) => {
  return prevProps.line.id === nextProps.line.id;
});

const TranscriptPanel = memo(({ service, title, finalTranscripts, interimText }) => {
  const bodyRef = useRef(null);
  const prevCountRef = useRef(0);
  
  useEffect(() => {
    if (finalTranscripts.length > prevCountRef.current && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
      prevCountRef.current = finalTranscripts.length;
    }
  }, [finalTranscripts.length]);
  
  return (
    <div className="transcript-panel">
      <div className="transcript-panel-header">
        <h3 className="transcript-panel-title">{title}</h3>
        <div className="transcript-count">{finalTranscripts.length} lines</div>
      </div>
      
      <div className="transcript-panel-body" ref={bodyRef}>
        {finalTranscripts.map((line) => (
          <TranscriptLine key={line.id} line={line} />
        ))}

        {interimText && (
          <div className="transcript-line interim">
            <span className="text">{interimText}</span>
          </div>
        )}
        
        {finalTranscripts.length === 0 && !interimText && (
          <div className="empty-state">
            <p className="empty-state-text">Waiting for transcription...</p>
          </div>
        )}
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  return prevProps.finalTranscripts === nextProps.finalTranscripts &&
         prevProps.interimText === nextProps.interimText;
});

export default App;