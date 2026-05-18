const { Innertube } = require('youtubei.js');

async function testGetBasicInfo() {
    console.log('Testing Innertube.getBasicInfo() with WEB client...');
    try {
        const client = await Innertube.create();
        const videoId = '4klRth5QQ8E'; // Lofi Girl Live
        
        console.log('Calling client.getBasicInfo()...');
        const info = await client.getBasicInfo(videoId, 'WEB');
        
        console.log('SUCCESS: Basic info retrieved!');
        console.log('Streaming Data present:', !!info.streaming_data);
        
        if (info.streaming_data) {
            console.log('HLS Manifest URL:', info.streaming_data.hls_manifest_url);
            console.log('Formats Count:', info.streaming_data.formats?.length || 0);
            console.log('Adaptive Formats Count:', info.streaming_data.adaptive_formats?.length || 0);
            process.exit(0);
        } else {
            console.log('No streaming data found!');
            process.exit(1);
        }
    } catch (err) {
        console.error('Test failed:', err);
        process.exit(1);
    }
}

testGetBasicInfo();
