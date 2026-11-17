// Shared test helper: a minimal browser for app.request().
export const ORIGIN = 'http://localhost';

/** Minimal browser: keeps cookies and sends the CSRF token of the last page. */
export class Browser {
  cookies = new Map();
  csrf = '';

  constructor(app) {
    this.app = app;
  }

  async request(url, { method = 'GET', form, body, headers = {} } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (this.cookies.size > 0) init.headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET') {
      if (!('origin' in init.headers)) init.headers.origin = ORIGIN;
      if (body !== undefined) {
        init.body = body;
      } else if (form instanceof FormData) {
        if (!form.has('_csrf')) form.set('_csrf', this.csrf);
        init.body = form;
      } else {
        init.body = new URLSearchParams({ _csrf: this.csrf, ...form });
        init.headers['content-type'] = 'application/x-www-form-urlencoded';
      }
    }
    const response = await this.app.request(url, init);
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
      if (value === '' || /max-age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const type = response.headers.get('content-type') ?? '';
    const content = type.includes('text/') ? await response.text() : Buffer.from(await response.arrayBuffer());
    if (typeof content === 'string') {
      const token = /name="_csrf" value="([^"]+)"/.exec(content)?.[1];
      if (token) this.csrf = token;
    }
    return { status: response.status, location: response.headers.get('location'), headers: response.headers, body: content };
  }

  get(url) {
    return this.request(url);
  }

  post(url, form = {}, headers = {}) {
    return this.request(url, { method: 'POST', form, headers });
  }

  async login(username, password, extra = {}) {
    return this.post('/login', { username, password, ...extra });
  }
}

