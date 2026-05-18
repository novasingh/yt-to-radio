const { EventEmitter } = require('events');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');
const logger = require('../utils/logger');

// Setup execute-permitted local temp directory (kept for compatibility)
const localTmpDir = path.join(__dirname, '../tmp');
if (!fs.existsSync(localTmpDir)) {
    try {
        fs.mkdirSync(localTmpDir, { recursive: true });
    } catch (err) {
        logger.error(`Failed to create local tmp directory: ${err.message}`);
    }
}
process.env.TMPDIR = localTmpDir;
process.env.TEMP = localTmpDir;
process.env.TMP = localTmpDir;

// Set static FFmpeg path natively and automatically (no manual install!)
try {
    ffmpeg.setFfmpegPath(ffmpegPath);
    logger.info(`Locked static FFmpeg path successfully via ffmpeg-static: ${ffmpegPath}`);
} catch (ffmpegErr) {
    logger.error(`Failed to set static FFmpeg path: ${ffmpegErr.message}`);
}

// Helper to search and find the cookies.txt file across multiple locations
function getCookiesPath() {
    const paths = [
        path.join(__dirname, '../cookies.txt'),
        path.join(__dirname, 'cookies.txt'),
        path.join(process.cwd(), 'cookies.txt')
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}

// Helper to extract the 11-character video ID from standard YouTube links
function extractVideoId(url) {
    if (!url) return null;
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

class StreamService extends EventEmitter {
    constructor() {
        super();
        this.currentUrl = null;
        this.isOnline = false;
        this.ffmpegCommand = null;
        this.ffmpegStream = null;
        this.listeners = new Set();
        this.retryTimeout = null;
        this.watchdogInterval = null;
        this.lastChunkTime = Date.now();
        this.shouldRetry = true;
        this.burstBuffer = [];
        this.currentBurstSize = 0;
        this.maxBurstSize = 128 * 1024; // 128KB memory cache for instant playback buffering
        this.streamSessionId = 0;
    }

    startStream(url) {
        if (this.currentUrl === url && this.isOnline) {
            return;
        }

        this.stopStream(false);
        this.streamSessionId++;
        this.currentUrl = url;
        this.shouldRetry = true;
        this._startWatchdog();
        this._launchProcesses();
    }

    _startWatchdog() {
        clearInterval(this.watchdogInterval);
        this.watchdogInterval = setInterval(() => {
            if (this.isOnline && this.ffmpegCommand) {
                const timeSinceLastChunk = Date.now() - this.lastChunkTime;
                if (timeSinceLastChunk > 20000) {
                    logger.error('Watchdog: No audio chunks received for 20s. Restarting stream.');
                    this._handleProcessClose();
                }
            }
        }, 5000);
    }

    _launchProcesses() {
        if (!this.currentUrl) return;

        const sessionId = this.streamSessionId;
        logger.info(`Starting stream extraction for URL: ${this.currentUrl} (session: ${sessionId})`);

        const videoId = extractVideoId(this.currentUrl);
        if (!videoId) {
            logger.error(`Invalid YouTube URL provided: ${this.currentUrl}`);
            this._handleProcessClose();
            return;
        }

        try {
            logger.info('Querying direct URL using pre-packaged youtube-dl-exec (yt-dlp) binary...');
            
            const cookiesPath = getCookiesPath();
            const dlpPath = youtubedl.constants.YOUTUBE_DL_PATH;

            const args = [this.currentUrl, '--get-url', '--format', 'bestaudio/best'];
            if (cookiesPath) {
                args.push('--cookies', cookiesPath);
                logger.info(`Detected cookies.txt at: ${cookiesPath}. Applied session cookies to yt-dlp.`);
            }

            const { execFile } = require('child_process');

            execFile(dlpPath, args, (error, stdout, stderr) => {
                if (sessionId !== this.streamSessionId || !this.shouldRetry) return;

                // Log standard yt-dlp warnings safely to prevent masking
                if (stderr && stderr.trim()) {
                    logger.warn(`yt-dlp stderr output: ${stderr.trim()}`);
                }

                if (error) {
                    logger.error(`yt-dlp execution error: ${error.message}`);
                    this._handleProcessClose();
                    return;
                }

                const directUrl = stdout.trim();
                if (!directUrl) {
                    logger.error('yt-dlp did not return any stream URL.');
                    this._handleProcessClose();
                    return;
                }

                logger.info(`SUCCESS: Extracted direct stream URL: ${directUrl}`);

                // Detect live stream based on index.m3u8 presence or manifest flags
                const isLive = directUrl.includes('index.m3u8') || directUrl.includes('manifest');
                logger.info(`Spawning fluent-ffmpeg transcoder (isLive: ${isLive})...`);

                this._startFfmpegStream(directUrl, sessionId, isLive);
            });

        } catch (err) {
            if (sessionId !== this.streamSessionId) return;
            logger.error(`youtube-dl-exec / yt-dlp launcher error: ${err.message}`);
            this._handleProcessClose();
        }
    }

    _startFfmpegStream(directUrl, sessionId, isLive = false) {
        if (sessionId !== this.streamSessionId || !this.shouldRetry) return;

        // Create fluent-ffmpeg command reading from the direct URL
        const cmd = ffmpeg(directUrl);
        
        // Pacing standard non-live video frames to match real-time audio playback
        if (!isLive) {
            cmd.inputOptions('-re');
        }

        this.ffmpegCommand = cmd
            .audioCodec('libmp3lame')
            .audioBitrate('128k') // High-quality 128kbps MP3 audio for premium listening experience
            .format('mp3')
            .on('start', (commandLine) => {
                logger.info('fluent-ffmpeg process spawned successfully.');
            })
            .on('error', (err) => {
                if (err.message.includes('SIGKILL') || err.message.includes('ffmpeg was killed')) return; // Ignore intentional kills
                logger.warn(`fluent-ffmpeg error: ${err.message}`);
                this._handleProcessClose();
            })
            .on('end', () => {
                logger.info('ffmpeg stream ended naturally');
                this._handleProcessClose();
            });

        // Get the output stream to pipe to listeners
        this.ffmpegStream = this.ffmpegCommand.pipe();

        this.ffmpegStream.on('data', (chunk) => {
            this.lastChunkTime = Date.now();
            
            // Manage burst buffer
            this.burstBuffer.push(chunk);
            this.currentBurstSize += chunk.length;
            while (this.currentBurstSize > this.maxBurstSize) {
                const removed = this.burstBuffer.shift();
                this.currentBurstSize -= removed.length;
            }

            if (!this.isOnline) {
                this.isOnline = true;
                logger.info('Stream is now online and broadcasting via automatic FFmpeg transcoder.');
                this.emit('status-change');
            }

            for (const res of this.listeners) {
                try {
                    res.write(chunk);
                } catch (e) {
                    this.removeListener(res);
                }
            }
        });
    }

    _handleProcessClose() {
        if (!this.shouldRetry) return; // Already stopped or handling manual stop
        
        this.isOnline = false;
        this.emit('status-change');
        this._cleanupProcesses();

        logger.info('Scheduling stream restart in 10 seconds...');
        clearTimeout(this.retryTimeout);
        this.retryTimeout = setTimeout(() => {
            this._launchProcesses();
        }, 10000);
    }

    _cleanupProcesses() {
        if (this.ffmpegCommand) {
            try {
                this.ffmpegCommand.kill('SIGKILL');
            } catch (e) {}
            this.ffmpegCommand = null;
        }
        if (this.ffmpegStream) {
            try {
                this.ffmpegStream.destroy();
            } catch (e) {}
            this.ffmpegStream = null;
        }
        this.burstBuffer = [];
        this.currentBurstSize = 0;
    }

    stopStream(clearUrl = true) {
        logger.info('Stopping stream manually.');
        this.streamSessionId++;
        this.shouldRetry = false;
        clearTimeout(this.retryTimeout);
        this.watchdogInterval = null;
        if (clearUrl) {
            this.currentUrl = null;
        }
        this._cleanupProcesses();
        this.isOnline = false;
        this.emit('status-change');
        
        // End all active listener responses
        for (const res of this.listeners) {
            res.end();
        }
        this.listeners.clear();
    }

    addListener(res) {
        this.listeners.add(res);
        logger.info(`Listener added. Total listeners: ${this.listeners.size}`);
        
        // Send correct content-type header for standard MP3
        res.setHeader('Content-Type', 'audio/mpeg');
        
        // Burst on connect: send the last 128KB immediately so browser buffers instantly
        if (this.burstBuffer.length > 0) {
            const burstData = Buffer.concat(this.burstBuffer);
            try {
                res.write(burstData);
            } catch (e) {
                this.removeListener(res);
            }
        }
        
        // Ensure to remove listener if they disconnect
        res.on('close', () => {
            this.removeListener(res);
        });
    }

    removeListener(res) {
        this.listeners.delete(res);
        logger.info(`Listener removed. Total listeners: ${this.listeners.size}`);
    }

    getStatus() {
        return {
            online: this.isOnline,
            url: this.currentUrl,
            listenerCount: this.listeners.size
        };
    }
}

module.exports = new StreamService();
