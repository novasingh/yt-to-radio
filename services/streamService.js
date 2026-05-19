const { EventEmitter } = require('events');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');
const cluster = require('cluster');
const logger = require('../utils/logger');
const db = require('./db');

// Tell fluent-ffmpeg to use the locally installed static binary, unless a system ffmpeg is available
try {
    const { execSync } = require('child_process');
    let hasSystemFfmpeg = false;
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        hasSystemFfmpeg = true;
    } catch (e) { }

    if (hasSystemFfmpeg) {
        if (cluster.isMaster) logger.info('System-wide FFmpeg detected in PATH. Using system FFmpeg.');
    } else {
        if (cluster.isMaster) logger.info(`No system-wide FFmpeg detected. Falling back to local static binary: ${ffmpegInstaller.path}`);
        ffmpeg.setFfmpegPath(ffmpegInstaller.path);
    }
} catch (ffmpegErr) {
    logger.error(`Failed to configure FFmpeg path: ${ffmpegErr.message}`);
}

class StreamService extends EventEmitter {
    constructor() {
        super();
        this.currentUrl = null;
        this.customTitle = null;
        this.currentTitle = 'Live Radio Stream';
        this.isOnline = false;
        this.listeners = new Set();
        this.streamSessionId = 0;
        this.burstBuffer = [];
        this.currentBurstSize = 0;

        if (cluster.isMaster) {
            this.ffmpegCommand = null;
            this.ffmpegStream = null;
            this.retryTimeout = null;
            this.watchdogInterval = null;
            this.lastChunkTime = Date.now();
            this.shouldRetry = true;
            this.maxBurstSize = 64 * 1024; // 64KB memory cache for instant playback
            this.activeExtractionController = null; // Track active extraction AbortController
        } else {
            this.cachedStatus = { online: false, url: null, listenerCount: 0 };
            
            // Worker process handles incoming master IPC chunks and status changes
            process.on('message', (msg) => {
                if (msg.type === 'audio-chunk') {
                    const chunk = Buffer.isBuffer(msg.data) ? msg.data : Buffer.from(msg.data);
                    
                    // Manage worker-side burst buffer for fast playbacks with highly efficient O(1) tracking
                    this.burstBuffer.push(chunk);
                    this.currentBurstSize += chunk.length;
                    while (this.currentBurstSize > 64 * 1024) {
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
                    this.currentTitle = msg.status.title;
                    this.cachedStatus = msg.status;
                    this.emit('status-change');
                }
            });
        }
    }

    startStream(url, customTitle) {
        if (cluster.isMaster) {
            if (this.currentUrl === url && this.isOnline) {
                return;
            }

            this.stopStream(false);
            this.streamSessionId++;
            this.currentUrl = url;
            this.customTitle = customTitle || null;
            this.shouldRetry = true;
            this._startWatchdog();
            this._launchProcesses();

            // Persist the active streaming state in SQLite
            db.run(
                `INSERT OR REPLACE INTO active_stream (id, url, custom_title, active, updated_at) VALUES (1, ?, ?, 1, datetime('now'))`,
                [url, this.customTitle],
                (err) => {
                    if (err) {
                        logger.error(`Failed to save active stream URL to database: ${err.message}`);
                    } else {
                        logger.info(`Successfully saved active stream URL to database: ${url}`);
                    }
                }
            );
        } else {
            process.send({ type: 'start-stream', url, customTitle });
        }
    }

    _startWatchdog() {
        if (!cluster.isMaster) return;
        clearInterval(this.watchdogInterval);
        this.watchdogInterval = setInterval(() => {
            if (this.ffmpegCommand) {
                const timeSinceLastChunk = Date.now() - this.lastChunkTime;
                if (timeSinceLastChunk > 20000) {
                    logger.error('Watchdog: Stream stalled or no audio chunks received for 20s. Restarting stream.');
                    this._handleProcessClose();
                }
            }
        }, 5000);
    }

    async _launchProcesses() {
        if (!cluster.isMaster || !this.currentUrl) return;

        const sessionId = this.streamSessionId;
        this.lastChunkTime = Date.now();
        logger.info(`Starting stream extraction for URL: ${this.currentUrl} (session: ${sessionId})`);

        // Abort any active extraction first to clean up orphaned yt-dlp tasks
        if (this.activeExtractionController) {
            try {
                this.activeExtractionController.abort();
            } catch (e) {}
            this.activeExtractionController = null;
        }

        const controller = new AbortController();
        this.activeExtractionController = controller;

        const ytDlpOptions = {
            f: 'bestaudio/best',
            getUrl: true,
            noPlaylist: true,
            geoBypass: true,
            socketTimeout: 15,
            ignoreConfig: true,
            jsRuntimes: 'node'
        };

        const cookiesPath = process.env.COOKIES_PATH || path.join(__dirname, '../cookies.txt');
        if (fs.existsSync(cookiesPath)) {
            ytDlpOptions.cookies = cookiesPath;
            logger.info('Detected cookies.txt file in project root. Applying cookies with Node JS runtime support to yt-dlp.');
        }

        let directUrl;
        try {
            // Concurrently fetch stream title and direct audio stream URL in parallel for zero latency overhead
            const titlePromise = this.customTitle
                ? Promise.resolve(this.customTitle)
                : youtubedl(this.currentUrl, {
                    getTitle: true,
                    noPlaylist: true,
                    ignoreConfig: true,
                    jsRuntimes: 'node',
                    cookies: fs.existsSync(cookiesPath) ? cookiesPath : undefined
                }, { signal: controller.signal });

            const urlPromise = youtubedl(this.currentUrl, ytDlpOptions, { signal: controller.signal });

            const [resolvedTitle, resolvedUrl] = await Promise.all([
                titlePromise.catch((err) => {
                    logger.warn(`yt-dlp title fetch error: ${err.message}`);
                    return 'Live Radio Stream';
                }),
                urlPromise
            ]);

            this.currentTitle = resolvedTitle ? resolvedTitle.trim() : 'Live Radio Stream';
            directUrl = resolvedUrl;
            this.activeExtractionController = null; // Reset once complete
        } catch (err) {
            if (sessionId !== this.streamSessionId) return;
            logger.warn(`yt-dlp error fetching URL: ${err.message}`);
            this._handleProcessClose();
            return;
        }

        if (sessionId !== this.streamSessionId || !this.shouldRetry) {
            logger.info('Aborting process launch: Stream session changed.');
            return;
        }

        this.ffmpegCommand = ffmpeg(directUrl)
            .inputOptions('-re')
            .audioCodec('libmp3lame')
            .audioBitrate('16k')
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
                logger.info('Stream is now online and broadcasting via Node modules.');
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
        if (this.activeExtractionController) {
            try {
                this.activeExtractionController.abort();
            } catch (e) {}
            this.activeExtractionController = null;
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
                res.end();
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
                title: this.currentTitle || 'Live Radio Stream',
                listenerCount: this.listeners.size
            };
        } else {
            return this.cachedStatus;
        }
    }
}

module.exports = new StreamService();
