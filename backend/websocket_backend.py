import asyncio
import websockets
import json
from datetime import datetime
import os

# Create a directory to save received chunks (optional)
SAVE_DIR = "received_recordings"
os.makedirs(SAVE_DIR, exist_ok=True)

class RecordingSession:
    def __init__(self, session_id):
        self.session_id = session_id
        self.chunks = []
        self.total_bytes = 0
        self.start_time = datetime.now()
        self.filepath = os.path.join(SAVE_DIR, f"recording_{session_id}.webm")
    
    def add_chunk(self, chunk_data):
        self.chunks.append(chunk_data)
        self.total_bytes += len(chunk_data)
        
        # Optionally write to file immediately (streaming save)
        with open(self.filepath, "ab") as f:
            f.write(chunk_data)
    
    def get_stats(self):
        duration = (datetime.now() - self.start_time).total_seconds()
        return {
            "session_id": self.session_id,
            "chunks_received": len(self.chunks),
            "total_bytes": self.total_bytes,
            "total_mb": round(self.total_bytes / (1024 * 1024), 2),
            "duration_seconds": round(duration, 2),
            "filepath": self.filepath
        }

# Store active sessions
sessions = {}

async def handle_client(websocket):
    session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    session = RecordingSession(session_id)
    sessions[session_id] = session
    
    print(f"\n🟢 New client connected! Session ID: {session_id}")
    print(f"📁 Saving to: {session.filepath}")
    
    try:
        # Send welcome message
        await websocket.send(json.dumps({
            "type": "connected",
            "session_id": session_id,
            "message": "WebSocket connection established"
        }))
        
        async for message in websocket:
            # Check if message is binary (video chunk) or text (metadata)
            if isinstance(message, bytes):
                # Binary data - video chunk
                chunk_size = len(message)
                session.add_chunk(message)
                
                print(f"📦 Chunk #{len(session.chunks)}: {chunk_size} bytes ({chunk_size/1024:.1f} KB)")
                
                # Send acknowledgment
                await websocket.send(json.dumps({
                    "type": "chunk_received",
                    "chunk_number": len(session.chunks),
                    "chunk_size": chunk_size,
                    "total_received": session.total_bytes
                }))
                
            else:
                # Text data - could be metadata or commands
                try:
                    data = json.loads(message)
                    print(f"📨 Received metadata: {data}")
                    
                    if data.get("type") == "recording_complete":
                        stats = session.get_stats()
                        print(f"\n✅ Recording Complete!")
                        print(f"   Total chunks: {stats['chunks_received']}")
                        print(f"   Total size: {stats['total_mb']} MB")
                        print(f"   Duration: {stats['duration_seconds']}s")
                        print(f"   Saved to: {stats['filepath']}")
                        
                        await websocket.send(json.dumps({
                            "type": "recording_saved",
                            "stats": stats
                        }))
                        
                except json.JSONDecodeError:
                    print(f"⚠️ Received non-JSON text: {message[:100]}")
    
    except websockets.exceptions.ConnectionClosed:
        print(f"\n🔴 Client disconnected: {session_id}")
        stats = session.get_stats()
        print(f"   Final stats: {stats['chunks_received']} chunks, {stats['total_mb']} MB")
    
    except Exception as e:
        print(f"❌ Error: {e}")
    
    finally:
        # Cleanup
        if session_id in sessions:
            del sessions[session_id]

async def main():
    # Start WebSocket server
    host = "localhost"
    port = 8765
    
    print(f"🚀 WebSocket Server Starting...")
    print(f"📡 Listening on ws://{host}:{port}")
    print(f"📁 Recordings will be saved to: {os.path.abspath(SAVE_DIR)}")
    print(f"\nWaiting for connections...\n")
    
    async with websockets.serve(handle_client, host, port, max_size=10 * 1024 * 1024):  # 10MB max message size
        await asyncio.Future()  # Run forever

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\n👋 Server stopped by user")