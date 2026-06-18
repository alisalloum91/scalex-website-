export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    const routes = {
      '/services': '/services.html',
      '/contact':  '/contact.html',
    };

    const mapped = routes[path];
    if (mapped) {
      const newUrl = new URL(mapped, url.origin);
      return env.ASSETS.fetch(new Request(newUrl, request));
    }

    return env.ASSETS.fetch(request);
  }
};
