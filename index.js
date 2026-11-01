import { AwsClient } from 'aws4fetch'

const UNSIGNABLE_HEADERS = [
    'x-forwarded-proto',
    'x-real-ip',
    'accept-encoding',
    'if-match',
    'if-modified-since',
    'if-none-match',
    'if-range',
    'if-unmodified-since',
];

const RANGE_RETRY_ATTEMPTS = 3;

function filterHeaders(headers) {
    return new Headers(Array.from(headers.entries())
        .filter(pair => !(
            UNSIGNABLE_HEADERS.includes(pair[0]) || pair[0].startsWith('cf-')
        ))
    );
}

export default {
    async fetch(request, env) {
        if (!['GET', 'HEAD'].includes(request.method)){
            return new Response("Method Not Allowed", { status: 405 });
        }

        const url = new URL(request.url);
        let path = url.pathname.replace(/^\//, '').replace(/\/$/, '');

        // Basic check if they hit the naked domain
        if (!path && String(env['ALLOW_LIST_BUCKET']) !== "true") {
            return new Response("B2 Proxy Active. Append your filename (e.g., /1.mp4)", { status: 200 });
        }

        // FIX FOR ERROR 1042: Dynamically build a strict, clean public target URL
        const b2Url = `https://${env['BUCKET_NAME']}.${env['B2_ENDPOINT']}/${path}`;

        const headers = filterHeaders(request.headers);

        const client = new AwsClient({
            "accessKeyId": env['B2_APPLICATION_KEY_ID'],
            "secretAccessKey": env['B2_APPLICATION_KEY'],
            "service": "s3",
        });

        // Generate the clean signed request using the string URL to break the proxy loop
        const signedRequest = await client.sign(b2Url, {
            method: 'GET',
            headers: headers
        });

        // Range handling for streaming video files (.mp4) smoothly
        if (signedRequest.headers.has("range")) {
            let attempts = RANGE_RETRY_ATTEMPTS;
            let response;
            do {
                let controller = new AbortController();
                response = await fetch(signedRequest.url, {
                    method: signedRequest.method,
                    headers: signedRequest.headers,
                    signal: controller.signal,
                });
                if (response.headers.has("content-range")) {
                    break;
                } else if (response.ok) {
                    attempts -= 1;
                    if (attempts > 0) controller.abort();
                } else {
                    break;
                }
            } while (attempts > 0);

            if (request.method === 'HEAD') {
                return new Response(null, { headers: response.headers, status: response.status });
            }
            return response;
        }

        // Standard fetch for non-range files
        const response = await fetch(signedRequest);
        if (response.status === 404) return new Response("File not found in bucket.", { status: 404 });
        
        const cleanResponse = new Response(response.body, response);
        cleanResponse.headers.set("Cache-Control", "public, max-age=86400"); 
        return cleanResponse;
    }
};
