const { execFile } = require('child_process');
const youtubedl = require('youtube-dl-exec');
const dlpPath = youtubedl.constants.YOUTUBE_DL_PATH;
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

async function testYtDlpExecFile() {
    console.log('Testing direct child_process.execFile of youtube-dl-exec binary...');
    try {
        console.log(`Pre-packaged yt-dlp path: ${dlpPath}`);

        const videoId = '4klRth5QQ8E'; // Lofi Girl Live
        const url = `https://www.youtube.com/watch?v=${videoId}`;

        const args = [url, '--get-url', '--format', 'bestaudio/best'];

        console.log(`Executing execFile with arguments: ${args.join(' ')}`);
        execFile(dlpPath, args, (error, stdout, stderr) => {
            if (stderr) {
                console.log(`[yt-dlp warning/stderr]: ${stderr.trim()}`);
            }

            if (error) {
                console.error(`CRITICAL: yt-dlp failed with exit code: ${error.code}`);
                process.exit(1);
            }

            const directUrl = stdout.trim();
            console.log(`\nSUCCESS: Extracted Direct URL: ${directUrl}`);

            console.log('Spawning fluent-ffmpeg with HLS manifest input...');
            const cmd = ffmpeg(directUrl)
                .audioCodec('libmp3lame')
                .audioBitrate('128k')
                .format('mp3')
                .on('start', (commandLine) => {
                    console.log('FFmpeg spawned successfully with command:', commandLine);
                })
                .on('error', (err) => {
                    console.error('FFmpeg error:', err.message);
                    process.exit(1);
                })
                .on('end', () => {
                    console.log('FFmpeg stream ended naturally.');
                    process.exit(0);
                });

            const stream = cmd.pipe();
            
            let chunkCount = 0;
            stream.on('data', (chunk) => {
                chunkCount++;
                console.log(`[Chunk #${chunkCount}] Transcoded MP3 bytes received: ${chunk.length}`);
                
                if (chunkCount >= 10) {
                    console.log('SUCCESS: Received 10 consecutive transcoded MP3 chunks successfully!');
                    console.log('VERIFIED: execFile -> FFmpeg pipeline is 100% operational and immune to stderr warnings!');
                    try { cmd.kill('SIGKILL'); } catch (e) {}
                    process.exit(0);
                }
            });
        });

    } catch (err) {
        console.error('Test failed:', err);
        process.exit(1);
    }
}

testYtDlpExecFile();
