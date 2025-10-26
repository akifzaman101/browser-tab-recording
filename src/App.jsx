// App.jsx
// Multi-speaker, multi-language live transcription

import React, { useState, useRef, useEffect } from "react";
import "./App.css";

function App() {
  const [recording, setRecording] = useState(false);
  const [videoURL, setVideoURL] = useState(null);
  const [status, setStatus] = useState("");
  const [duration, setDuration] = useState(0);
  const [recordingSize, setRecordingSize] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const [wsStatus, setWsStatus] = useState("Disconnected");

  // Transcription state
  const [finalLines, setFinalLines] = useState([]);
  const [interimText, setInterimText] = useState("");

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
              setInterimText(`[${language}] ${speaker}: ${(data.text || "").trim()}`);
              console.log(`⏳ INTERIM [${language}] ${speaker}: ${data.text}`);
            }
          }
        } catch (err) {
          // Non-JSON or other message types ignored
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

      // Get microphone
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = micStream;

      // Get screen + system audio
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" },
        audio: true,
      });
      screenStreamRef.current = screenStream;

      // AudioContext setup
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = audioContext;
      sampleRateRef.current = audioContext.sampleRate;
      console.log(`🎵 AudioContext sample rate: ${audioContext.sampleRate}Hz`);
      
      const destination = audioContext.createMediaStreamDestination();

      // Mixing bus for local recording (mic + system)
      const mixingBus = audioContext.createGain();
      mixingBus.gain.value = 1.0;
      mixingBusRef.current = mixingBus;

      const micSource = audioContext.createMediaStreamSource(micStream);
      const micGain = audioContext.createGain();
      micGain.gain.value = 1.0;
      micSource.connect(micGain).connect(mixingBus);

      if (screenStream.getAudioTracks().length > 0) {
        const screenSource = audioContext.createMediaStreamSource(screenStream);
        const screenGain = audioContext.createGain();
        screenGain.gain.value = 1.0;
        screenSource.connect(screenGain).connect(mixingBus);
        console.log("✅ System audio detected and connected");
      } else {
        console.warn("⚠️ No system audio detected");
      }

      // Connect mixing bus to local recorder destination
      mixingBus.connect(destination);

      // Combine video + mixed audio for local recording
      const combinedStream = new MediaStream([
        ...screenStream.getVideoTracks(),
        ...destination.stream.getAudioTracks(),
      ]);
      streamRef.current = combinedStream;

      // Audio visualizers
      micAnalyserRef.current = audioContext.createAnalyser();
      const micSourceForVis = audioContext.createMediaStreamSource(micStream);
      micSourceForVis.connect(micAnalyserRef.current);

      if (screenStream.getAudioTracks().length > 0) {
        systemAnalyserRef.current = audioContext.createAnalyser();
        const systemSourceForVis = audioContext.createMediaStreamSource(screenStream);
        systemSourceForVis.connect(systemAnalyserRef.current);
      }

      visualizeAudioLevels();

      // Local video recorder
      const mimeType = getSupportedMimeType();
      const mediaRecorder = new MediaRecorder(combinedStream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = async (event) => {
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

        setStatus("Recording complete");

        // Auto-download
        const a = document.createElement("a");
        a.href = url;
        a.download = `recording_${Date.now()}.webm`;
        a.click();

        // Notify server
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: "recording_complete",
            timestamp: Date.now(),
            total_size: recordingSize,
            duration: duration
          }));
        }
      };

      // PCM streaming to backend (mixed audio)
      await initPcmWorklet(audioContext);
      const workletNode = new AudioWorkletNode(audioContext, "pcm-encoder");
      workletNodeRef.current = workletNode;

      // Connect mixed audio to worklet for STT
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

        // Log every ~10KB
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

      mediaRecorder.start(1000);
      setRecording(true);
      setStatus(`Recording... (streaming PCM ${sampleRateRef.current}Hz mono)`);

      // Reset transcript
      setFinalLines([]);
      setInterimText("");

      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
      screenStream.getVideoTracks()[0].addEventListener("ended", stopRecording);
    } catch (err) {
      console.error("Recording error:", err);
      setStatus("Error: " + err.message);
    }
  };

  const stopRecording = () => {
    console.log("🛑 Stopping recording...");
    
    // ✅ ADDED: Notify backend that recording is stopping
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
    
    // Stop local recorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }

    // Tear down PCM worklet & buffers
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

    // Stop streams
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (micStreamRef.current) micStreamRef.current.getTracks().forEach((t) => t.stop());
    if (screenStreamRef.current) screenStreamRef.current.getTracks().forEach((t) => t.stop());
    if (audioContextRef.current) audioContextRef.current.close();

    setRecording(false);
    setStatus("Stopped");

    if (timerRef.current) clearInterval(timerRef.current);
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    
    console.log("✅ Recording stopped successfully");
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
            <h1 className="app-title">Screen Recorder</h1>
            <p className="app-subtitle">Record screen with microphone and system audio</p>
          </div>

          <div className="ws-status">
            <div className={`ws-indicator ${wsConnected ? 'connected' : 'disconnected'}`}>
              </div>
            <span className="ws-status-text">{wsStatus}</span>
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

          <div className="visualizer-container">
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
      </div>

      <div className="right-pane">
        <div className="transcript-header">
          <h2>Live Transcription</h2>
          <span className="tiny-note">Google STT • Multi-Speaker • EN/JP</span>
        </div>

        <div className="transcript-body">
          {finalLines.map((line) => (
            <div className="transcript-line" key={line.id}>
              <div className="speaker-info">
                <span className="speaker">{line.speaker}</span>
                {line.language && (
                  <span className="language-badge">{line.language}</span>
                )}
                {line.confidence && (
                  <span className="confidence">{(line.confidence * 100).toFixed(0)}%</span>
                )}
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
              <p>🎤 Start speaking to see live transcription...</p>
              <p className="hint">Supports English and Japanese</p>
              <p className="hint">Detects 2-6 speakers automatically</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;