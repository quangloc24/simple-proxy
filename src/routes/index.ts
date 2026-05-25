import { getBodyBuffer } from '@/utils/body';
import {
  getProxyHeaders,
  getAfterResponseHeaders,
  getBlacklistedHeaders,
} from '@/utils/headers';
import {
  createTokenIfNeeded,
  isAllowedToMakeRequest,
  setTokenHeader,
} from '@/utils/turnstile';

export default defineEventHandler(async (event) => {
  const method = event.node.req.method || 'GET';
  const url = event.node.req.url || '/';
  console.log(`[Request] ${method} ${url}`);

  // Handle preflight CORS requests
  if (isPreflightRequest(event)) {
    handleCors(event, {});
    // Ensure the response ends here for preflight
    event.node.res.statusCode = 204;
    event.node.res.end();
    return;
  }

  // Reject any other OPTIONS requests
  if (event.node.req.method === 'OPTIONS') {
    throw createError({
      statusCode: 405,
      statusMessage: 'Method Not Allowed',
    });
  }

  // Parse destination URL
  let destination = getQuery<{ destination?: string }>(event).destination;
  
  if (!destination) {
    return await sendJson({
      event,
      status: 200,
      data: {
        message: `Proxy is working as expected (v${
          useRuntimeConfig(event).version
        })`,
      },
    });
  }

  // Fallback routing: If the destination contains "/altcha/challenge", route it through the Cloudflare Worker proxy.
  // This avoids VPS datacenter IP blocks from Cloudflare's WAF on the target domain.
  if (destination && (destination.includes('/altcha/challenge') || destination.includes('/altcha/'))) {
    const fallbackProxy = process.env['FALLBACK_PROXY'];
    if (!fallbackProxy) {
      throw createError({
        statusCode: 500,
        statusMessage: 'Configuration Error: FALLBACK_PROXY environment variable is required for Altcha challenge requests.',
      });
    }
    console.log(`[Proxy Fallback] Routing Altcha challenge through Cloudflare proxy: ${fallbackProxy}`);
    destination = `${fallbackProxy}/?destination=${encodeURIComponent(destination)}`;
  }

  // Check if allowed to make the request
  if (!(await isAllowedToMakeRequest(event))) {
    return await sendJson({
      event,
      status: 401,
      data: {
        error: 'Invalid or missing token',
      },
    });
  }

  // Read body and create token if needed
  const body = await getBodyBuffer(event);
  const token = await createTokenIfNeeded(event);

  // If the destination is a SubSource/ZIP subtitle download, fetch it, decompress if needed, and return it directly
  if (destination && (destination.includes("subsource.net") || destination.toLowerCase().includes(".zip"))) {
    try {
      const response = await globalThis.fetch(destination, {
        method: event.node.req.method || "GET",
        headers: getProxyHeaders(event.headers) as HeadersInit,
        body: body as any,
      });

      const contentType = response.headers.get("content-type") || "";
      const buf = await response.arrayBuffer();
      const bytes = new Uint8Array(buf);

      let responseBody: any = bytes;
      let finalContentType = contentType;

      if (bytes.length >= 30 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
        // It's a ZIP archive! Decompress the first file.
        const decompressed = await decompressZipFirstFile(bytes);
        if (decompressed) {
          responseBody = new TextDecoder("utf-8").decode(decompressed);
          finalContentType = "text/plain; charset=utf-8";
        }
      }

      // Copy response headers and apply CORS headers
      const afterHeaders = getAfterResponseHeaders(response.headers, response.url);
      setResponseHeaders(event, {
        ...afterHeaders,
        "content-type": finalContentType,
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "*",
      });

      if (token) setTokenHeader(event, token);

      return responseBody;
    } catch (e) {
      console.error("Special SubSource proxy handling failed:", e);
      // Fallback to normal proxy request below if this fails
    }
  }

  // Proxy the request
  try {
    await specificProxyRequest(event, destination, {
      blacklistedHeaders: getBlacklistedHeaders(),
      fetchOptions: {
        redirect: 'follow',
        headers: getProxyHeaders(event.headers),
        body: body as any,
      },
      onResponse(outputEvent, response) {
        const headers = getAfterResponseHeaders(response.headers, response.url);
        setResponseHeaders(outputEvent, headers);
        if (token) setTokenHeader(event, token);
      },
    });
  } catch (e) {
    console.log('Error fetching', e);
    throw e;
  }
});

async function decompressZipFirstFile(zipBytes: Uint8Array): Promise<Uint8Array | null> {
  if (zipBytes.length < 30) return null;
  if (zipBytes[0] !== 0x50 || zipBytes[1] !== 0x4b || zipBytes[2] !== 0x03 || zipBytes[3] !== 0x04) {
    return null;
  }

  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const compressionMethod = view.getUint16(8, true);
  const compressedSize = view.getUint32(18, true);
  const filenameLen = view.getUint16(26, true);
  const extraFieldLen = view.getUint16(28, true);

  const dataOffset = 30 + filenameLen + extraFieldLen;
  const compressedData = zipBytes.subarray(dataOffset, dataOffset + compressedSize);

  if (compressionMethod === 8) {
    try {
      const decompressedStream = new Response(compressedData as any).body!.pipeThrough(
        new DecompressionStream("deflate-raw")
      );
      const decompressedArrayBuffer = await new Response(decompressedStream).arrayBuffer();
      return new Uint8Array(decompressedArrayBuffer);
    } catch (err) {
      console.error("ZIP decompression failed:", err);
      return null;
    }
  } else if (compressionMethod === 0) {
    return compressedData;
  }

  return null;
}