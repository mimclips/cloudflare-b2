// Native AWS Signature V4 Signer for Backblaze B2 Private Buckets
// No external imports required - 100% Dashboard Friendly

async function hmac(key, string) {
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
        "raw", typeof key === "string" ? enc.encode(key) : key,
        { name: "HMAC", hash: { name: "SHA-256" } }, false, ["sign"]
    );
    return await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(string));
}

async function getSignatureKey(key, dateStamp, regionName, serviceName) {
    const kDate = await hmac("AWS4" + key, dateStamp);
    const kRegion = await hmac(kDate, regionName);
    const kService = await hmac(kRegion, serviceName);
    return await hmac(kService, "aws4_request");
}

function bufToHex(buffer) {
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export default {
    async fetch(request, env) {
        if (!['GET', 'HEAD'].includes(request.method)) {
            return new Response("Method Not Allowed", { status: 405 });
        }

        const url = new URL(request.url);
        let path = url.pathname.replace(/^\//, '');

        if (!path) {
            return new Response("B2 Proxy Active. Append your filename (e.g., /1.mp4)", { status: 200 });
        }

        // Extract Region from Endpoint (e.g. ://backblazeb2.com -> us-west-004)
        const region = env.B2_ENDPOINT.split('.')[1] || 'us-west-004';
        const host = `${env.BUCKET_NAME}.${env.B2_ENDPOINT}`;
        
        // Setup Date info for SigV4
        const now = new Date();
        const amzDate = now.toISOString().replace(/[:-]/g, "").split(".")[0] + "Z";
        const dateStamp = amzDate.substr(0, 8);

        // Canonical Request Components
        const canonicalUri = '/' + encodeURI(path);
        const canonicalQuery = '';
        const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
        const signedHeaders = 'host;x-amz-date';
        
        // SHA256 of empty string (since GET requests have no body payload)
        const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; 
        
        const canonicalRequest = `GET\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
        const canonicalRequestHash = bufToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest)));

        // String to Sign
        const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
        const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${canonicalRequestHash}`;

        // Generate Signature
        const signingKey = await getSignatureKey(env.B2_APPLICATION_KEY, dateStamp, region, 's3');
        const signature = bufToHex(await hmac(signingKey, stringToSign));

        // Build Final Outbound Headers
        const authHeader = `AWS4-HMAC-SHA256 Credential=${env.B2_APPLICATION_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

        const outboundHeaders = new Headers();
        outboundHeaders.set('Host', host);
        outboundHeaders.set('X-Amz-Date', amzDate);
        outboundHeaders.set('Authorization', authHeader);

        // Pass client Range headers if streaming video
        if (request.headers.has('range')) {
            outboundHeaders.set('Range', request.headers.get('range'));
        }

        const b2Url = `https://${host}/${path}`;

        const b2Response = await fetch(b2Url, {
            method: 'GET',
            headers: outboundHeaders
        });

        if (b2Response.status === 404) {
            return new Response("File not found in your bucket.", { status: 404 });
        }

        // Return streaming file with active range delivery support back to client
        const cleanResponse = new Response(b2Response.body, b2Response);
        cleanResponse.headers.set("Cache-Control", "public, max-age=86400");
        return cleanResponse;
    }
};
