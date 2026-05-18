const { Innertube } = require('youtubei.js');

async function testMultipleClients() {
    const clientsToTest = ['WEB', 'ANDROID', 'TV', 'TV_EMBEDDED', 'YTMUSIC'];
    const videoId = '4klRth5QQ8E'; // Lofi Girl Live

    console.log(`Starting client context robustness test for video ID: ${videoId}...`);

    for (const clientName of clientsToTest) {
        try {
            console.log(`\nTesting client: ${clientName} ...`);
            const client = await Innertube.create();
            const info = await client.getBasicInfo(videoId, clientName);
            
            if (info.streaming_data) {
                console.log(`✅ SUCCESS [${clientName}]: Streaming data retrieved!`);
                console.log(`   HLS Manifest URL present: ${!!info.streaming_data.hls_manifest_url}`);
                console.log(`   Formats: ${info.streaming_data.formats?.length || 0}, Adaptive: ${info.streaming_data.adaptive_formats?.length || 0}`);
            } else {
                console.log(`❌ FAILED [${clientName}]: No streaming data present.`);
            }
        } catch (err) {
            console.log(`❌ ERROR [${clientName}]: ${err.message}`);
        }
    }
}

testMultipleClients();
