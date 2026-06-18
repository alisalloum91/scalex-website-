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
      url.pathname = path + '.html';
      return env.ASSETS.fetch(new Request(url.toString(), request));
    }

    return env.ASSETS.fetch(request);
  }
};
