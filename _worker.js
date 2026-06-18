const PAGES = [
  '/about', '/services', '/digital-marketing', '/social-media',
  '/content', '/performance', '/web-dev', '/seo', '/crm',
  '/automation', '/whatsapp', '/chatbots', '/outdoor',
  '/industries', '/contact'
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (PAGES.includes(path)) {
      const newUrl = new URL(request.url);
      newUrl.pathname = path + '.html';
      return env.ASSETS.fetch(new Request(newUrl.toString(), { method: request.method, headers: request.headers }));
    }

    return env.ASSETS.fetch(request);
  }
};
