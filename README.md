# YouTube Radio Streamer

A complete Node.js internet radio streaming application that captures audio from a YouTube live stream or video and broadcasts it as a continuous online audio stream locally on your PC.

## Requirements

You must have the following installed on your system:
- **Node.js**: (v14 or higher recommended)
- **FFmpeg**: Required for audio transcoding.
- **yt-dlp**: Required for extracting the audio stream from YouTube.

### Installing FFmpeg (Windows)
Using [Winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/):
```powershell
winget install ffmpeg
```
Alternatively, download from the official site and add it to your System PATH.

### Installing yt-dlp (Windows)
Using [Winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/):
```powershell
winget install yt-dlp
```
Alternatively, download `yt-dlp.exe` and add it to your System PATH.

## Setup Instructions

1. Clone or download this project.
2. Open a terminal in the project directory.
3. Install dependencies:
   ```powershell
   npm install
   ```
4. Start the server:
   ```powershell
   npm start
   ```

## Usage
- **Listener Page**: Open `http://localhost:3000` to listen to the radio stream.
- **Admin Dashboard**: Open `http://localhost:3000/login.html` (Default login: `admin` / `admin123`). Here you can set the YouTube URL, start/stop the stream, and manage users.
