import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { PROVIDERS_LIST } from '@consumet/extensions';

import hdstream4u from './hdstream4u';
import play4u from './play4u';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  await fastify.register(hdstream4u, { prefix: '/hdstream4u' });
  await fastify.register(play4u, { prefix: '/play4u' });

  fastify.get('/', async (request: any, reply: any) => {
    reply.status(200).send('Welcome to Consumet Movies and TV Shows');
  });

  fastify.get('/:movieProvider', async (request: FastifyRequest, reply: FastifyReply) => {
    const queries: { movieProvider: string; page: number } = {
      movieProvider: '',
      page: 1,
    };

    queries.movieProvider = decodeURIComponent(
      (request.params as { movieProvider: string; page: number }).movieProvider,
    );

    queries.page = (request.query as { movieProvider: string; page: number }).page;

    if (queries.page! < 1) queries.page = 1;

    const provider = PROVIDERS_LIST.MOVIES.find(
      (provider: any) => provider.toString.name === queries.movieProvider,
    );

    try {
      if (provider) {
        reply.redirect(`/movies/${provider.toString.name}`);
      } else {
        reply
          .status(404)
          .send({ message: 'Page not found, please check the providers list.' });
      }
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Please try again later.' });
    }
  });

  // Legacy route support for players calling /movies/:id/:title
  fastify.get('/:id/:title', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, title } = request.params as { id: string; title: string };
    // We assume it's a movie if called on /movies/
    return reply.redirect(`/meta/tmdb/watch?id=${id}&type=movie&provider=hdstream4u`);
  });
};

export default routes;
