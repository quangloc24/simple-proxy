import { makeProviders, makeStandardFetcher, targets } from '@/index';

const fetcher = makeStandardFetcher(globalThis.fetch);
const providers = makeProviders({
  fetcher,
  target: targets.ANY,
});

export default defineEventHandler(async (event) => {
  handleCors(event, {
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    headers: '*',
  });

  if (event.node.req.method === 'OPTIONS') {
    event.node.res.statusCode = 204;
    event.node.res.end();
    return;
  }

  const query = getQuery(event);

  // 1. Handle Vyla sources_meta request
  if (query.sources_meta !== undefined) {
    const sources = providers.listSources().map(s => ({
      key: s.id,
      label: s.name,
      timeout: 15000,
    }));
    return { sources };
  }

  // 2. Handle Vyla general proxy request (e.g. /api?url=...)
  const targetUrl = query.url as string;
  if (targetUrl) {
    try {
      const response = await globalThis.fetch(targetUrl, {
        method: event.node.req.method || 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
        },
      });

      const contentType = response.headers.get('content-type') || '';
      const buf = await response.arrayBuffer();

      setResponseHeaders(event, {
        'content-type': contentType,
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': '*',
      });

      return new Uint8Array(buf);
    } catch (err: any) {
      throw createError({
        statusCode: 502,
        statusMessage: `Proxy error: ${err.message}`,
      });
    }
  }

  return {
    message: 'Welcome to simple-proxy-dev Vyla-style API bridge!',
  };
});
