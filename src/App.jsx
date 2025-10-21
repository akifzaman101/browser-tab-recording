import React, { useState, useRef, useEffect } from "react";

function App() {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
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

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  const startRecording = async () => {
    if (recording) return; // Prevent double-click

    try {
      setStatus("Requesting permissions...");
      setDuration(0);
      setRecordingSize(0);

      // 🎤 1️⃣ Get microphone audio
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      micStreamRef.current = micStream;
      setStatus("Microphone connected. Now select screen...");

      // 🖥️ 2️⃣ Get screen (with tab/system audio)
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" },
        audio: true,
      });
      screenStreamRef.current = screenStream;
      setStatus("Screen captured. Setting up audio mixing...");

      // 🎧 3️⃣ Create audio context for mixing
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = audioContext;
      const destination = audioContext.createMediaStreamDestination();

      // Connect microphone with stereo split
      const micSource = audioContext.createMediaStreamSource(micStream);
      const splitter = audioContext.createChannelSplitter(2);
      const merger = audioContext.createChannelMerger(2);

      micSource.connect(splitter);
      splitter.connect(merger, 0, 0);
      splitter.connect(merger, 0, 1);
      merger.connect(destination);
      setStatus("Microphone audio connected (stereo)");

      // Connect screen audio (if available)
      if (screenStream.getAudioTracks().length > 0) {
        try {
          const screenSource = audioContext.createMediaStreamSource(screenStream);
          const screenSplitter = audioContext.createChannelSplitter(2);
          const screenMerger = audioContext.createChannelMerger(2);

          screenSource.connect(screenSplitter);
          screenSplitter.connect(screenMerger, 0, 0);
          screenSplitter.connect(screenMerger, 1, 1);
          screenMerger.connect(destination);

          setStatus("Screen audio connected + Microphone mixed (stereo)");
        } catch (e) {
          console.warn("Could not connect screen audio:", e);
          setStatus("Screen connected (audio capture not supported on this browser)");
        }
      } else {
        setStatus("Screen connected (no system audio detected)");
      }

      // 🧩 4️⃣ Combine video track + mixed audio track
      const combinedStream = new MediaStream([
        ...screenStream.getVideoTracks(),
        ...destination.stream.getAudioTracks(),
      ]);
      streamRef.current = combinedStream;

      // 🎞️ 5️⃣ Create MediaRecorder
      const mimeType = getSupportedMimeType();
      if (!mimeType) throw new Error("No supported MIME type found");

      const mediaRecorder = new MediaRecorder(combinedStream, {
        mimeType,
        audioBitsPerSecond: 128000,
        videoBitsPerSecond: 2500000,
      });

      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
          setRecordingSize((prev) => prev + event.data.size);
        }
      };

      mediaRecorder.onstop = () => {
        if (chunksRef.current.length === 0) {
          setStatus("Recording stopped (no data recorded)");
          return;
        }

        const blob = new Blob(chunksRef.current, { type: mimeType });
        const url = URL.createObjectURL(blob);

        // Revoke old URL if exists
        if (videoURL) {
          URL.revokeObjectURL(videoURL);
        }
        setVideoURL(url);
        setStatus("Recording complete! Download started...");

        // Auto-download
        const a = document.createElement("a");
        a.href = url;
        a.download = `recording_${Date.now()}.webm`;
        a.click();

        // ✅ Close audio context
        if (audioContextRef.current && audioContextRef.current.state !== "closed") {
          audioContextRef.current.close();
        }

        // Stop timer
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      };

      mediaRecorder.onerror = (event) => {
        console.error("MediaRecorder error:", event.error);
        setStatus(`Recording error: ${event.error}`);
      };

      // Start recording with 1-second chunks
      mediaRecorder.start(1000);
      setRecording(true);
      setPaused(false);
      setStatus("🔴 Recording in progress...");

      // Start timer
      timerRef.current = setInterval(() => {
        setDuration((prev) => prev + 1);
      }, 1000);

      // ✅ Stop automatically when screen share ends
      screenStream.getVideoTracks()[0].addEventListener("ended", () => {
        setStatus("Screen sharing stopped by user");
        stopRecording();
      });
    } catch (err) {
      console.error("Recording error:", err);
      
      let userMessage = "Failed to start recording";
      if (err.name === "NotAllowedError") {
        userMessage = "Permission denied. Please allow microphone and screen sharing access.";
      } else if (err.name === "NotFoundError") {
        userMessage = "No microphone found. Please connect a microphone.";
      } else if (err.name === "NotReadableError") {
        userMessage = "Could not access media device. It may be in use by another application.";
      } else if (err.message) {
        userMessage = err.message;
      }
      
      setStatus(`Error: ${userMessage}`);
      alert(userMessage);
      
      // Cleanup on error
      cleanupResources();
    }
  };

  const pauseRecording = () => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.pause();
      setPaused(true);
      setStatus("⏸️ Recording paused");
      
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  };

  const resumeRecording = () => {
    if (mediaRecorderRef.current?.state === "paused") {
      mediaRecorderRef.current.resume();
      setPaused(false);
      setStatus("🔴 Recording resumed");
      
      timerRef.current = setInterval(() => {
        setDuration((prev) => prev + 1);
      }, 1000);
    }
  };

  const stopRecording = () => {
    try {
      setStatus("Stopping recording...");

      // 🛑 Stop the MediaRecorder
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }

      setRecording(false);
      setPaused(false);

      // Stop timer
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }

      // Cleanup resources
      cleanupResources();

      setTimeout(() => {
        setStatus("Recording stopped ✅");
      }, 500);
    } catch (err) {
      console.error("Error stopping recording:", err);
      setStatus(`Stop error: ${err.message}`);
      setRecording(false);
      setPaused(false);
    }
  };

  const cleanupResources = () => {
    // 🧹 Stop all media tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }

    // 🧠 Close AudioContext
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
  };

  const getSupportedMimeType = () => {
    const types = [
      "video/mp4;codecs=avc1,mp4a",  // Try MP4 first
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=h264,opus",
      "video/webm",
    ];
    for (let t of types) {
      if (MediaRecorder.isTypeSupported(t)) {
        console.log("Using MIME type:", t);
        return t;
      }
    }
    return null;
  };

  return (
    <div style={{ textAlign: "center", marginTop: 50, fontFamily: "Arial" }}>
      <h1>🎥 Screen + Microphone + System Audio Recorder</h1>

      <div style={{ marginBottom: 20 }}>
        {!recording ? (
          <button
            onClick={startRecording}
            style={{
              background: "#44aa44",
              color: "white",
              padding: "12px 24px",
              fontSize: "16px",
              border: "none",
              borderRadius: "5px",
              cursor: "pointer",
              marginRight: "10px",
            }}
          >
            🔴 Start Recording
          </button>
        ) : (
          <>
            <button
              onClick={paused ? resumeRecording : pauseRecording}
              style={{
                background: "#ff9800",
                color: "white",
                padding: "12px 24px",
                fontSize: "16px",
                border: "none",
                borderRadius: "5px",
                cursor: "pointer",
                marginRight: "10px",
              }}
            >
              {paused ? "▶️ Resume" : "⏸️ Pause"}
            </button>
            <button
              onClick={stopRecording}
              style={{
                background: "#ff4444",
                color: "white",
                padding: "12px 24px",
                fontSize: "16px",
                border: "none",
                borderRadius: "5px",
                cursor: "pointer",
              }}
            >
              ⏹️ Stop Recording
            </button>
          </>
        )}
      </div>

      {recording && (
        <div
          style={{
            display: "inline-block",
            padding: "10px 20px",
            backgroundColor: paused ? "#ffe0b2" : "#ffebee",
            borderRadius: "5px",
            marginBottom: 15,
          }}
        >
          <div style={{ fontSize: "24px", fontWeight: "bold", color: "#d32f2f" }}>
            {formatTime(duration)}
          </div>
          <div style={{ fontSize: "12px", color: "#666", marginTop: 5 }}>
            Size: {formatSize(recordingSize)}
          </div>
        </div>
      )}

      {status && (
        <div
          style={{
            marginTop: 15,
            padding: "10px",
            backgroundColor: "#f0f0f0",
            borderRadius: "5px",
            color: "#333",
            maxWidth: "600px",
            margin: "15px auto",
          }}
        >
          <strong>Status:</strong> {status}
        </div>
      )}

      {videoURL && (
        <div style={{ marginTop: 30 }}>
          <h3>📹 Recorded Preview:</h3>
          <video src={videoURL} controls width="600" style={{ borderRadius: "5px" }} />
          <p style={{ fontSize: "14px", color: "#666" }}>
            Your recording has been downloaded automatically
          </p>
        </div>
      )}

      <div
        style={{
          marginTop: 40,
          padding: "15px",
          backgroundColor: "#fffbcc",
          borderRadius: "5px",
          textAlign: "left",
          maxWidth: "600px",
          margin: "40px auto 0",
        }}
      >
        <h4>📝 Tips for best results:</h4>
        <ul style={{ marginLeft: "20px" }}>
          <li>
            <strong>System Audio:</strong> Works best when you select "Share tab audio" in Chrome
            or Edge
          </li>
          <li>
            <strong>Pause/Resume:</strong> You can pause recording and resume later without losing
            data
          </li>
          <li>
            <strong>Browser Support:</strong> Chrome/Edge have best support for mic + system audio
          </li>
          <li>
            <strong>Permissions:</strong> Allow both microphone and screen/audio when prompted
          </li>
        </ul>
      </div>
    </div>
  );
}

export default App;