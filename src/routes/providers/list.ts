import { makeProviders, makeStandardFetcher, targets } from '@/index';

const fetcher = makeStandardFetcher(globalThis.fetch);
const providers = makeProviders({
  fetcher,
  target: targets.ANY,
});

export default defineEventHandler((event) => {
  handleCors(event, {
    origin: '*',
    methods: ['GET'],
  });

  return {
    sources: providers.listSources(),
    embeds: providers.listEmbeds(),
  };
});
