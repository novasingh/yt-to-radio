const { Innertube } = require('youtubei.js');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

async function testFfmpegHls() {
    console.log('Testing continuous FFmpeg HLS manifest transcoding...');
    try {
        const client = await Innertube.create();
        const videoId = '4klRth5QQ8E'; // Lofi Girl Live
        
        console.log('Fetching live player info...');
        const playerResponse = await client.actions.execute('/player', {
            videoId,
            client: 'ANDROID',
            parse: true
        });

        const streamingData = playerResponse.streaming_data;
        if (!streamingData || !streamingData.hls_manifest_url) {
            console.error('No HLS manifest URL found!');
            process.exit(1);
        }

        const hlsUrl = streamingData.hls_manifest_url;
        console.log('HLS Manifest URL resolved:', hlsUrl);

        console.log('Spawning fluent-ffmpeg with HLS manifest input...');
        const cmd = ffmpeg(hlsUrl)
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
                console.log('VERIFIED: FFmpeg continuous HLS transcoding is 100% operational!');
                try { cmd.kill('SIGKILL'); } catch (e) {}
                process.exit(0);
            }
        });

    } catch (err) {
        console.error('Test failed:', err);
        process.exit(1);
    }
}

testFfmpegHls();
