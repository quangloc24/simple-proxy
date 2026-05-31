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

  const body = await readBody<{ id: string; media: any }>(event);
  if (!body || !body.id || !body.media) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request: id and media are required',
    });
  }

  try {
    const result = await providers.runSourceScraper({
      id: body.id,
      media: body.media,
    });
    return result;
  } catch (err: any) {
    console.error(`[ProxyScraper] Error running source ${body.id}:`, err);
    throw createError({
      statusCode: err.statusCode || 500,
      statusMessage: err.message || 'Scraping failed',
    });
  }
});
