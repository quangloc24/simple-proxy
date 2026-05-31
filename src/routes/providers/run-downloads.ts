import { scrapeGearlessJoeDownloads } from '@/index';

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

  const body = await readBody<{ tmdbId: string; type: string; season?: number; episode?: number }>(event);
  if (!body || !body.tmdbId || !body.type) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request: tmdbId and type are required',
    });
  }

  try {
    const result = await scrapeGearlessJoeDownloads({
      tmdbId: body.tmdbId,
      type: body.type as any,
      season: body.season,
      episode: body.episode,
    });
    return result;
  } catch (err: any) {
    console.error(`[ProxyScraper] Error running downloads search:`, err);
    throw createError({
      statusCode: err.statusCode || 500,
      statusMessage: err.message || 'Download resolution failed',
    });
  }
});
