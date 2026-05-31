import { makeProviders, makeStandardFetcher, targets } from '@/index';

const fetcher = makeStandardFetcher(globalThis.fetch);
const providers = makeProviders({
  fetcher,
  target: targets.ANY,
});

async function getTmdbMetadata(tmdbId: string, type: 'movie' | 'show', season?: string, episode?: string) {
  const token = process.env.VITE_TMDB_READ_API_KEY;
  if (!token) {
    console.error('[TMDB] VITE_TMDB_READ_API_KEY is not configured in .env');
    return null;
  }

  const baseUrl = 'https://api.themoviedb.org/3';
  const mainUrl = `${baseUrl}/${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}`;

  try {
    const res = await globalThis.fetch(mainUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      console.error(`[TMDB] Main query failed with status ${res.status}`);
      return null;
    }

    const mainData = await res.json();
    const title = type === 'movie' ? mainData.title : mainData.name;
    const releaseYear = new Date(type === 'movie' ? mainData.release_date : mainData.first_air_date).getFullYear();

    if (type === 'show' && season && episode) {
      return {
        type: 'show' as const,
        tmdbId,
        title,
        releaseYear,
        season: {
          number: parseInt(season, 10),
          tmdbId: '',
        },
        episode: {
          number: parseInt(episode, 10),
          tmdbId: '',
        },
      };
    }

    return {
      type: 'movie' as const,
      tmdbId,
      title,
      releaseYear,
    };
  } catch (err) {
    console.error('[TMDB] Error querying metadata:', err);
    return null;
  }
}

export default defineEventHandler(async (event) => {
  handleCors(event, {
    origin: '*',
    methods: ['GET', 'OPTIONS'],
    headers: '*',
  });

  if (event.node.req.method === 'OPTIONS') {
    event.node.res.statusCode = 204;
    event.node.res.end();
    return;
  }

  const tmdbId = event.context.params?.id;
  if (!tmdbId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request: tmdbId in path is required',
    });
  }

  const query = getQuery(event);
  const sourceId = query.source as string;
  const season = (query.season || query.s) as string;
  const episode = (query.episode || query.e) as string;

  if (!sourceId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request: source query parameter is required',
    });
  }

  console.log(`[VylaBridge] Testing source "${sourceId}" for TMDB "${tmdbId}" (Season: ${season || 'N/A'}, Episode: ${episode || 'N/A'})...`);

  // Determine media type (if season/episode is passed, it is a show)
  const isShow = !!season && !!episode;
  const mediaType = isShow ? 'show' : 'movie';

  // Fetch metadata from TMDB
  const media = await getTmdbMetadata(tmdbId, mediaType, season, episode);
  if (!media) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch TMDB metadata',
    });
  }

  try {
    const result = await providers.runSourceScraper({
      id: sourceId,
      media,
    });

    if (result && result.stream && result.stream.length > 0) {
      const firstStream = result.stream[0];
      return {
        source: sourceId,
        id: tmdbId,
        ok: true,
        url: firstStream.playlist,
        raw_url: firstStream.playlist,
        stream: firstStream,
        all_streams: result.stream,
        embeds: result.embeds,
        error: null,
      };
    }

    return {
      source: sourceId,
      id: tmdbId,
      ok: false,
      url: null,
      raw_url: null,
      error: 'No playable streams found',
    };
  } catch (err: any) {
    console.error(`[VylaBridge] Error running scraper for ${sourceId}:`, err);
    return {
      source: sourceId,
      id: tmdbId,
      ok: false,
      url: null,
      raw_url: null,
      error: err.message || 'Scraping failed',
    };
  }
});
