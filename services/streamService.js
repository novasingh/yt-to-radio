const { EventEmitter } = require('events');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const youtubedlModule = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');
const https = require('https');
const logger = require('../utils/logger');

// Lazy-loaded executable builder
let youtubedl = null;

async function getYoutubeDl() {
    if (youtubedl) return youtubedl;

    const customPath = process.env.YT_DLP_PATH;
    if (customPath) {
        logger.info(`Using custom YT_DLP_PATH: ${customPath}`);
        youtubedl = youtubedlModule.create(customPath);
        return youtubedl;
    }

    if (process.platform === 'win32') {
        logger.info('Running on Windows: Utilizing youtube-dl-exec default executable.');
        youtubedl = youtubedlModule;
        return youtubedl;
    }

    // On Linux/Hostinger, check and run standalone compiled self-contained yt-dlp binary (needs 0% Python!)
    const binDir = path.join(__dirname, '../bin');
    const binaryPath = path.join(binDir, 'yt-dlp_linux');

    if (fs.existsSync(binaryPath)) {
        logger.info(`Standalone self-contained yt-dlp binary found at: ${binaryPath}`);
        youtubedl = youtubedlModule.create(binaryPath);
        return youtubedl;
    }

    logger.info('Hostinger Environment: Standalone self-contained Linux yt-dlp binary missing. Initiating automatic download...');
    if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
    }

    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(binaryPath);
        
        function download(url) {
            https.get(url, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    download(response.headers.location);
                    return;
                }
                
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download binary: HTTP ${response.statusCode}`));
                    return;
                }

                response.pipe(file);
                
                file.on('finish', () => {
                    file.close();
                    try {
                        fs.chmodSync(binaryPath, 0o755);
                        logger.info('Standalone Linux yt-dlp binary downloaded and permissions set to 0755 successfully!');
                        resolve();
                    } catch (chmodErr) {
                        reject(new Error(`Failed to set permissions: ${chmodErr.message}`));
                    }
                });
            }).on('error', (err) => {
                fs.unlink(binaryPath, () => {});
                reject(err);
            });
        }

        download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux');
    });

    youtubedl = youtubedlModule.create(binaryPath);
    return youtubedl;
}

// Tell fluent-ffmpeg to use the locally installed static binary
try {
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
} catch (ffmpegErr) {
    logger.error(`Failed to set local FFmpeg path: ${ffmpegErr.message}`);
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
        this.maxBurstSize = 64 * 1024; // 64KB memory cache for instant playback
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
                if (timeSinceLastChunk > 15000) {
                    logger.error('Watchdog: No audio chunks received for 15s. Restarting stream.');
                    this._handleProcessClose();
                }
            }
        }, 5000);
    }

    async _launchProcesses() {
        if (!this.currentUrl) return;

        const sessionId = this.streamSessionId;
        logger.info(`Starting stream extraction for URL: ${this.currentUrl} (session: ${sessionId})`);
        
        let directUrl;
        try {
            // Lazy-load and build our standalone self-contained yt-dlp binary
            const launcher = await getYoutubeDl();

            // Set standard extraction options
            const ytDlpOptions = {
                f: 'bestaudio/best',
                getUrl: true,
                noPlaylist: true,
                geoBypass: true,
                socketTimeout: 15,
                ignoreConfig: true
            };

            const cookiesPath = path.join(__dirname, '../cookies.txt');
            if (fs.existsSync(cookiesPath)) {
                ytDlpOptions.cookies = cookiesPath;
                logger.info('Detected cookies.txt in project root. Applying cookies to standalone yt-dlp.');
            }

            logger.info('Extracting direct media stream URL using standalone yt-dlp...');
            directUrl = await launcher(this.currentUrl, ytDlpOptions);
        } catch (err) {
            if (sessionId !== this.streamSessionId) return;
            logger.warn(`yt-dlp error fetching URL: ${err.message}`);
            this._handleProcessClose();
            return;
        }

        // In case stopStream or startStream was called while we were awaiting the URL
        if (sessionId !== this.streamSessionId || !this.shouldRetry) {
            logger.info('Aborting process launch: Stream session changed.');
            return;
        }

        logger.info('Successfully extracted direct stream URL.');

        // Create fluent-ffmpeg command reading from the direct URL
        this.ffmpegCommand = ffmpeg(directUrl)
            // -re tells ffmpeg to read input at native frame rate. 
            // This is CRITICAL so non-live videos don't finish transcoding in 2 seconds and stop the stream.
            .inputOptions('-re') 
            .audioCodec('libmp3lame')
            .audioBitrate('16k')
            .format('mp3')
            .on('start', (commandLine) => {
                logger.info(`Spawned fluent-ffmpeg`);
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
                logger.info('Stream is now online and broadcasting via Node modules.');
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
        clearInterval(this.watchdogInterval);
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
        
        // Burst on connect: send the last 64KB immediately so browser buffers instantly
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
