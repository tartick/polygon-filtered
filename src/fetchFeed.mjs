export const FEED_URL = 'https://www.polygon.com/feed/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 polygon-filtered';

export async function fetchFeed({ fetchImpl = fetch, url = FEED_URL, attempts = 4, delayMs = 2000 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      if (!body.includes('<rss')) throw new Error('response is not an RSS feed');
      return body;
    } catch (err) {
      lastErr = err;
      console.error(`fetchFeed attempt ${i}/${attempts} failed: ${err.message}`);
      if (i < attempts && delayMs > 0) await new Promise(r => setTimeout(r, delayMs * i));
    }
  }
  throw new Error(`fetchFeed: giving up: ${lastErr?.message}`);
}
