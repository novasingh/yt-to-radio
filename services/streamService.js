const { EventEmitter } = require('events');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');
const cluster = require('cluster');
const logger = require('../utils/logger');
const db = require('./db');

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

// Set FFmpeg path dynamically
try {
    const { execSync } = require('child_process');
    let hasSystemFfmpeg = false;
    if (process.env.FFMPEG_PATH) {
        ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
        if (cluster.isMaster) logger.info(`Using environment FFMPEG_PATH: ${process.env.FFMPEG_PATH}`);
    } else {
        try {
            execSync('ffmpeg -version', { stdio: 'ignore' });
            hasSystemFfmpeg = true;
        } catch (e) { }

        if (hasSystemFfmpeg) {
            if (cluster.isMaster) logger.info('System-wide FFmpeg detected in PATH. Using system FFmpeg.');
        } else {
            if (cluster.isMaster) logger.info(`No system-wide FFmpeg detected. Falling back to local static binary via ffmpeg-static: ${ffmpegPath}`);
            ffmpeg.setFfmpegPath(ffmpegPath);
        }
    }
} catch (ffmpegErr) {
    logger.error(`Failed to configure FFmpeg path: ${ffmpegErr.message}`);
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
        this.listeners = new Set();
        this.streamSessionId = 0;
        this.burstBuffer = [];
        this.currentBurstSize = 0;
        this.maxBurstSize = 128 * 1024; // 128KB memory cache for instant playback buffering

        if (cluster.isMaster) {
            this.ffmpegCommand = null;
            this.ffmpegStream = null;
            this.retryTimeout = null;
            this.watchdogInterval = null;
            this.lastChunkTime = Date.now();
            this.shouldRetry = true;
            this.activeExtractionProcess = null; // Track active extraction child_process
        } else {
            this.cachedStatus = { online: false, url: null, listenerCount: 0 };
            
            // Worker process handles incoming master IPC chunks and status changes
            process.on('message', (msg) => {
                if (msg.type === 'audio-chunk') {
                    const chunk = Buffer.isBuffer(msg.data) ? msg.data : Buffer.from(msg.data);
                    
                    // Manage worker-side burst buffer for fast playbacks with highly efficient O(1) tracking
                    this.burstBuffer.push(chunk);
                    this.currentBurstSize += chunk.length;
                    while (this.currentBurstSize > this.maxBurstSize) {
                        const removed = this.burstBuffer.shift();
                        this.currentBurstSize -= removed.length;
                    }

                    for (const res of this.listeners) {
                        try {
                            const canWrite = res.write(chunk);
                            if (!canWrite) {
                                res.backpressureCount = (res.backpressureCount || 0) + 1;
                                if (res.backpressureCount > 12) {
                                    logger.warn('Disconnecting slow listener due to persistent backpressure saturation.');
                                    res.end();
                                }
                            } else {
                                res.backpressureCount = 0;
                            }
                        } catch (e) {
                            this.removeListener(res);
                        }
                    }
                } else if (msg.type === 'status-change') {
                    this.isOnline = msg.status.online;
                    this.currentUrl = msg.status.url;
                    this.cachedStatus = msg.status;
                    this.emit('status-change');
                }
            });
        }
    }

    startStream(url) {
        if (cluster.isMaster) {
            if (this.currentUrl === url && this.isOnline) {
                return;
            }

            this.stopStream(false);
            this.streamSessionId++;
            this.currentUrl = url;
            this.shouldRetry = true;
            this._startWatchdog();
            this._launchProcesses();

            // Persist the active streaming state in SQLite
            db.run(
                `INSERT OR REPLACE INTO active_stream (id, url, active, updated_at) VALUES (1, ?, 1, datetime('now'))`,
                [url],
                (err) => {
                    if (err) {
                        logger.error(`Failed to save active stream URL to database: ${err.message}`);
                    } else {
                        logger.info(`Successfully saved active stream URL to database: ${url}`);
                    }
                }
            );
        } else {
            process.send({ type: 'start-stream', url });
        }
    }

    _startWatchdog() {
        if (!cluster.isMaster) return;
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
        if (!cluster.isMaster || !this.currentUrl) return;

        const sessionId = this.streamSessionId;
        this.lastChunkTime = Date.now();
        logger.info(`Starting stream extraction for URL: ${this.currentUrl} (session: ${sessionId})`);

        const videoId = extractVideoId(this.currentUrl);
        if (!videoId) {
            logger.error(`Invalid YouTube URL provided: ${this.currentUrl}`);
            this._handleProcessClose();
            return;
        }

        // Kill any active extraction subprocess first
        if (this.activeExtractionProcess) {
            try {
                this.activeExtractionProcess.kill('SIGKILL');
            } catch (e) {}
            this.activeExtractionProcess = null;
        }

        try {
            logger.info('Querying direct URL using pre-packaged youtube-dl-exec (yt-dlp) binary...');

            const cookiesPath = getCookiesPath();
            const dlpPath = youtubedl.constants.YOUTUBE_DL_PATH;

            const args = [
                this.currentUrl, 
                '--get-url', 
                '--format', 'bestaudio/best',
                '--no-playlist',
                '--geo-bypass',
                '--socket-timeout', '15',
                '--ignore-config'
            ];
            if (cookiesPath) {
                args.push('--cookies', cookiesPath);
                logger.info(`Detected cookies.txt at: ${cookiesPath}. Applied session cookies to yt-dlp.`);
            }

            // Dynamically fix execution permissions on Linux/Unix systems if missing (prevent EACCES)
            if (process.platform !== 'win32') {
                try {
                    const stats = fs.statSync(dlpPath);
                    const isExecutable = (stats.mode & fs.constants.S_IXUSR) !== 0;
                    if (!isExecutable) {
                        logger.info(`Setting executable permissions 0755 on yt-dlp binary at: ${dlpPath}`);
                        fs.chmodSync(dlpPath, '0755');
                    }
                } catch (chmodErr) {
                    logger.warn(`Failed to verify or set permissions on yt-dlp binary: ${chmodErr.message}`);
                }
            }

            const { execFile } = require('child_process');

            this.activeExtractionProcess = execFile(dlpPath, args, (error, stdout, stderr) => {
                this.activeExtractionProcess = null; // Clear once finished

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
        if (sessionId !== this.streamSessionId || !this.shouldRetry) {
            logger.info('Aborting process launch: Stream session changed.');
            return;
        }

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
                logger.info(`Spawned fluent-ffmpeg`);
            })
            .on('stderr', (stderrLine) => {
                if (stderrLine.includes('Error') || stderrLine.includes('403') || stderrLine.includes('Server returned') || stderrLine.includes('Invalid')) {
                    logger.warn(`ffmpeg stderr: ${stderrLine.trim()}`);
                }
            })
            .on('error', (err) => {
                if (err.message.includes('SIGKILL') || err.message.includes('ffmpeg was killed')) return;
                logger.warn(`fluent-ffmpeg error: ${err.message}`);
                this._handleProcessClose();
            })
            .on('end', () => {
                logger.info('ffmpeg stream ended naturally');
                this._handleProcessClose();
            });

        this.ffmpegStream = this.ffmpegCommand.pipe();

        this.ffmpegStream.on('data', (chunk) => {
            this.lastChunkTime = Date.now();

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

            // Emit raw chunk so the master process broadcasts it to cluster workers
            this.emit('audio-chunk', chunk);

            for (const res of this.listeners) {
                try {
                    const canWrite = res.write(chunk);
                    if (!canWrite) {
                        res.backpressureCount = (res.backpressureCount || 0) + 1;
                        if (res.backpressureCount > 12) {
                            logger.warn('Disconnecting slow listener due to persistent backpressure saturation.');
                            res.end();
                        }
                    } else {
                        res.backpressureCount = 0;
                    }
                } catch (e) {
                    this.removeListener(res);
                }
            }
        });
    }

    _handleProcessClose() {
        if (!cluster.isMaster || !this.shouldRetry) return;

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
        if (!cluster.isMaster) return;
        if (this.activeExtractionProcess) {
            try {
                this.activeExtractionProcess.kill('SIGKILL');
            } catch (e) {}
            this.activeExtractionProcess = null;
        }
        if (this.ffmpegCommand) {
            try {
                this.ffmpegCommand.kill('SIGKILL');
            } catch (e) { }
            this.ffmpegCommand = null;
        }
        if (this.ffmpegStream) {
            try {
                this.ffmpegStream.destroy();
            } catch (e) { }
            this.ffmpegStream = null;
        }
        this.burstBuffer = [];
        this.currentBurstSize = 0;
    }

    stopStream(clearUrl = true) {
        if (cluster.isMaster) {
            logger.info('Stopping stream manually.');
            this.streamSessionId++;
            this.shouldRetry = false;
            clearTimeout(this.retryTimeout);
            clearInterval(this.watchdogInterval);
            if (clearUrl) {
                this.currentUrl = null;

                // Deactivate the active streaming state in SQLite
                db.run(
                    `INSERT OR REPLACE INTO active_stream (id, url, active, updated_at) VALUES (1, '', 0, datetime('now'))`,
                    [],
                    (err) => {
                        if (err) {
                            logger.error(`Failed to deactivate stream in database: ${err.message}`);
                        } else {
                            logger.info(`Deactivated active stream in database successfully.`);
                        }
                    }
                );
            }
            this._cleanupProcesses();
            this.isOnline = false;
            this.emit('status-change');

            for (const res of this.listeners) {
                try { res.end(); } catch (e) {}
            }
            this.listeners.clear();
        } else {
            process.send({ type: 'stop-stream' });
        }
    }

    addListener(res) {
        this.listeners.add(res);
        logger.info(`Listener added. Total local listeners: ${this.listeners.size}`);
        
        if (cluster.isWorker) {
            process.send({ type: 'listener-update', count: this.listeners.size });
        } else {
            this.emit('status-change');
        }

        if (res.socket) {
            res.socket.setNoDelay(true);
            res.socket.setKeepAlive(true, 15000);
        }
        res.backpressureCount = 0;

        if (!res.headersSent) {
            res.setHeader('Content-Type', 'audio/mpeg');
        }

        const activeBuffer = cluster.isMaster ? this.burstBuffer : (this.burstBuffer || []);
        if (activeBuffer.length > 0) {
            const burstData = Buffer.concat(activeBuffer);
            try {
                res.write(burstData);
            } catch (e) {
                this.removeListener(res);
            }
        }

        res.on('close', () => {
            this.removeListener(res);
        });
    }

    removeListener(res) {
        const deleted = this.listeners.delete(res);
        if (deleted) {
            logger.info(`Listener removed. Total local listeners: ${this.listeners.size}`);
            if (cluster.isWorker) {
                process.send({ type: 'listener-update', count: this.listeners.size });
            } else {
                this.emit('status-change');
            }
        }
    }

    getStatus() {
        if (cluster.isMaster) {
            return {
                online: this.isOnline,
                url: this.currentUrl,
                listenerCount: this.listeners.size
            };
        } else {
            return this.cachedStatus;
        }
    }
}

module.exports = new StreamService();
