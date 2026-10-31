import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { Play4uProvider } from '../../providers/custom/play4uProvider';

const routes = async (fastify: FastifyInstance, _options: RegisterOptions) => {
  fastify.get('/', (_, reply) => reply.send({ intro: 'Play4u provider', routes: ['/search', '/info', '/watch'] }));
  fastify.get('/search', async (request: FastifyRequest, reply: FastifyReply) => {
    const { query, page } = request.query as { query?: string; page?: number };
    if (!query) return reply.code(400).send({ error: 'query is required' });
    return reply.send(await Play4uProvider.search(query, page || 1));
  });
  fastify.get('/info', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, type } = request.query as { id?: string; type?: string };
    if (!id) return reply.code(400).send({ error: 'id is required' });
    return reply.send(await Play4uProvider.fetchMediaInfo(id, type || 'movie'));
  });
  fastify.get('/watch', async (request: FastifyRequest, reply: FastifyReply) => {
    const { episodeId, server } = request.query as { episodeId?: string; server?: string };
    if (!episodeId) return reply.code(400).send({ error: 'episodeId is required' });
    const result = await Play4uProvider.fetchSources(episodeId, server || 'play4u');
    if (!result?.sources?.length) return reply.code(404).send({ error: 'Play4u source not found' });
    return reply.send(result);
  });
};

export default routes;
