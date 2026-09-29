import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: name => name === 'item' || name === 'category',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
});

const text = v => (v == null ? '' : String(typeof v === 'object' ? v['#text'] ?? '' : v).trim());

export function parseFeed(xml) {
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel;
  if (!channel) throw new Error('parseFeed: not an RSS feed');
  const items = channel.item ?? [];
  return items.map(raw => {
    const link = text(raw.link);
    const enc = raw.enclosure;
    return {
      guid: link,
      title: text(raw.title),
      link,
      creator: text(raw['dc:creator']),
      pubDate: text(raw.pubDate),
      categories: (raw.category ?? []).map(text).filter(Boolean),
      description: text(raw.description),
      contentEncoded: text(raw['content:encoded']),
      enclosure: enc
        ? { url: enc['@_url'] ?? '', type: enc['@_type'] ?? '', length: String(enc['@_length'] ?? '') }
        : null,
    };
  });
}
