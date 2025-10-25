import React, { useState, useRef, useEffect } from "react";
import './App.css';

function App() {
  const [recording, setRecording] = useState(false);
  const [videoURL, setVideoURL] = useState(null);
  const [status, setStatus] = useState("");
  const [duration, setDuration] = useState(0);
  const [recordingSize, setRecordingSize] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const [wsStatus, setWsStatus] = useState("Disconnected");

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

  // WebSocket ref
  const wsRef = useRef(null);

  // cleanup
  useEffect(() => {
    // Connect to WebSocket on mount
    connectWebSocket();

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const connectWebSocket = () => {
    try {
      const ws = new WebSocket("ws://localhost:8765");
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("✅ WebSocket Connected");
        setWsConnected(true);
        setWsStatus("Connected");
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log("📨 Server response:", data);

          if (data.type === "connected") {
            console.log("Session ID:", data.session_id);
          } else if (data.type === "chunk_received") {
            console.log(`✅ Chunk ${data.chunk_number} confirmed by server`);
          } else if (data.type === "recording_saved") {
            console.log("📁 Server saved recording:", data.stats);
          }
        } catch (e) {
          console.log("Server message:", event.data);
          console.error("Failed to parse server message:", e);
        }
      };

      ws.onerror = (error) => {
        console.error("❌ WebSocket Error:", error);
        setWsStatus("Error");
      };

      ws.onclose = () => {
        console.log("🔴 WebSocket Disconnected");
        setWsConnected(false);
        setWsStatus("Disconnected");
      };
    } catch (error) {
      console.error("Failed to connect WebSocket:", error);
      setWsStatus("Failed to connect");
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

      // 🎤 Mic
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = micStream;

      // 💻 Screen
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" },
        audio: true,
      });
      screenStreamRef.current = screenStream;

      // 🎧 AudioContext setup
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = audioContext;
      const destination = audioContext.createMediaStreamDestination();

      // 🎚️ Mix mic and screen audio
      const micSource = audioContext.createMediaStreamSource(micStream);
      const micGain = audioContext.createGain();
      micGain.gain.value = 1.0;
      micSource.connect(micGain);
      micGain.connect(destination);

      if (screenStream.getAudioTracks().length > 0) {
        const screenSource = audioContext.createMediaStreamSource(screenStream);
        const screenGain = audioContext.createGain();
        screenGain.gain.value = 1.0;
        screenSource.connect(screenGain);
        screenGain.connect(destination);
      } else {
        console.warn("No system audio detected");
      }

      // 🎞️ Combine video + mixed audio
      const combinedStream = new MediaStream([
        ...screenStream.getVideoTracks(),
        ...destination.stream.getAudioTracks(),
      ]);
      streamRef.current = combinedStream;

      // 📊 Create analysers for live levels
      micAnalyserRef.current = audioContext.createAnalyser();
      const micSourceForVis = audioContext.createMediaStreamSource(micStream);
      micSourceForVis.connect(micAnalyserRef.current);

      if (screenStream.getAudioTracks().length > 0) {
        systemAnalyserRef.current = audioContext.createAnalyser();
        const systemSourceForVis = audioContext.createMediaStreamSource(screenStream);
        systemSourceForVis.connect(systemAnalyserRef.current);
      }

      visualizeAudioLevels();

      // 🎬 Recorder setup
      const mimeType = getSupportedMimeType();
      const mediaRecorder = new MediaRecorder(combinedStream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
          setRecordingSize((prev) => prev + event.data.size);

          const arrayBuffer = await event.data.arrayBuffer();
          console.log(`📦 Chunk: ${arrayBuffer.byteLength} bytes`);

          // 🚀 Send chunk to WebSocket server
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            try {
              wsRef.current.send(arrayBuffer);
              console.log(`✅ Sent ${arrayBuffer.byteLength} bytes to server`);
            } catch (error) {
              console.error("❌ Failed to send chunk:", error);
            }
          } else {
            console.warn("⚠️ WebSocket not ready, chunk not sent");
          }
        }
      };

      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const url = URL.createObjectURL(blob);

        if (videoURL) URL.revokeObjectURL(videoURL);
        setVideoURL(url);

        setStatus("Recording complete");

        // 🟢 Auto-download locally
        const a = document.createElement("a");
        a.href = url;
        a.download = `recording_${Date.now()}.webm`;
        a.click();

        // 📤 Notify server that recording is complete
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: "recording_complete",
            timestamp: Date.now(),
            total_size: recordingSize,
            duration: duration
          }));
        }

        console.log("✅ Recording ready:", url);
      };

      mediaRecorder.start(1000);
      setRecording(true);
      setStatus("Recording...");

      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);

      screenStream.getVideoTracks()[0].addEventListener("ended", stopRecording);
    } catch (err) {
      console.error(err);
      setStatus("Error: " + err.message);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (micStreamRef.current) micStreamRef.current.getTracks().forEach((t) => t.stop());
    if (screenStreamRef.current) screenStreamRef.current.getTracks().forEach((t) => t.stop());
    if (audioContextRef.current) audioContextRef.current.close();

    setRecording(false);
    setStatus("Stopped");

    if (timerRef.current) clearInterval(timerRef.current);
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
  };

  const getSupportedMimeType = () => {
    const types = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  };

  // 🟢 visualize mic/system levels
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

      // Mic bar
      const micHeight = (micAvg / 255) * (canvas.height - 30);
      ctx.fillStyle = "#4CAF50";
      ctx.fillRect(60, canvas.height - 25 - micHeight, 50, micHeight);

      // System bar
      const sysHeight = (sysAvg / 255) * (canvas.height - 30);
      ctx.fillStyle = "#2196F3";
      ctx.fillRect(190, canvas.height - 25 - sysHeight, 50, sysHeight);

      // Labels
      ctx.fillStyle = "#666";
      ctx.font = "13px system-ui, -apple-system, sans-serif";
      ctx.fillText("Microphone", 40, canvas.height - 8);
      ctx.fillText("System Audio", 165, canvas.height - 8);
    };
    draw();
  };

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
    <div className="app-container">
      <div className="app-content">
        
        {/* Header */}
        <div className="app-header">
          <h1 className="app-title">Screen Recorder</h1>
          <p className="app-subtitle">Record screen with microphone and system audio</p>
        </div>

        {/* WebSocket Status */}
        <div className="ws-status">
          <div className={`ws-indicator ${wsConnected ? 'connected' : 'disconnected'}`}></div>
          <span className="ws-status-text">{wsStatus}</span>
        </div>

        {/* Control Button */}
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

        {/* Audio Visualizer */}
        <div className="visualizer-container">
          <canvas
            ref={canvasRef}
            width={350}
            height={100}
            className="visualizer-canvas"
          />
        </div>

        {/* Recording Stats */}
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

        {/* Status Message */}
        {status && (
          <div className="status-message">
            <span className="status-text">{status}</span>
          </div>
        )}

        {/* Video Preview */}
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
  );
}

export default App;