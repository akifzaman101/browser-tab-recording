import React, { useState, useRef, useEffect } from "react";

function App() {
  const [recording, setRecording] = useState(false);
  const [videoURL, setVideoURL] = useState(null);
  const [status, setStatus] = useState("");
  const [duration, setDuration] = useState(0);
  const [recordingSize, setRecordingSize] = useState(0);

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

  // cleanup
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, []);

  const startRecording = async () => {
    if (recording) return;

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

      // 🔍 Create analysers for live levels
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
        }
      };

      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const url = URL.createObjectURL(blob);

        if (videoURL) URL.revokeObjectURL(videoURL);
        setVideoURL(url);

        setStatus("Recording complete! Downloading video...");

        // 🟢 Auto-download locally
        const a = document.createElement("a");
        a.href = url;
        a.download = `recording_${Date.now()}.webm`;
        a.click();

        // 🟡 (Optional) Upload to your backend / S3 later
        // const formData = new FormData();
        // formData.append("file", blob, `recording_${Date.now()}.webm`);
        // await fetch("https://your-backend.com/upload/", {
        //   method: "POST",
        //   body: formData,
        // });

        console.log("✅ Recording ready:", url);
      };


      mediaRecorder.start(1000);
      setRecording(true);
      setStatus("🔴 Recording...");

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
    setStatus("✅ Stopped");

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

      console.log(`🎤 Mic: ${micAvg.toFixed(1)} | 💻 System: ${sysAvg.toFixed(1)}`);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#222";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = "#4caf50";
      ctx.fillRect(50, canvas.height - micAvg, 80, micAvg);

      ctx.fillStyle = "#2196f3";
      ctx.fillRect(200, canvas.height - sysAvg, 80, sysAvg);

      ctx.fillStyle = "#fff";
      ctx.font = "14px Arial";
      ctx.fillText("🎤 Mic", 60, canvas.height - 5);
      ctx.fillText("💻 System", 200, canvas.height - 5);
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
    <div style={{ textAlign: "center", marginTop: 50, fontFamily: "Arial" }}>
      <h1>🎥 Screen + Mic + System Audio Recorder (Realtime Logs)</h1>

      {!recording ? (
        <button
          onClick={startRecording}
          style={{
            background: "#4caf50",
            color: "white",
            padding: "12px 24px",
            fontSize: "16px",
            border: "none",
            borderRadius: "5px",
            cursor: "pointer",
          }}
        >
          🔴 Start Recording
        </button>
      ) : (
        <button
          onClick={stopRecording}
          style={{
            background: "#f44336",
            color: "white",
            padding: "12px 24px",
            fontSize: "16px",
            border: "none",
            borderRadius: "5px",
            cursor: "pointer",
          }}
        >
          ⏹️ Stop
        </button>
      )}

      <div style={{ marginTop: 20 }}>
        <canvas
          ref={canvasRef}
          width={350}
          height={100}
          style={{
            background: "#111",
            borderRadius: "8px",
            marginTop: "10px",
          }}
        />
      </div>

      {recording && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: "18px", color: "#333" }}>
            Time: {formatTime(duration)} | Size: {formatSize(recordingSize)}
          </div>
          <div style={{ color: "#2e7d32", marginTop: 5 }}>
            🟢 Streaming chunks (check console)
          </div>
        </div>
      )}

      {videoURL && (
        <div style={{ marginTop: 30 }}>
          <h3>📹 Recorded Preview</h3>
          <video
            src={videoURL}
            controls
            width="600"
            style={{ borderRadius: "5px" }}
          />
        </div>
      )}

      {status && (
        <div
          style={{
            marginTop: 20,
            background: "#f0f0f0",
            borderRadius: "5px",
            padding: "10px",
            display: "inline-block",
          }}
        >
          <strong>Status:</strong> {status}
        </div>
      )}
    </div>
  );
}

export default App;
