import { makeProviders, makeStandardFetcher, targets } from '@/index';

const fetcher = makeStandardFetcher(globalThis.fetch);
const providers = makeProviders({
  fetcher,
  target: targets.ANY,
});

export default defineEventHandler(async (event) => {
  handleCors(event, {
    origin: '*',
    methods: ['POST', 'OPTIONS'],
    headers: '*',
  });

  if (event.node.req.method === 'OPTIONS') {
    event.node.res.statusCode = 204;
    event.node.res.end();
    return;
  }

  const body = await readBody<{ id: string; url: string }>(event);
  if (!body || !body.id || !body.url) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request: id and url are required',
    });
  }

  try {
    const result = await providers.runEmbedScraper({
      id: body.id,
      url: body.url,
    });
    return result;
  } catch (err: any) {
    console.error(`[ProxyScraper] Error running embed ${body.id}:`, err);
    throw createError({
      statusCode: err.statusCode || 500,
      statusMessage: err.message || 'Scraping failed',
    });
  }
});
